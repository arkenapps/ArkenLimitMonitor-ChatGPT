(function (scope) {
  "use strict";

  const hasOwn = (o, k) => Object.prototype.hasOwnProperty.call(o || {}, k);
  const finite = (v) => {
    if (typeof v === "string" && v.trim() === "") return null;
    const n = Number(v);
    return Number.isFinite(n) ? n : null;
  };
  const clamp = (n, lo, hi) => Math.max(lo, Math.min(hi, n));

  function humanize(value) {
    return String(value || "")
      .replace(/([a-z0-9])([A-Z])/g, "$1 $2")
      .replace(/[_-]+/g, " ")
      .replace(/\s+/g, " ")
      .trim()
      .replace(/\b\w/g, (c) => c.toUpperCase());
  }

  function normalizePercent(value, fractionSemantics) {
    let n = finite(value);
    if (n === null) return null;
    if (fractionSemantics && n >= 0 && n <= 1) n *= 100;
    return Math.round(clamp(n, 0, 100) * 10) / 10;
  }

  function percentFromObject(o) {
    if (!o || typeof o !== "object") return null;
    const percentKeys = ["used_percent", "usedPercent", "percent_used", "percentUsed", "used_pct", "usage_percent", "usagePercent"];
    for (const key of percentKeys) {
      if (hasOwn(o, key)) return normalizePercent(o[key], false);
    }
    const fractionKeys = ["usage_fraction", "used_fraction", "utilization", "ratio"];
    for (const key of fractionKeys) {
      if (hasOwn(o, key)) return normalizePercent(o[key], true);
    }
    return null;
  }

  function normalizeTimestamp(value, nowMs) {
    const now = Number.isFinite(nowMs) ? nowMs : Date.now();
    if (value === null || value === undefined || value === "") return null;
    if (typeof value === "number" || (/^\d+(?:\.\d+)?$/.test(String(value).trim()))) {
      const n = Number(value);
      if (!Number.isFinite(n) || n <= 0) return null;
      return Math.round(n < 100000000000 ? n * 1000 : n);
    }
    const raw = String(value).trim();
    const nowDate = new Date(now);
    const lacksYear = !/\b(?:19|20)\d{2}\b/.test(raw);
    const looksLikeCalendarDate = /\b(?:jan|feb|mar|apr|may|jun|jul|aug|sep|oct|nov|dec)[a-z]*\b/i.test(raw) || /^\d{1,2}[/-]\d{1,2}(?:\s|$)/.test(raw);
    let parsed = Date.parse(raw);
    if (lacksYear && looksLikeCalendarDate) {
      const thisYear = nowDate.getFullYear();
      parsed = Date.parse(`${raw} ${thisYear}`);
      if (Number.isFinite(parsed) && parsed < now - 86400000) parsed = Date.parse(`${raw} ${thisYear + 1}`);
    }
    return Number.isFinite(parsed) ? parsed : null;
  }

  function resetFromObject(o, nowMs) {
    if (!o || typeof o !== "object") return null;
    for (const key of ["reset_at", "resets_at", "resetAt", "resetsAt", "next_reset", "nextReset"]) {
      if (hasOwn(o, key)) {
        const normalized = normalizeTimestamp(o[key], nowMs);
        if (normalized) return normalized;
      }
    }
    for (const key of ["reset_after_seconds", "resetAfterSeconds"]) {
      const seconds = finite(o[key]);
      if (seconds !== null && seconds >= 0) return (Number.isFinite(nowMs) ? nowMs : Date.now()) + seconds * 1000;
    }
    return null;
  }

  function normalizeWindow(o) {
    if (!o || typeof o !== "object") return null;
    for (const key of ["limit_window_seconds", "window_duration_seconds", "window_seconds", "limitWindowSeconds", "windowDurationSeconds", "windowSeconds"]) {
      const n = finite(o[key]);
      if (n !== null && n > 0) return Math.round(n);
    }
    for (const key of ["window_minutes", "limit_window_minutes", "windowMinutes", "limitWindowMinutes"]) {
      const n = finite(o[key]);
      if (n !== null && n > 0) return Math.round(n * 60);
    }
    return null;
  }

  function naturalDuration(seconds) {
    if (!Number.isFinite(seconds) || seconds <= 0) return "Usage";
    if (seconds < 3600) return `${Math.max(1, Math.round(seconds / 60))}-minute`;
    if (seconds < 172800) return `${Math.max(1, Math.round(seconds / 3600))}-hour`;
    if (seconds < 1209600) return `${Math.max(1, Math.round(seconds / 86400))}-day`;
    return `${Math.max(1, Math.round(seconds / 604800))}-week`;
  }

  function meaningfulName(value) {
    if (typeof value !== "string") return "";
    const clean = value.trim();
    if (!clean || /^(primary|secondary|rate.?limit|usage|general)$/i.test(clean)) return "";
    return humanize(clean).replace(/\bLimit\b.*\bLimit\b/i, "Limit");
  }

  function windowLabel(seconds, suppliedName, fallbackId) {
    const named = meaningfulName(suppliedName);
    if (named) return /limit/i.test(named) ? named : `${named} limit`;
    if (Number.isFinite(seconds)) {
      if (seconds <= 5400) return seconds >= 3300 && seconds <= 4500 ? "Hourly limit" : `${naturalDuration(seconds)} limit`;
      if (seconds >= 14400 && seconds <= 21600) return `${Math.round(seconds / 3600)}-hour limit`;
      if (seconds >= 518400 && seconds <= 691200) return "Weekly limit";
      return `${naturalDuration(seconds)} limit`;
    }
    return fallbackId === "secondary" ? "Secondary limit" : fallbackId === "primary" ? "Primary limit" : "Usage limit";
  }

  function normalizeLimit(windowData, options) {
    if (!windowData || typeof windowData !== "object") return null;
    const usedPercent = percentFromObject(windowData);
    if (usedPercent === null) return null;
    const opts = options || {};
    const windowSeconds = normalizeWindow(windowData);
    const supplied = windowData.limit_name || windowData.limitName || windowData.display_name || windowData.displayName || opts.name;
    const id = String(windowData.id || windowData.key || opts.id || "limit");
    return {
      id,
      label: windowLabel(windowSeconds, supplied, opts.fallbackId || id),
      usedPercent,
      remainingPercent: Math.round((100 - usedPercent) * 10) / 10,
      windowSeconds,
      resetAt: resetFromObject(windowData, opts.nowMs)
    };
  }

  function getRateLimit(value) {
    if (!value || typeof value !== "object") return null;
    return value.rate_limit || value.rateLimit || value;
  }

  function windowsFromRateLimit(rateLimit, options) {
    const rl = getRateLimit(rateLimit);
    if (!rl) return [];
    const out = [];
    const inheritedName = options && options.name || rl.limit_name || rl.limitName || rl.display_name || rl.displayName;
    const pairs = [
      ["primary", rl.primary_window || rl.primaryWindow],
      ["secondary", rl.secondary_window || rl.secondaryWindow]
    ];
    for (const [id, value] of pairs) {
      const item = normalizeLimit(value, { id, fallbackId: id, name: inheritedName, nowMs: options && options.nowMs });
      if (item) out.push(item);
    }
    if (!out.length) {
      const item = normalizeLimit(rl, { id: (options && options.id) || "general", name: inheritedName, nowMs: options && options.nowMs });
      if (item) out.push(item);
    }
    return out;
  }

  function limitSignature(limit) {
    return [
      String(limit.label || "").toLowerCase(),
      limit.windowSeconds || "",
      limit.usedPercent,
      limit.resetAt || ""
    ].join("|");
  }

  function dedupeLimits(limits) {
    const seen = new Set();
    return (limits || []).filter((limit) => {
      if (!limit) return false;
      const sig = limitSignature(limit);
      if (seen.has(sig)) return false;
      seen.add(sig);
      return true;
    });
  }

  function discoverGeneralLimits(data, nowMs) {
    const out = [];
    (function walk(value, key, path) {
      if (!value || typeof value !== "object") return;
      if (/additional.?rate.?limits?|credits?|spend|billing/i.test(key)) return;
      if (percentFromObject(value) !== null) {
        const item = normalizeLimit(value, {
          id: path || key || "general",
          fallbackId: key,
          name: value.limit_name || value.limitName || value.display_name || value.displayName || key,
          nowMs
        });
        if (item) out.push(item);
        return;
      }
      Object.entries(value).forEach(([childKey, child]) => {
        if (child && typeof child === "object") walk(child, childKey, path ? `${path}.${childKey}` : childKey);
      });
    })(data, "general", "");
    return dedupeLimits(out);
  }

  function normalizeAdditionalLimits(data, nowMs, generalLimits) {
    const source = data && (data.additional_rate_limits || data.additionalRateLimits);
    if (!Array.isArray(source)) return [];
    const existing = new Set((generalLimits || []).map(limitSignature));
    const out = [];
    source.forEach((entry, index) => {
      if (!entry || typeof entry !== "object") return;
      const displayName = entry.limit_name || entry.limitName || entry.display_name || entry.displayName || entry.metered_feature || entry.meteredFeature || entry.name || `Additional ${index + 1}`;
      windowsFromRateLimit(entry, { name: displayName, id: `additional-${index}`, nowMs }).forEach((limit) => {
        const windowPart = windowLabel(limit.windowSeconds, "", limit.id);
        const base = meaningfulName(displayName) || `Additional ${index + 1}`;
        limit.id = String(entry.id || entry.metered_feature || entry.meteredFeature || `additional-${index}`) + "-" + limit.id;
        limit.label = `${base} · ${windowPart}`;
        const sig = limitSignature(limit);
        if (!existing.has(sig)) {
          existing.add(sig);
          out.push(limit);
        }
      });
    });
    return dedupeLimits(out);
  }

  function moneyNumber(value, key) {
    const n = finite(value);
    if (n === null) return null;
    return /cents/i.test(String(key || "")) ? n / 100 : n;
  }

  function findMoneyValue(o, keys) {
    if (!o || typeof o !== "object") return null;
    for (const key of keys) {
      if (hasOwn(o, key)) {
        const value = moneyNumber(o[key], key);
        if (value !== null) return value;
      }
    }
    return null;
  }

  function normalizeCredits(data) {
    if (!data || typeof data !== "object") return null;
    const candidates = [data.credits, data.credit_balance, data.creditBalance, data.usage_credits, data.usageCredits].filter(Boolean);
    for (const candidate of candidates) {
      if (typeof candidate !== "object") {
        const direct = moneyNumber(candidate, "credits");
        if (direct !== null) return { balance: direct };
        continue;
      }
      const balance = findMoneyValue(candidate, ["balance", "current_balance", "currentBalance", "available_balance", "availableBalance", "amount", "value", "balance_cents", "amount_cents"]);
      if (balance !== null) return { balance };
    }
    return null;
  }

  function normalizeResetCredits(data) {
    if (!data || typeof data !== "object") return { availableCount: 0, credits: [] };
    const obj = data.rate_limit_reset_credits || data.rateLimitResetCredits || data.reset_credits || data.resetCredits;
    if (!obj || typeof obj !== "object") return { availableCount: 0, credits: [] };
    const rawCount = obj.available_count ?? obj.availableCount ?? obj.count ?? 0;
    const availableCount = Math.max(0, Math.floor(finite(rawCount) || 0));
    const rawCredits = Array.isArray(obj.credits) ? obj.credits : Array.isArray(obj.items) ? obj.items : [];
    const credits = rawCredits.map((credit) => ({
      label: meaningfulName(credit && (credit.display_name || credit.name || credit.type)) || "Full reset",
      expiresAt: resetFromObject(credit && {
        reset_at: credit.expires_at || credit.expiresAt || credit.expiry || credit.expiration
      })
    })).filter((credit) => credit.expiresAt);
    return { availableCount, credits };
  }

  function normalizeSpendControl(data) {
    if (!data || typeof data !== "object") return null;
    const root = data.spend_control || data.spendControl;
    if (!root || typeof root !== "object") return null;
    const obj = root.individual_limit && typeof root.individual_limit === "object" ? root.individual_limit : root.individualLimit && typeof root.individualLimit === "object" ? root.individualLimit : root;
    const used = findMoneyValue(obj, ["used", "amount_used", "amountUsed", "spent", "used_cents", "amount_used_cents"]);
    const limit = findMoneyValue(obj, ["limit", "amount", "max", "cap", "limit_cents", "amount_cents"]);
    if (used === null || limit === null || limit <= 0 || used < 0) return null;
    return { used, limit, remainingPercent: Math.round(clamp((limit - used) / limit * 100, 0, 100) * 10) / 10 };
  }

  function relativeResetFromText(value, nowMs) {
    const text = String(value || "");
    const relative = text.match(/resets?\s+in\s+([^\r\n]+)/i);
    if (relative) {
      let seconds = 0;
      const unitPattern = /(\d+(?:\.\d+)?)\s*(d|day|days|h|hr|hrs|hour|hours|m|min|mins|minute|minutes|s|sec|secs|second|seconds)\b/gi;
      let match;
      while ((match = unitPattern.exec(relative[1]))) {
        const amount = Number(match[1]);
        const unit = match[2].toLowerCase();
        if (unit.startsWith("d")) seconds += amount * 86400;
        else if (unit.startsWith("h")) seconds += amount * 3600;
        else if (unit.startsWith("m")) seconds += amount * 60;
        else seconds += amount;
      }
      if (seconds > 0) return (Number.isFinite(nowMs) ? nowMs : Date.now()) + seconds * 1000;
    }
    const absolute = text.match(/resets?\s+(?!in\b)([^\r\n]+)/i);
    return absolute ? normalizeTimestamp(absolute[1].trim(), nowMs) : null;
  }

  function visibleSection(text, startPattern, otherPattern) {
    const start = startPattern.exec(text);
    if (!start) return "";
    const tail = text.slice(start.index);
    const other = otherPattern.exec(tail.slice(start[0].length));
    return other ? tail.slice(0, start[0].length + other.index) : tail.slice(0, 500);
  }

  function normalizeVisibleUsageText(value, options) {
    const text = String(value || "").replace(/\u00a0/g, " ");
    const nowMs = options && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const definitions = [
      { id: "visible-five-hour", pattern: /\b5[- ]hour(?:\s+usage)?\s+limit\b/i, other: /\bweekly(?:\s+usage)?\s+limit\b/i, seconds: 18000, label: "5-hour limit" },
      { id: "visible-weekly", pattern: /\bweekly(?:\s+usage)?\s+limit\b/i, other: /\b5[- ]hour(?:\s+usage)?\s+limit\b/i, seconds: 604800, label: "Weekly limit" }
    ];
    const limits = [];
    definitions.forEach((definition) => {
      const section = visibleSection(text, definition.pattern, definition.other);
      if (!section) return;
      const remainingMatch = section.match(/(\d+(?:\.\d+)?)\s*%\s*(?:left|remaining)\b/i);
      const remainingPercent = remainingMatch ? normalizePercent(remainingMatch[1], false) : null;
      if (remainingPercent === null) return;
      limits.push({
        id: definition.id,
        label: definition.label,
        usedPercent: Math.round((100 - remainingPercent) * 10) / 10,
        remainingPercent,
        windowSeconds: definition.seconds,
        resetAt: relativeResetFromText(section, nowMs)
      });
    });
    limits.sort((a, b) => a.windowSeconds - b.windowSeconds);

    let resetCredits = { availableCount: 0, credits: [] };
    const resetIndex = text.search(/full reset(?:\s*\([^\r\n)]*\))?/i);
    if (resetIndex >= 0) {
      const resetBlock = text.slice(resetIndex, resetIndex + 240);
      const expiry = resetBlock.match(/expires?\s+([^\r\n]+)/i);
      const expiresAt = expiry ? normalizeTimestamp(expiry[1].trim(), nowMs) : null;
      resetCredits = { availableCount: 1, credits: expiresAt ? [{ label: "Full reset", expiresAt }] : [] };
    }

    let credits = null;
    const balance = text.match(/current balance\s*\$\s*(\d+(?:\.\d{1,2})?)/i);
    if (balance) credits = { balance: Number(balance[1]) };

    return {
      source: "chatgpt",
      planType: null,
      limits,
      additionalLimits: [],
      credits,
      spendControl: null,
      resetCredits
    };
  }

  function normalizeUsageResponse(data, options) {
    const nowMs = options && Number.isFinite(options.nowMs) ? options.nowMs : Date.now();
    const root = data && typeof data === "object" ? data : {};
    let limits = windowsFromRateLimit(root.rate_limit || root.rateLimit, { nowMs });
    if (!limits.length) limits = windowsFromRateLimit(root, { nowMs });
    if (!limits.length) limits = discoverGeneralLimits(root, nowMs);
    limits = dedupeLimits(limits).sort((a, b) => (a.windowSeconds || Infinity) - (b.windowSeconds || Infinity));
    const additionalLimits = normalizeAdditionalLimits(root, nowMs, limits);
    return {
      source: "chatgpt",
      planType: typeof (root.plan_type || root.planType) === "string" ? (root.plan_type || root.planType) : null,
      limits,
      additionalLimits,
      credits: normalizeCredits(root),
      spendControl: normalizeSpendControl(root),
      resetCredits: normalizeResetCredits(root)
    };
  }

  const api = {
    humanize,
    normalizePercent,
    normalizeTimestamp,
    normalizeWindow,
    windowLabel,
    normalizeUsageResponse,
    normalizeAdditionalLimits,
    normalizeCredits,
    normalizeResetCredits,
    normalizeVisibleUsageText
  };

  scope.ArkenUsageParser = api;
  if (typeof module !== "undefined" && module.exports) module.exports = api;
})(typeof globalThis !== "undefined" ? globalThis : this);
