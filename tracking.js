/*
 * Amino Formula — Attribution & GTM events
 * - Captures gclid / gbraid / wbraid / UTMs on entry
 * - Persists them (localStorage + first-party cookie)
 * - Generates a unique visitor id (vid)
 * - Encodes attribution into a Digistore24-safe `cid` (base64url, <1000 chars)
 * - Appends `cid` to the 3 checkout links
 * - Pushes GTM dataLayer events (never marks a purchase)
 */
(function () {
  "use strict";

  var ATTR_KEY = "amino_attr_v1";
  var COOKIE_NAME = "amino_attr_v1";
  var MAX_CID = 950; // Digistore24 limit is 1000 chars
  var UTM_KEYS = ["utm_source", "utm_medium", "utm_campaign", "utm_term", "utm_content"];
  var CLICK_KEYS = ["gclid", "gbraid", "wbraid"];

  /* ---------- dataLayer (GTM) ---------- */
  window.dataLayer = window.dataLayer || [];
  function dl(event, params) {
    var payload = params || {};
    payload.event = event;
    window.dataLayer.push(payload);
  }

  /* ---------- base64url (charset safe for Digistore24) ---------- */
  function b64urlEncode(str) {
    // btoa handles latin1; UTMs/gclid are ASCII-safe after encodeURIComponent
    var b64 = btoa(unescape(encodeURIComponent(str)));
    return b64.replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
  }
  function b64urlDecode(str) {
    var s = str.replace(/-/g, "+").replace(/_/g, "/");
    while (s.length % 4) s += "=";
    return decodeURIComponent(escape(atob(s)));
  }

  /* ---------- read / write persisted attribution ---------- */
  function readStored() {
    var out = {};
    try {
      var raw = localStorage.getItem(ATTR_KEY);
      if (raw) out = JSON.parse(raw) || {};
    } catch (e) {}
    if (!out || typeof out !== "object") out = {};
    // cookie fallback (localStorage may be blocked)
    if (!out.gclid && !out.gbraid && !out.wbraid) {
      try {
        var m = document.cookie.match(new RegExp("(?:^|; )" + COOKIE_NAME + "=([^;]*)"));
        if (m) {
          var fromCookie = JSON.parse(decodeURIComponent(m[1]));
          if (fromCookie && typeof fromCookie === "object") out = fromCookie;
        }
      } catch (e) {}
    }
    return out;
  }

  function persist(attr) {
    var json = JSON.stringify(attr);
    try {
      localStorage.setItem(ATTR_KEY, json);
    } catch (e) {}
    try {
      // 1st-party cookie, 1 year, same-site lax
      document.cookie =
        COOKIE_NAME + "=" + encodeURIComponent(json) +
        "; path=/; max-age=31536000; SameSite=Lax";
    } catch (e) {}
  }

  /* ---------- capture on entry ---------- */
  function capture() {
    var params;
    try {
      params = new URLSearchParams(window.location.search);
    } catch (e) {
      params = { get: function () { return null; } };
    }

    var attr = readStored();
    var changed = false;

    // Click identifiers: last click wins (correct for conversion attribution)
    CLICK_KEYS.forEach(function (k) {
      var v = params.get(k);
      if (v) {
        attr[k] = v;
        changed = true;
      }
    });

    // UTMs: first-touch kept, filled when missing
    UTM_KEYS.forEach(function (k) {
      var v = params.get(k);
      if (v && !attr[k]) {
        attr[k] = v;
        changed = true;
      }
    });

    // Unique visitor id
    if (!attr.vid) {
      attr.vid =
        "v" + Date.now().toString(36) +
        Math.random().toString(36).slice(2, 10);
      changed = true;
    }
    if (!attr.first_seen) {
      attr.first_seen = new Date().toISOString();
      changed = true;
    }
    attr.last_seen = new Date().toISOString();

    persist(attr);
    return attr;
  }

  /* ---------- encode attribution into Digistore24 cid ---------- */
  function buildCid(attr) {
    // Priority payload: click ids + vid first (needed for Google Ads), UTMs after
    var core = { v: attr.vid };
    if (attr.gclid) core.g = attr.gclid;
    if (attr.gbraid) core.b = attr.gbraid;
    if (attr.wbraid) core.w = attr.wbraid;
    if (attr.first_seen) core.t = attr.first_seen;

    var utm = {};
    UTM_KEYS.forEach(function (k) {
      if (attr[k]) utm[k] = String(attr[k]).slice(0, 60);
    });
    if (Object.keys(utm).length) core.u = utm;

    var cid = b64urlEncode(JSON.stringify(core));

    // Safety: shrink UTMs first if over Digistore24's 1000-char limit
    if (cid.length > MAX_CID && core.u) {
      delete core.u;
      cid = b64urlEncode(JSON.stringify(core));
    }
    return cid;
  }

  /* ---------- wire checkout links ---------- */
  function appendCid(cid) {
    var links = document.querySelectorAll('a[href*="digistore24.com"]');
    Array.prototype.forEach.call(links, function (a) {
      try {
        var url = new URL(a.href);
        if (!url.searchParams.get("cid")) {
          url.searchParams.set("cid", cid);
          a.href = url.toString();
        }
      } catch (e) {}
    });
  }

  /* ---------- GTM events ---------- */
  function trackPageView() {
    dl("page_view", {
      page_location: window.location.href,
      page_title: document.title
    });
  }

  function trackVslView() {
    var player = document.querySelector(
      ".video-wrap vturb-smartplayer, .video-wrap .vturb-player-placeholder, .video-wrap iframe"
    );
    if (!player) return;
    var fired = false;
    function fire() {
      if (fired) return;
      fired = true;
      window.removeEventListener("scroll", check);
      window.removeEventListener("resize", check);
      dl("vsl_view", {
        video_platform: "vturb",
        video_id: "6b0592741cb3c104e5e6368a"
      });
    }
    // Geometry check — IntersectionObserver can be throttled/unreliable in
    // background or embedded browsing contexts, so measure the box directly.
    function visibleEnough() {
      var r = player.getBoundingClientRect();
      if (r.height <= 0 || r.width <= 0) return false;
      var vh = window.innerHeight || document.documentElement.clientHeight;
      var vw = window.innerWidth || document.documentElement.clientWidth;
      var visH = Math.min(r.bottom, vh) - Math.max(r.top, 0);
      var visW = Math.min(r.right, vw) - Math.max(r.left, 0);
      return visH / r.height >= 0.5 && visW / r.width >= 0.5;
    }
    function check() {
      if (visibleEnough()) fire();
    }
    check();
    window.addEventListener("scroll", check, { passive: true });
    window.addEventListener("resize", check);
    setTimeout(check, 1000);
    setTimeout(check, 3000);
    if ("IntersectionObserver" in window) {
      var io = new IntersectionObserver(
        function (entries) {
          entries.forEach(function (en) {
            if (en.isIntersecting) {
              fire();
              io.disconnect();
            }
          });
        },
        { threshold: 0.5 }
      );
      io.observe(player);
    }
  }

  function trackOfferClicks() {
    // Buttons are tagged data-offer="1bottle" | "3bottle" | "6bottle"
    var links = document.querySelectorAll("a.btn-buy[data-offer]");
    Array.prototype.forEach.call(links, function (a) {
      a.addEventListener("click", function () {
        // Click ONLY — never a purchase event
        dl("offer_click", {
          offer_id: a.getAttribute("data-offer"),
          offer_label: a.textContent.trim()
        });
      });
    });
  }

  /* ---------- boot ---------- */
  function init() {
    var attr = capture();
    appendCid(buildCid(attr));
    trackPageView();
    trackVslView();
    trackOfferClicks();
  }

  if (document.readyState === "loading") {
    document.addEventListener("DOMContentLoaded", init);
  } else {
    init();
  }
})();
