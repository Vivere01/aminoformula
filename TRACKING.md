# Conversion Tracking — Setup Guide

Stack: GTM `GTM-TSJ327HZ` (page events) · Digistore24 S2S postback → `/api/digistore-postback` · Google Ads offline conversion `AW-18570108057`.

## Files

| File | Role |
|---|---|
| `tracking.js` | Captures `gclid`/`gbraid`/`wbraid`/UTMs on entry, creates a visitor id, persists it (localStorage + 1st-party cookie, 1 year), encodes it into a Digistore24-safe `cid`, appends `cid` to the 3 checkout links, pushes GTM events. |
| `api/digistore-postback.js` | Vercel serverless route. Decodes `cid`, validates, dedupes by `transaction_id`, sends the conversion to Google Ads. |
| `index.html` | Loads `tracking.js` (defer) and tags each button with `data-offer`. Design untouched. |

## GTM dataLayer events

| Event | When | Parameters |
|---|---|---|
| `page_view` | Page load | `page_location`, `page_title` |
| `vsl_view` | Video iframe ≥50% visible (once) | `video_platform`, `video_id` |
| `offer_click` | Button click | `offer_id` = `1bottle` / `3bottle` / `6bottle`, `offer_label` |

> `offer_click` is a click only. **Purchases never come from the page** — only from the S2S postback.

Create a trigger in GTM for each event name (`Custom Event` trigger) and attach it to your tags.

## Vercel environment variables

Set them in Vercel → Project → Settings → Environment Variables (Production + Preview):

| Variable | Value | Required |
|---|---|---|
| `GOOGLE_ADS_CONVERSION_ID` | `AW-18570108057` | optional — the same value is the code fallback |
| `GOOGLE_ADS_CONVERSION_LABEL` | `G6UgCNuAk74dEJm59ZZF` | optional — the same value is the code fallback |
| `GOOGLE_ADS_CURRENCY` | `USD` (fallback; `{currency}` from Digistore24 wins) | optional |

The env vars **override** the fallbacks, so nothing has to be set for the postback to start converting. Set them only if the conversion action ever changes.

Where the label came from: Google Ads → **Goals → Conversions** → the conversion action created via **Source = "Import" → "Track conversions from clicks"**; its tag shows `send_to: AW-18570108057/G6UgCNuAk74dEJm59ZZF` — `G6UgCNuAk74dEJm59ZZF` is the label.

## Digistore24 postback URL

Affiliate dashboard → **Sales & partners → Integrations → S2S postback**:

```
https://www.confere.sbs/api/digistore-postback?click_id={cid}&revenue={amount_affiliate}&status={transaction_type}&transaction_id={transaction_id}&currency={currency}&is_test={is_test}&allow_test=1
```

`{cid}` is returned automatically because every checkout link carries `cid=…`.

> **`&allow_test=1` is a temporary validation switch.** Digistore24 flags its own test orders with `is_test`, which the route skips on purpose (a test purchase must never count as a sale). Keep `allow_test=1` while you validate, then **remove it from the URL and re-save** in Digistore24.

## Postback behaviour (verified by 22 unit tests + local HTTP e2e)

| Input | Result |
|---|---|
| `status = payment`, valid `cid` with gclid | `conversion_sent` → Google Ads |
| duplicate `transaction_id` | `skipped_duplicate` (in-instance guard + `oid` on Google's side) |
| `status = refund` / `chargeback` | `skipped_refund` / `skipped_chargeback` — never counted as a sale |
| `is_test = 1` | `skipped_test_transaction` (unless `allow_test=1`, then it converts) |
| other statuses (rebill, …) | `skipped_status_*` |
| `cid` with no click id (direct visit) | `recorded_only_no_click_id` — can't attribute to an ad click |
| env vars unset | falls back to `AW-18570108057` / `G6UgCNuAk74dEJm59ZZF` |
| missing `click_id` or `status` | HTTP `400` with the reason |
| `dry_run=1` | returns the exact `google_url` without calling Google |

Always HTTP `200` on valid input so Digistore24 never retry-loops; details are in the JSON body.

**Refund reversal** (subtracting a refunded conversion) needs the Google Ads API / Data Manager adjustment upload — out of scope for the pixel-based approach.

## The `cid` payload

`base64url(JSON)`, ~200 chars (Digistore24 limit: 1000, charset `A-Za-z0-9._-,`):

```json
{ "v": "visitor-id", "g": "gclid", "b": "gbraid", "w": "wbraid",
  "t": "first-touch ISO date",
  "u": { "utm_source": "...", "utm_medium": "...", "utm_campaign": "..." } }
```

Click ids: last click wins. UTMs: first touch is kept. UTM block is dropped automatically if the `cid` ever exceeds the limit.

## Test procedure (production)

1. **Local chain** — already covered by `25` unit tests + HTTP e2e (payment, duplicate, refund, chargeback, test order, missing params, comma decimals, POST body).
2. **Production route** — `GET /api/digistore-postback?...&dry_run=1` returns HTTP 200 with the exact `google_url` that would be sent (ID `18570108057`, label `G6UgCNuAk74dEJm59ZZF`, `value`, `currency_code`, `gclid`, `oid`).
3. **Production page** — open `https://www.confere.sbs/?gclid=<real-gclid>`: all 3 links carry a `cid` (~200 chars), `dataLayer` gets `page_view`, `vsl_view` and `offer_click`, `tracking.js` returns 200, no console errors.
4. **End-to-end** — with `&allow_test=1` in the Digistore24 postback URL, run a Digistore24 test purchase while visiting the page through a real Google Ads click (so a real `gclid` is captured). The postback arrives → `conversion_sent` → check **Google Ads → Tools → Conversions → "View recent conversions"** for the hit with the right value.
5. **GTM Preview** — confirm `page_view`, `vsl_view`, `offer_click` fire on the triggers you created.
6. **After validation** — remove `&allow_test=1` from the Digistore24 postback URL and re-save.
