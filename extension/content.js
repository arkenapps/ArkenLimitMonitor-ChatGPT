(function () {
  "use strict";

  const BRAND = "Arken Limit Monitor";
  // Compact title shown in the widget header only. The full brand name is still
  // used for notifications, the About panel and debug output.
  const HEADER_TITLE = "Arken Limit Mon- Chat-GPT";
  const VERSION = "1.1.0";
  const BMC_URL = "https://buymeacoffee.com/arkenstone";
  const DONATE_URL = "https://arkenapps.com/arken-limit-monitor.html#donate";
  const MIN_POLL = 120;
  const CONSENT_VERSION = 1;
  const USAGE_PATHS = ["/backend-api/wham/usage", "/backend-api/codex/usage"];
  const RESET_CREDIT_PATH = "/backend-api/codex/rate-limit-reset-credits";
  const SESSION_PATH = "/api/auth/session";
  const SAFE_PATHS = new Set([...USAGE_PATHS, RESET_CREDIT_PATH]);
  const DEV_FIXTURE = false;
  const DEFAULTS = {
    pollSec: 120,
    threshold: 90,
    collapsed: false,
    hidden: false,
    pos: null,
    showCredits: true,
    osNotifications: true,
    consentVersion: 0
  };
  const COLOR = { normal: "#10a37f", warning: "#f0a03c", critical: "#ef4444" };
  const Parser = globalThis.ArkenUsageParser;

  let cfg = { ...DEFAULTS };
  let notified = {};
  let apiPath = "";
  let currentUsage = null;
  let lastSuccessAt = 0;
  let lastAttemptAt = 0;
  let resetDetailsProbedAt = 0;
  let timers = { poll: null, tick: null };
  let el = {};
  let spaObserver = null;
  let domSyncTimer = null;

  let stopped = false;

  // True while this content script can still talk to the extension. After the
  // extension is reloaded, updated or removed, chrome.runtime.id disappears and
  // every chrome.* call throws "Extension context invalidated".
  function extensionAlive() {
    try {
      return !stopped && !!(chrome.runtime && chrome.runtime.id);
    } catch (_) {
      return false;
    }
  }

  // Detach cleanly instead of throwing on every timer tick.
  function shutdown() {
    if (stopped) return;
    stopped = true;
    clearInterval(timers.poll);
    clearInterval(timers.tick);
    clearTimeout(domSyncTimer);
    if (spaObserver) {
      try { spaObserver.disconnect(); } catch (_) {}
      spaObserver = null;
    }
    window.removeEventListener("resize", clampPos);
    if (el.card) el.card.classList.add("stale");
    if (el.sync) el.sync.textContent = "reload this page to reconnect";
  }

  function storageGet(keys) {
    return new Promise((resolve) => {
      if (!extensionAlive()) return resolve({});
      try {
        chrome.storage.local.get(keys, (data) => {
          void chrome.runtime.lastError;
          resolve(data || {});
        });
      } catch (_) {
        shutdown();
        resolve({});
      }
    });
  }

  function storageSet(value) {
    return new Promise((resolve) => {
      if (!extensionAlive()) return resolve(false);
      try {
        chrome.storage.local.set(value, () => {
          void chrome.runtime.lastError;
          resolve(true);
        });
      } catch (_) {
        shutdown();
        resolve(false);
      }
    });
  }

  function storageClear() {
    return new Promise((resolve) => {
      if (!extensionAlive()) return resolve(false);
      try {
        chrome.storage.local.clear(() => {
          void chrome.runtime.lastError;
          resolve(true);
        });
      } catch (_) {
        shutdown();
        resolve(false);
      }
    });
  }

  function sendMessage(message) {
    if (!extensionAlive()) return;
    try {
      const result = chrome.runtime.sendMessage(message);
      if (result && typeof result.catch === "function") result.catch(() => {});
    } catch (_) {
      shutdown();
    }
  }

  const hasConsent = () => cfg.consentVersion === CONSENT_VERSION;

  async function load() {
    const data = await storageGet(["cfg", "notified", "apiPath", "lastUsage", "lastAt"]);
    if (data.cfg) cfg = { ...DEFAULTS, ...data.cfg };
    cfg.pollSec = Math.max(MIN_POLL, Number(cfg.pollSec) || MIN_POLL);
    if (cfg.pos && cfg.pos.v !== 2) cfg.pos = null;
    notified = data.notified && typeof data.notified === "object" ? data.notified : {};
    apiPath = USAGE_PATHS.includes(data.apiPath) ? data.apiPath : "";
    currentUsage = validNormalizedUsage(data.lastUsage) ? data.lastUsage : null;
    lastSuccessAt = Number(data.lastAt) || 0;
  }

  const saveCfg = () => storageSet({ cfg });
  const saveNotified = () => storageSet({ notified });

  function validNormalizedUsage(value) {
    return !!value && value.source === "chatgpt" && Array.isArray(value.limits) && Array.isArray(value.additionalLimits);
  }

  class UsageError extends Error {
    constructor(message, status, path) {
      super(message);
      this.name = "UsageError";
      this.status = status || 0;
      this.path = path || "";
    }
  }

  async function getEphemeralAuth() {
    let response;
    try {
      response = await fetch(SESSION_PATH, {
        method: "GET",
        credentials: "include",
        headers: { accept: "application/json" }
      });
    } catch (_) {
      throw new UsageError("Session unavailable", 0, SESSION_PATH);
    }
    if (!response.ok) throw new UsageError(`Session HTTP ${response.status}`, response.status, SESSION_PATH);
    let session;
    try {
      session = await response.json();
    } catch (_) {
      throw new UsageError("Invalid session response", response.status, SESSION_PATH);
    }
    const accessToken = session && (session.accessToken || session.access_token);
    if (typeof accessToken !== "string" || accessToken.length < 20) throw new UsageError("Session access token unavailable", 401, SESSION_PATH);
    const account = session && session.account;
    const accountId = account && (account.id || account.account_id || account.accountId) || session.accountId || session.account_id || null;
    return { accessToken, accountId: typeof accountId === "string" ? accountId : null };
  }

  async function safeFetchJson(path, auth) {
    if (!SAFE_PATHS.has(path)) throw new UsageError("Blocked non-approved endpoint", 0, path);
    const headers = { accept: "application/json" };
    if (auth && auth.accessToken) headers.authorization = `Bearer ${auth.accessToken}`;
    if (auth && auth.accountId) headers["chatgpt-account-id"] = auth.accountId;
    let response;
    try {
      response = await fetch(path, {
        method: "GET",
        credentials: "include",
        headers
      });
    } catch (_) {
      throw new UsageError("Network failure", 0, path);
    }
    if (!response.ok) throw new UsageError(`HTTP ${response.status}`, response.status, path);
    try {
      return await response.json();
    } catch (_) {
      throw new UsageError("Invalid usage response", response.status, path);
    }
  }

  async function fetchUsage() {
    if (DEV_FIXTURE) throw new UsageError("Development fixture must remain disabled in production");
    let auth = null;
    try {
      auth = await getEphemeralAuth();
    } catch (error) {
      if (error.status === 401) throw error;
    }
    const paths = [...new Set([apiPath, ...USAGE_PATHS].filter(Boolean))];
    let lastError = null;
    for (const path of paths) {
      try {
        const raw = await safeFetchJson(path, auth);
        const usage = Parser.normalizeUsageResponse(raw);
        if (!validNormalizedUsage(usage)) throw new UsageError("Unsupported usage response", 0, path);
        if (apiPath !== path) {
          apiPath = path;
          await storageSet({ apiPath });
        }
        return { usage, auth };
      } catch (error) {
        lastError = error;
        if ([401, 403, 429].includes(error.status)) throw error;
        if (error.status && ![404, 405, 410].includes(error.status) && error.status < 500) throw error;
      }
    }
    throw lastError || new UsageError("Usage endpoint unavailable");
  }

  async function addOptionalResetDetails(usage, auth) {
    if (!usage || !usage.resetCredits || usage.resetCredits.availableCount < 1) return usage;
    if (usage.resetCredits.credits && usage.resetCredits.credits.length) return usage;
    if (Date.now() - resetDetailsProbedAt < 3600000) return usage;
    resetDetailsProbedAt = Date.now();
    try {
      const raw = await safeFetchJson(RESET_CREDIT_PATH, auth);
      const normalized = Parser.normalizeResetCredits({ rate_limit_reset_credits: raw });
      if (normalized.availableCount || normalized.credits.length) usage.resetCredits = normalized;
    } catch (_) {
      // Optional endpoint failure never affects the main meter.
    }
    return usage;
  }

  function errorText(error, hasCache) {
    const suffix = hasCache ? " · showing last update" : "";
    if (!error || !error.status) return "Offline" + suffix;
    if (error.status === 401) return "ChatGPT session unavailable" + suffix;
    if (error.status === 403) return "Usage data unavailable" + suffix;
    if (error.status === 429) return "Temporarily rate limited" + suffix;
    if (error.status >= 500) return "ChatGPT usage service unavailable" + suffix;
    if ([404, 405, 410].includes(error.status)) return "Usage endpoint changed" + suffix;
    return "Usage data unavailable" + suffix;
  }

  function remainingTone(percent) {
    return percent <= 10 ? "critical" : percent <= 30 ? "warning" : "normal";
  }

  function formatPercent(value) {
    if (!Number.isFinite(value)) return "—";
    return `${Math.round(value * 10) / 10}%`;
  }

  function countdown(resetAt) {
    const time = Number(resetAt);
    if (!Number.isFinite(time)) return "";
    let seconds = Math.floor((time - Date.now()) / 1000);
    if (seconds <= 0) return "resets now";
    const days = Math.floor(seconds / 86400);
    seconds -= days * 86400;
    const hours = Math.floor(seconds / 3600);
    seconds -= hours * 3600;
    const minutes = Math.floor(seconds / 60);
    if (days > 0) return `resets in ${days}d ${hours}h`;
    if (hours > 0) return `resets in ${hours}h ${minutes}m`;
    return `resets in ${minutes}m`;
  }

  function formatDate(timestamp) {
    const time = Number(timestamp);
    if (!Number.isFinite(time)) return "";
    return new Date(time).toLocaleDateString(undefined, { day: "numeric", month: "short", year: "numeric" });
  }

  function money(value) {
    return "$" + Number(value).toFixed(2);
  }

  function ringMarkup(strokeWidth) {
    const radius = 50 - strokeWidth / 2 - 1;
    const circumference = 2 * Math.PI * radius;
    return `<svg class="cuw-ring" viewBox="0 0 100 100" aria-hidden="true">
      <circle class="cuw-ring-tr" cx="50" cy="50" r="${radius}" fill="none" stroke-width="${strokeWidth}"/>
      <circle class="cuw-ring-pg" cx="50" cy="50" r="${radius}" fill="none" stroke-width="${strokeWidth}"
        stroke-linecap="round" transform="rotate(-90 50 50)"
        stroke-dasharray="${circumference}" stroke-dashoffset="${circumference}"/>
    </svg>`;
  }

  function setRing(container, remainingPercent) {
    const progress = container && container.querySelector(".cuw-ring-pg");
    if (!progress) return;
    const radius = progress.r.baseVal.value;
    const circumference = 2 * Math.PI * radius;
    const percent = Number.isFinite(remainingPercent) ? Math.max(0, Math.min(100, remainingPercent)) : 0;
    progress.style.strokeDasharray = circumference;
    progress.style.strokeDashoffset = circumference * (1 - percent / 100);
    progress.style.stroke = COLOR[remainingTone(percent)];
  }

  const q = (selector) => (el.root ? el.root.querySelector(selector) : null);
  const LOGO = `<svg viewBox="0 0 24 24" width="18" height="18" aria-hidden="true">
    <defs><linearGradient id="cuwArc" x1="0" y1="0" x2="1" y2="1">
      <stop offset="0" stop-color="#0d8f72"/><stop offset="1" stop-color="#19c37d"/></linearGradient></defs>
    <circle cx="12" cy="12" r="8" fill="none" stroke="#4b4b4b" stroke-width="2.6"/>
    <circle cx="12" cy="12" r="8" fill="none" stroke="url(#cuwArc)" stroke-width="2.6"
      stroke-linecap="round" stroke-dasharray="39.2 50.3" transform="rotate(-90 12 12)"/>
    <circle cx="12" cy="12" r="2.4" fill="#19c37d"/></svg>`;
  const CUP = `<svg viewBox="0 0 24 24" width="12" height="12" aria-hidden="true" fill="none"
      stroke="currentColor" stroke-width="1.9" stroke-linecap="round" stroke-linejoin="round">
    <path d="M4 8h12v6a5 5 0 0 1-5 5H9a5 5 0 0 1-5-5V8z"/>
    <path d="M16 9h2.2a2.8 2.8 0 0 1 0 5.6H16"/>
    <path d="M7 2.5v2M10.5 2.5v2M14 2.5v2"/></svg>`;

  function build() {
    const existing = document.getElementById("cuw-root");
    if (existing) {
      el.root = existing;
      return false;
    }
    const root = document.createElement("div");
    root.id = "cuw-root";
    root.innerHTML = `
      <div id="cuw-card">
        <div id="cuw-head">
          <div id="cuw-head-top"><span id="cuw-logo">${LOGO}</span><span id="cuw-name" title="${BRAND} — Usage Meter for ChatGPT (unofficial)">${HEADER_TITLE}</span></div>
          <div id="cuw-head-bot">
            <span id="cuw-tag">Unofficial · ChatGPT</span><span class="cuw-sp"></span>
            <button id="cuw-refresh" title="Refresh now" aria-label="Refresh now">↻</button>
            <button id="cuw-info" title="About" aria-label="About">ⓘ</button>
            <button id="cuw-gear" title="Settings" aria-label="Settings">⚙</button>
            <button id="cuw-min" title="Collapse" aria-label="Collapse">–</button>
          </div>
        </div>
        <div id="cuw-consent" hidden>
          <div class="cuw-consent-badge">Privacy-first setup</div>
          <div class="cuw-consent-title">Allow automatic usage monitoring?</div>
          <p>Arken Limit Monitor reads a short-lived ChatGPT access token and current account ID into memory only to request your usage limits from ChatGPT.</p>
          <p>Credentials are never stored, logged, exported, or sent to ArkenApps. Normalized usage percentages, reset times, optional credit balance, settings, and notification state are stored locally in this browser.</p>
          <button id="cuw-consent-allow">Allow automatic monitoring</button>
          <button id="cuw-consent-later" class="cuw-ghost">Not now</button>
          <button id="cuw-consent-privacy" class="cuw-link-btn">Read privacy policy</button>
        </div>
        <div id="cuw-monitor">
        <div id="cuw-hero"><div id="cuw-hero-ring"></div></div>
        <div id="cuw-hero-meta"><div id="cuw-hero-label">Loading usage…</div><div id="cuw-hero-reset" data-reset=""></div></div>
        <div id="cuw-list"></div>
        <div id="cuw-additional" class="cuw-section" hidden><div class="cuw-sec-title">Additional limits</div><div id="cuw-additional-rows"></div></div>
        <div id="cuw-resets" class="cuw-section" hidden><div class="cuw-sec-title">Usage resets</div><div id="cuw-reset-rows"></div></div>
        <div id="cuw-credits" class="cuw-section" hidden><div class="cuw-sec-title">Credits</div><div id="cuw-credit-rows"></div></div>
        <div id="cuw-spend" class="cuw-section" hidden><div class="cuw-sec-title">Spend control</div><div id="cuw-spend-rows"></div></div>
        <div id="cuw-foot"><span id="cuw-sync">…</span><a id="cuw-donate-btn" href="#" target="_blank" rel="noopener noreferrer" title="Support Arken Limit Monitor">${CUP}<span>Donate</span></a></div>
        <div id="cuw-settings" hidden>
          <label>Refresh every <input id="cuw-poll" type="number" min="2" step="1"> min</label>
          <label>Alert when usage reaches <input id="cuw-thr" type="number" min="1" max="100"> %</label>
          <label class="cuw-row-switch">Show credits<span class="cuw-sw"><span class="cuw-sw-state" id="cuw-credits-state">Off</span><input id="cuw-credits-on" type="checkbox"><span class="cuw-sw-track"><span class="cuw-sw-knob"></span></span></span></label>
          <label class="cuw-row-switch">OS notifications<span class="cuw-sw"><span class="cuw-sw-state" id="cuw-notify-state">Off</span><input id="cuw-notify-on" type="checkbox"><span class="cuw-sw-track"><span class="cuw-sw-knob"></span></span></span></label>
          <button id="cuw-save">Save settings</button>
          <button id="cuw-dock" class="cuw-ghost">Dock to bottom right</button>
          <button id="cuw-debug" class="cuw-ghost">Copy debug info (redacted)</button>
          <button id="cuw-delete-data" class="cuw-danger">Stop monitoring &amp; delete local data</button>
        </div>
        <div id="cuw-about" hidden>
          <div class="cuw-about-name">${BRAND}</div>
          <p class="cuw-warn">Unofficial. Not affiliated with, endorsed by, or sponsored by OpenAI. ChatGPT and Codex names are used only to describe compatibility.</p>
          <p>Runs locally in your browser. It reads a short-lived ChatGPT session access token into memory only, uses it solely for approved read-only usage requests, and never stores, logs, exports, or transmits that token elsewhere. It does not read conversations or send usage data to ArkenApps or any third party.</p>
          <p>These limits can relate to Codex or other usage shown on ChatGPT’s Usage page. They are not necessarily ordinary ChatGPT conversation-message limits.</p>
          <p>Experimental: ChatGPT’s internal usage endpoints may change, which can temporarily affect the extension until it is updated.</p>
          <div class="cuw-links"><button id="cuw-about-privacy" class="cuw-link-btn">Privacy policy</button><a id="cuw-bmc" href="#" target="_blank" rel="noopener noreferrer">Buy me a coffee</a><a id="cuw-donate" href="#" target="_blank" rel="noopener noreferrer">More ways to donate</a></div>
        </div>
        </div>
      </div>
      <div id="cuw-pill" title="ChatGPT usage remaining · drag to move" hidden>
        <span class="cuw-pill-title"><span class="cuw-pill-brand">ChatGPT</span><span>usage</span><span>remaining</span></span>
        <div class="cuw-pgrp"><span class="cuw-pring" id="cuw-pill-ring-s"></span><span class="cuw-pmeta"><span class="cuw-plabel" id="cuw-pill-label-s">Usage</span><span class="cuw-pval" id="cuw-pill-s">—</span></span></div>
        <span class="cuw-pdiv"></span>
        <div class="cuw-pgrp" id="cuw-pill-secondary"><span class="cuw-pring" id="cuw-pill-ring-w"></span><span class="cuw-pmeta"><span class="cuw-plabel" id="cuw-pill-label-w">Weekly</span><span class="cuw-pval" id="cuw-pill-w">—</span></span></div>
      </div>`;
    (document.body || document.documentElement).appendChild(root);
    el.root = root;
    Object.assign(el, {
      card: q("#cuw-card"), consent: q("#cuw-consent"), monitor: q("#cuw-monitor"), hero: q("#cuw-hero-ring"), heroLabel: q("#cuw-hero-label"), heroReset: q("#cuw-hero-reset"),
      list: q("#cuw-list"), additional: q("#cuw-additional"), additionalRows: q("#cuw-additional-rows"),
      resets: q("#cuw-resets"), resetRows: q("#cuw-reset-rows"), credits: q("#cuw-credits"), creditRows: q("#cuw-credit-rows"),
      spend: q("#cuw-spend"), spendRows: q("#cuw-spend-rows"), sync: q("#cuw-sync"), settings: q("#cuw-settings"), about: q("#cuw-about"),
      pill: q("#cuw-pill"), pillS: q("#cuw-pill-s"), pillW: q("#cuw-pill-w"), pillRingS: q("#cuw-pill-ring-s"), pillRingW: q("#cuw-pill-ring-w")
    });
    el.hero.innerHTML = ringMarkup(8) + '<div class="cuw-hero-center"><span class="cuw-hero-pct">—</span><span class="cuw-hero-sub">remaining</span></div>';
    el.pillRingS.innerHTML = ringMarkup(14);
    el.pillRingW.innerHTML = ringMarkup(14);
    q("#cuw-refresh").onclick = () => refresh(true);
    q("#cuw-gear").onclick = () => panel("settings");
    q("#cuw-info").onclick = () => panel("about");
    q("#cuw-min").onclick = () => setCollapsed(true);
    q("#cuw-save").onclick = saveSettings;
    q("#cuw-dock").onclick = dockDefault;
    q("#cuw-debug").onclick = copyDebug;
    q("#cuw-delete-data").onclick = withdrawConsent;
    q("#cuw-consent-allow").onclick = acceptConsent;
    q("#cuw-consent-later").onclick = declineConsent;
    q("#cuw-consent-privacy").onclick = openPrivacy;
    q("#cuw-about-privacy").onclick = openPrivacy;
    q("#cuw-bmc").href = BMC_URL;
    q("#cuw-donate").href = DONATE_URL;
    q("#cuw-donate-btn").href = BMC_URL;
    q("#cuw-poll").value = Math.round(cfg.pollSec / 60);
    q("#cuw-thr").value = cfg.threshold;
    q("#cuw-credits-on").checked = cfg.showCredits !== false;
    q("#cuw-notify-on").checked = cfg.osNotifications !== false;
    SWITCHES.forEach(([box, state]) => {
      const input = q(box);
      if (input) input.addEventListener("change", () => syncSwitch(box, state));
    });
    syncSwitches();
    attachDrag(q("#cuw-head"));
    attachDrag(el.pill, () => setCollapsed(false));
    if (hasConsent()) setCollapsed(cfg.collapsed, true);
    else showConsent();
    el.root.hidden = cfg.hidden === true;
    applyPos();
    window.addEventListener("resize", clampPos);
    return true;
  }

  function panel(which) {
    const settings = which === "settings";
    el.settings.hidden = settings ? !el.settings.hidden : true;
    el.about.hidden = settings ? true : !el.about.hidden;
    requestAnimationFrame(clampPos);
  }

  function openPrivacy() {
    sendMessage({ type: "openPrivacy" });
  }

  function showConsent() {
    el.consent.hidden = false;
    el.monitor.hidden = true;
    el.card.hidden = false;
    el.pill.hidden = true;
    requestAnimationFrame(clampPos);
  }

  async function acceptConsent() {
    cfg.consentVersion = CONSENT_VERSION;
    cfg.hidden = false;
    await saveCfg();
    el.consent.hidden = true;
    el.monitor.hidden = false;
    setCollapsed(cfg.collapsed, true);
    if (currentUsage) renderUsage(currentUsage);
    startLoop();
    refresh(true);
  }

  async function declineConsent() {
    cfg.hidden = true;
    await saveCfg();
    el.root.hidden = true;
  }

  async function withdrawConsent() {
    clearInterval(timers.poll);
    clearInterval(timers.tick);
    cfg = { ...DEFAULTS };
    notified = {};
    apiPath = "";
    currentUsage = null;
    lastSuccessAt = 0;
    lastAttemptAt = 0;
    await storageClear();
    el.settings.hidden = true;
    el.about.hidden = true;
    showConsent();
  }

  function place(left, bottom) {
    const rect = el.root.getBoundingClientRect();
    const width = rect.width || 200;
    const height = rect.height || 60;
    left = Math.max(0, Math.min(left, Math.max(0, window.innerWidth - width)));
    bottom = Math.max(0, Math.min(bottom, Math.max(0, window.innerHeight - height)));
    el.root.style.left = Math.round(left) + "px";
    el.root.style.bottom = Math.round(bottom) + "px";
    el.root.style.right = "auto";
    el.root.style.top = "auto";
    return { left, bottom };
  }

  function applyPos() {
    if (cfg.pos && cfg.pos.v === 2) place(cfg.pos.left, cfg.pos.bottom);
    else dockDefault(true);
  }

  function clampPos() {
    if (!el.root || el.root.hidden) return;
    if (cfg.pos && cfg.pos.v === 2) {
      const position = place(cfg.pos.left, cfg.pos.bottom);
      cfg.pos = { v: 2, left: Math.round(position.left), bottom: Math.round(position.bottom) };
    }
  }

  function dockDefault(silent) {
    cfg.pos = null;
    el.root.style.left = "auto";
    el.root.style.top = "auto";
    el.root.style.right = "16px";
    el.root.style.bottom = "0px";
    if (silent !== true) {
      saveCfg();
      el.settings.hidden = true;
    }
  }

  function attachDrag(handle, onTap) {
    let startX = 0, startY = 0, startLeft = 0, startBottom = 0, dragging = false, moved = false, pointerId = null;
    handle.addEventListener("pointerdown", (event) => {
      if (event.target.closest("button, a, input, label")) return;
      const rect = el.root.getBoundingClientRect();
      startLeft = rect.left;
      startBottom = window.innerHeight - rect.bottom;
      startX = event.clientX;
      startY = event.clientY;
      dragging = true;
      moved = false;
      pointerId = event.pointerId;
      try { handle.setPointerCapture(pointerId); } catch (_) {}
      el.root.classList.add("cuw-dragging");
    });
    handle.addEventListener("pointermove", (event) => {
      if (!dragging) return;
      const dx = event.clientX - startX;
      const dy = event.clientY - startY;
      if (!moved && Math.abs(dx) + Math.abs(dy) < 4) return;
      moved = true;
      event.preventDefault();
      place(startLeft + dx, startBottom - dy);
    });
    const end = () => {
      if (!dragging) return;
      dragging = false;
      el.root.classList.remove("cuw-dragging");
      try { handle.releasePointerCapture(pointerId); } catch (_) {}
      if (moved) {
        const rect = el.root.getBoundingClientRect();
        cfg.pos = { v: 2, left: Math.round(rect.left), bottom: Math.round(window.innerHeight - rect.bottom) };
        saveCfg();
      } else if (onTap) onTap();
    };
    handle.addEventListener("pointerup", end);
    handle.addEventListener("pointercancel", end);
  }

  function renderLimitRow(limit) {
    const row = document.createElement("div");
    row.className = "cuw-row";
    const mini = document.createElement("div");
    mini.className = "cuw-mini";
    mini.innerHTML = ringMarkup(11);
    setRing(mini, limit.remainingPercent);
    const mid = document.createElement("div");
    mid.className = "cuw-mid";
    const label = document.createElement("div");
    label.className = "cuw-lbl";
    label.textContent = limit.label || "Usage limit";
    const reset = document.createElement("div");
    reset.className = "cuw-reset";
    reset.dataset.reset = limit.resetAt || "";
    reset.textContent = limit.resetAt ? countdown(limit.resetAt) : "reset time unavailable";
    mid.append(label, reset);
    const percent = document.createElement("div");
    percent.className = "cuw-pct";
    percent.textContent = formatPercent(limit.remainingPercent);
    row.append(mini, mid, percent);
    return row;
  }

  function valueRow(labelText, valueText, subText) {
    const row = document.createElement("div");
    row.className = "cuw-crow";
    const mid = document.createElement("div");
    mid.className = "cuw-mid";
    const label = document.createElement("div");
    label.className = "cuw-lbl";
    label.textContent = labelText;
    mid.appendChild(label);
    if (subText) {
      const sub = document.createElement("div");
      sub.className = "cuw-reset";
      sub.textContent = subText;
      mid.appendChild(sub);
    }
    const value = document.createElement("div");
    value.className = "cuw-cval";
    value.textContent = valueText;
    row.append(mid, value);
    return row;
  }

  function shortLabel(limit) {
    if (!limit) return "Usage";
    if (limit.windowSeconds >= 518400 && limit.windowSeconds <= 691200) return "Weekly";
    if (limit.windowSeconds && limit.windowSeconds < 86400) return `${Math.max(1, Math.round(limit.windowSeconds / 3600))}h`;
    return (limit.label || "Usage").replace(/\s+limit$/i, "").slice(0, 12);
  }

  function renderUsage(usage) {
    currentUsage = usage;
    const limits = Array.isArray(usage.limits) ? usage.limits : [];
    const additional = Array.isArray(usage.additionalLimits) ? usage.additionalLimits : [];
    el.list.textContent = "";
    el.additionalRows.textContent = "";
    if (!limits.length) {
      setRing(el.hero, 0);
      el.hero.querySelector(".cuw-hero-pct").textContent = "—";
      el.heroLabel.textContent = "No usage limits returned";
      el.heroReset.textContent = "Your plan may not expose this data";
      el.heroReset.dataset.reset = "";
    } else {
      const hero = limits[0];
      setRing(el.hero, hero.remainingPercent);
      el.hero.querySelector(".cuw-hero-pct").textContent = formatPercent(hero.remainingPercent);
      el.heroLabel.textContent = hero.label;
      el.heroReset.dataset.reset = hero.resetAt || "";
      el.heroReset.textContent = hero.resetAt ? countdown(hero.resetAt) : "reset time unavailable";
      limits.slice(1).forEach((limit) => el.list.appendChild(renderLimitRow(limit)));
    }
    additional.forEach((limit) => el.additionalRows.appendChild(renderLimitRow(limit)));
    el.additional.hidden = !additional.length;
    renderPill(limits);
    renderResetCredits(usage.resetCredits);
    renderCredits(usage.credits);
    renderSpend(usage.spendControl);
    const alarm = [...limits, ...additional].some((limit) => limit.usedPercent >= cfg.threshold);
    el.card.classList.toggle("alarm", alarm);
    requestAnimationFrame(clampPos);
  }

  function renderPill(limits) {
    const first = limits[0] || null;
    const second = limits[1] || null;
    q("#cuw-pill-label-s").textContent = shortLabel(first);
    el.pillS.textContent = first ? formatPercent(first.remainingPercent) : "—";
    setRing(el.pillRingS, first ? first.remainingPercent : 0);
    q("#cuw-pill-label-w").textContent = shortLabel(second);
    el.pillW.textContent = second ? formatPercent(second.remainingPercent) : "—";
    setRing(el.pillRingW, second ? second.remainingPercent : 0);
    q("#cuw-pill-secondary").classList.toggle("cuw-unavailable", !second);
  }

  function renderResetCredits(resetCredits) {
    el.resetRows.textContent = "";
    const count = resetCredits && Number(resetCredits.availableCount);
    if (!Number.isFinite(count) || count < 1) {
      el.resets.hidden = true;
      return;
    }
    const detail = resetCredits.credits && resetCredits.credits[0];
    const sub = detail && detail.expiresAt ? "expires " + formatDate(detail.expiresAt) : "";
    el.resetRows.appendChild(valueRow(detail && detail.label || "Full reset", `${count} available`, sub));
    el.resets.hidden = false;
  }

  function renderCredits(credits) {
    el.creditRows.textContent = "";
    if (cfg.showCredits === false || !credits || !Number.isFinite(Number(credits.balance))) {
      el.credits.hidden = true;
      return;
    }
    el.creditRows.appendChild(valueRow("Current balance", money(credits.balance), ""));
    el.credits.hidden = false;
  }

  function renderSpend(spend) {
    el.spendRows.textContent = "";
    if (!spend || !Number.isFinite(spend.used) || !Number.isFinite(spend.limit)) {
      el.spend.hidden = true;
      return;
    }
    el.spendRows.appendChild(valueRow("Used", money(spend.used), ""));
    el.spendRows.appendChild(valueRow("Limit", money(spend.limit), ""));
    el.spendRows.appendChild(valueRow("Remaining", formatPercent(spend.remainingPercent), ""));
    el.spend.hidden = false;
  }

  function updatePillTitle() {
    if (!el.pill) return;
    const limits = currentUsage && currentUsage.limits || [];
    const parts = limits.slice(0, 2).map((limit) => `${shortLabel(limit)} ${formatPercent(limit.remainingPercent)} remaining`);
    el.pill.title = ["ChatGPT usage", el.sync.textContent, ...parts, "drag to move"].filter(Boolean).join(" · ");
  }

  function visibleUsageSurface() {
    const dialogs = Array.from(document.querySelectorAll('[role="dialog"]'));
    const direct = dialogs.find((node) => {
      if (node.closest("#cuw-root")) return false;
      const text = node.innerText || "";
      return /\b(?:5[- ]hour|weekly)(?:\s+usage)?\s+limit\b/i.test(text) && /\d+(?:\.\d+)?\s*%\s*(?:left|remaining)\b/i.test(text);
    });
    if (direct) return direct;

    const headings = Array.from(document.querySelectorAll('h1,h2,h3,[role="heading"]'));
    const usageHeading = headings.find((node) => !node.closest("#cuw-root") && /^usage$/i.test((node.textContent || "").trim()));
    let candidate = usageHeading && usageHeading.parentElement;
    for (let depth = 0; candidate && depth < 8; depth++, candidate = candidate.parentElement) {
      const text = candidate.innerText || "";
      if (/\b(?:5[- ]hour|weekly)(?:\s+usage)?\s+limit\b/i.test(text) && /\d+(?:\.\d+)?\s*%\s*(?:left|remaining)\b/i.test(text)) return candidate;
    }
    return null;
  }

  function usageFromVisiblePage() {
    const surface = visibleUsageSurface();
    if (!surface) return null;
    const usage = Parser.normalizeVisibleUsageText(surface.innerText || "");
    return usage && usage.limits.length ? usage : null;
  }

  async function applyVisibleUsage(usage, quiet) {
    if (!hasConsent()) return false;
    if (!usage || !usage.limits.length) return false;
    currentUsage = usage;
    lastSuccessAt = Date.now();
    renderUsage(usage);
    el.card.classList.remove("stale");
    el.sync.textContent = "synced from Usage " + new Date(lastSuccessAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
    updatePillTitle();
    await storageSet({ lastUsage: usage, lastAt: lastSuccessAt });
    checkAlerts(usage);
    if (!quiet) {
      el.pill.classList.add("cuw-updated");
      setTimeout(() => el.pill && el.pill.classList.remove("cuw-updated"), 650);
    }
    return true;
  }

  function scheduleVisibleUsageSync() {
    if (!hasConsent()) return;
    clearTimeout(domSyncTimer);
    domSyncTimer = setTimeout(() => {
      const usage = usageFromVisiblePage();
      if (usage) applyVisibleUsage(usage, true);
    }, 350);
  }

  function checkAlerts(usage) {
    if (cfg.osNotifications === false) return;
    const limits = [...(usage.limits || []), ...(usage.additionalLimits || [])];
    const activeKeys = new Set();
    limits.forEach((limit) => {
      const key = [limit.id, limit.windowSeconds || "unknown", limit.resetAt || "no-reset"].join("|");
      activeKeys.add(key);
      if (limit.usedPercent >= cfg.threshold && !notified[key]) {
        notified[key] = true;
        sendMessage({
          type: "notify",
          title: `${limit.label} usage at ${formatPercent(limit.usedPercent)}`,
          message: `${formatPercent(limit.remainingPercent)} remaining${limit.resetAt ? " · " + countdown(limit.resetAt) : ""}`
        });
      } else if (limit.usedPercent < cfg.threshold && notified[key]) {
        delete notified[key];
      }
    });
    Object.keys(notified).forEach((key) => {
      if (!activeKeys.has(key)) delete notified[key];
    });
    saveNotified();
  }

  async function refresh(manual) {
    if (!hasConsent()) return;
    if (!extensionAlive()) return shutdown();
    if (!manual && Date.now() - lastAttemptAt < MIN_POLL * 1000) return;
    lastAttemptAt = Date.now();
    const refreshBtn = q("#cuw-refresh");
    if (refreshBtn) refreshBtn.disabled = true;
    if (manual) el.sync.textContent = "refreshing…";
    try {
      const fetched = await fetchUsage();
      let usage = fetched.usage;
      usage = await addOptionalResetDetails(usage, fetched.auth);
      lastSuccessAt = Date.now();
      renderUsage(usage);
      el.card.classList.remove("stale");
      el.sync.textContent = "synced " + new Date(lastSuccessAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" });
      updatePillTitle();
      el.pill.classList.add("cuw-updated");
      setTimeout(() => el.pill && el.pill.classList.remove("cuw-updated"), 650);
      await storageSet({ lastUsage: usage, lastAt: lastSuccessAt });
      checkAlerts(usage);
    } catch (error) {
      const visibleUsage = usageFromVisiblePage();
      if (visibleUsage && await applyVisibleUsage(visibleUsage, false)) return;
      el.card.classList.add("stale");
      if (currentUsage) {
        renderUsage(currentUsage);
      } else if (error && error.status === 401) {
        el.heroLabel.textContent = "ChatGPT session unavailable";
        el.heroReset.textContent = "reload ChatGPT and try again";
        el.heroReset.dataset.reset = "";
      } else {
        el.heroLabel.textContent = "Usage unavailable";
        el.heroReset.textContent = "try refreshing in a moment";
        el.heroReset.dataset.reset = "";
      }
      el.sync.textContent = errorText(error, !!currentUsage);
      updatePillTitle();
    } finally {
      if (refreshBtn) refreshBtn.disabled = false;
    }
  }

  function tick() {
    if (!el.root) return;
    el.root.querySelectorAll("[data-reset]").forEach((node) => {
      const value = Number(node.dataset.reset);
      if (Number.isFinite(value) && value > 0) node.textContent = countdown(value);
    });
  }

  function flash(message) {
    el.sync.textContent = message;
  }

  function copyDebug() {
    const usage = currentUsage || { limits: [], additionalLimits: [], resetCredits: {} };
    const cleanLimit = (limit) => ({
      id: limit.id,
      label: limit.label,
      usedPercent: limit.usedPercent,
      remainingPercent: limit.remainingPercent,
      windowSeconds: limit.windowSeconds,
      resetAt: limit.resetAt ? new Date(limit.resetAt).toISOString() : null
    });
    const payload = {
      tool: BRAND,
      edition: "ChatGPT",
      version: VERSION,
      generatedAt: new Date().toISOString(),
      apiPath: apiPath || null,
      planType: usage.planType || null,
      limits: (usage.limits || []).map(cleanLimit),
      additionalLimits: (usage.additionalLimits || []).map(cleanLimit),
      resetCreditsAvailable: usage.resetCredits && usage.resetCredits.availableCount || 0,
      lastSuccessfulRefresh: lastSuccessAt ? new Date(lastSuccessAt).toISOString() : null
    };
    const text = JSON.stringify(payload, null, 2);
    if (navigator.clipboard && navigator.clipboard.writeText) {
      navigator.clipboard.writeText(text).then(() => flash("copied redacted debug info"), () => flash("copy failed"));
    } else {
      flash("clipboard unavailable");
    }
  }

  function setCollapsed(value, silent) {
    if (!hasConsent()) {
      showConsent();
      return;
    }
    cfg.collapsed = value;
    el.card.hidden = value;
    el.pill.hidden = !value;
    if (!silent) saveCfg();
    requestAnimationFrame(clampPos);
  }

  const SWITCHES = [
    ["#cuw-credits-on", "#cuw-credits-state"],
    ["#cuw-notify-on", "#cuw-notify-state"],
  ];

  function syncSwitch(boxSel, stateSel) {
    const input = q(boxSel);
    const label = q(stateSel);
    if (!input || !label) return;
    const on = input.checked;
    label.textContent = on ? "On" : "Off";
    label.classList.toggle("is-on", on);
    const sw = input.closest(".cuw-sw");
    if (sw) sw.classList.toggle("is-on", on);
  }

  function syncSwitches() {
    SWITCHES.forEach(([box, state]) => syncSwitch(box, state));
  }

  async function saveSettings() {
    const minutes = parseInt(q("#cuw-poll").value, 10) || 2;
    cfg.pollSec = Math.max(MIN_POLL, minutes * 60);
    q("#cuw-poll").value = Math.round(cfg.pollSec / 60);
    cfg.threshold = Math.min(100, Math.max(1, parseInt(q("#cuw-thr").value, 10) || 90));
    cfg.showCredits = q("#cuw-credits-on").checked;
    cfg.osNotifications = q("#cuw-notify-on").checked;
    syncSwitches();
    await saveCfg();
    el.settings.hidden = true;
    if (currentUsage) renderUsage(currentUsage);
    startLoop();
    refresh(true);
  }

  function startLoop() {
    if (!hasConsent()) return;
    clearInterval(timers.poll);
    clearInterval(timers.tick);
    timers.poll = setInterval(() => {
      if (!extensionAlive()) return shutdown();
      if (!document.hidden) refresh(false);
    }, cfg.pollSec * 1000);
    timers.tick = setInterval(() => {
      if (!extensionAlive()) return shutdown();
      tick();
    }, 1000);
  }

  function keepWidgetMounted() {
    if (!el.root || el.root.isConnected) return;
    const duplicate = document.getElementById("cuw-root");
    if (duplicate && duplicate !== el.root) duplicate.remove();
    (document.body || document.documentElement).appendChild(el.root);
    applyPos();
  }

  function watchSpa() {
    spaObserver = new MutationObserver((records) => {
      if (!extensionAlive()) return shutdown();
      keepWidgetMounted();
      if (records.some((record) => !el.root || !el.root.contains(record.target))) scheduleVisibleUsageSync();
    });
    spaObserver.observe(document.documentElement, { childList: true, subtree: true });
  }

  async function init() {
    if (!Parser) return;
    await load();
    if (!build()) return;
    watchSpa();
    if (hasConsent()) {
      if (currentUsage) {
        renderUsage(currentUsage);
        el.card.classList.add("stale");
        el.sync.textContent = lastSuccessAt ? "cached " + new Date(lastSuccessAt).toLocaleTimeString([], { hour: "numeric", minute: "2-digit" }) : "cached usage";
      }
      startLoop();
      refresh(true);
    } else {
      showConsent();
    }
    document.addEventListener("visibilitychange", () => {
      if (!extensionAlive()) return shutdown();
      if (!document.hidden) refresh(false);
    });
    try {
      chrome.runtime.onMessage.addListener((message) => {
      if (message && message.type === "toggle" && el.root) {
        cfg.hidden = !el.root.hidden;
        el.root.hidden = cfg.hidden;
        saveCfg();
        if (!cfg.hidden) {
          keepWidgetMounted();
          clampPos();
        }
      }
      });
    } catch (_) {
      shutdown();
    }
  }

  if (document.readyState === "loading") document.addEventListener("DOMContentLoaded", init, { once: true });
  else init();
})();
