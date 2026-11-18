/* Website statistics only; independent of CLI telemetry. No third-party code
 * is requested until a saved, explicit grant and a valid public ID exist. */
(() => {
  "use strict";
  if (window.__ownhowConsentInitialized) return;
  const allow = document.getElementById("analytics-allow");
  const reject = document.getElementById("analytics-reject");
  const status = document.getElementById("analytics-status");
  if (!allow || !reject || !status) return;
  window.__ownhowConsentInitialized = true;

  const key = "ownhow.website-statistics.v1";
  const refusalParameter = "ownhow-consent";
  const candidate = window.ownhowAnalytics?.measurementId;
  const id = typeof candidate === "string" && /^G-[A-Z0-9]{10}$/.test(candidate) ? candidate : "";
  let active = false;
  let attempted = false;
  let configured = false;
  let withdrawing = false;
  let generation = 0;
  let tag;

  function forcedRefusal() {
    return new URL(window.location.href).searchParams.has(refusalParameter);
  }

  function choice() {
    if (forcedRefusal()) return "denied";
    try {
      const value = window.localStorage.getItem(key);
      return value === "granted" || value === "denied" ? value : "";
    } catch {
      return "";
    }
  }

  function save(value) {
    try {
      window.localStorage.setItem(key, value);
      return window.localStorage.getItem(key) === value;
    } catch {
      return false;
    }
  }

  function clearCookies() {
    if (!id) return;
    // Exact own-stream names, including defaults observed before the startup
    // ordering fix. Never enumerate other streams, paths, or ancestor domains.
    // HttpOnly cookies and inaccessible storage cannot be cleared by this code.
    try {
      const names = new Set(["_ga", `_ga_${id.slice(2)}`, "ownhow_ga", `ownhow_ga_${id.slice(2)}`]);
      const hostname = new URL(window.location.href).hostname;
      for (const cookie of document.cookie.split(";")) {
        const name = cookie.trim().split("=")[0];
        if (names.has(name)) {
          document.cookie = `${name}=; Max-Age=0; Path=/; SameSite=Lax`;
          // A current-host Domain cookie and a host-only cookie have distinct
          // scopes. Do not try parent domains; a leading dot is equivalent.
          if (/^[a-z0-9.-]+$/i.test(hostname)) {
            document.cookie = `${name}=; Max-Age=0; Path=/; Domain=${hostname}; SameSite=Lax`;
          }
        }
      }
    } catch { /* Best effort; refusal does not depend on cookie deletion. */ }
  }

  function refuse() {
    if (withdrawing) return;
    // Persist refusal BEFORE teardown. If storage fails, the navigation URL
    // independently blocks the next document (including a refresh).
    const saved = save("denied");
    withdrawing = true;
    active = false;
    generation += 1;
    if (id) window[`ga-disable-${id}`] = true;
    if (window.dataLayer) window.dataLayer.length = 0;
    if (tag) {
      tag.onload = null;
      tag.onerror = null;
      tag.remove();
    }
    clearCookies();
    status.textContent = "Statistics refused / 已拒绝统计。";
    if (attempted || !saved) {
      status.textContent += " Restarting without analytics / 正在重新载入。";
      const url = new URL(window.location.href);
      url.searchParams.set(refusalParameter, "denied");
      // A changed query navigates to a new document; a same-URL reload does too.
      // Removing a script alone cannot stop vendor code that already executed.
      if (url.href === window.location.href) window.location.reload();
      else window.location.replace(url.href);
    } else {
      withdrawing = false; // A deliberate later opt-in remains available.
    }
  }

  function start() {
    if (withdrawing || attempted || choice() !== "granted") return;
    if (!id) {
      status.textContent = "Choice saved; statistics unavailable until configured / 选择已保存，统计尚未配置。";
      return;
    }
    attempted = true;
    active = true;
    const token = ++generation;
    window[`ga-disable-${id}`] = false;
    window.dataLayer = [];
    window.gtag = function () {
      if (active && token === generation && choice() === "granted") {
        window.dataLayer.push(arguments);
      }
    };
    // Vendor execution precedes onload and may initialize without waiting for
    // config. Queue global settings FIRST, before js/config and script insertion.
    // The config repeats them for legacy config-led initialization. Nothing is
    // queued before a saved grant, and onload never configures/sends another view.
    const options = {
      send_page_view: false,
      allow_google_signals: false,
      allow_ad_personalization_signals: false,
      cookie_prefix: "ownhow",
      cookie_domain: "none",
      cookie_path: "/",
      page_location: "https://ownhow.dev/",
      page_referrer: ""
    };
    window.gtag("set", options);
    window.gtag("js", new Date());
    window.gtag("config", id, options);
    window.gtag("event", "page_view", { page_location: "https://ownhow.dev/", page_referrer: "" });
    tag = document.createElement("script");
    tag.async = true;
    tag.src = `https://www.googletagmanager.com/gtag/js?id=${id}`;
    tag.onload = () => {
      if (!active || token !== generation || configured) return;
      if (choice() !== "granted") {
        refuse();
        return;
      }
      configured = true;
      status.textContent = "Statistics allowed. You can withdraw below / 已允许统计，可在下方撤回。";
    };
    tag.onerror = () => {
      if (active && token === generation) {
        active = false;
        generation += 1;
        window[`ga-disable-${id}`] = true;
        window.dataLayer.length = 0;
        status.textContent = "Statistics could not load; no retry on this page / 统计加载失败，本页不重试。";
      }
    };
    // The complete consented startup queue is ready before vendor execution.
    document.head.appendChild(tag);
    status.textContent = "Statistics allowed; loading / 已允许统计，正在加载。";
  }

  allow.addEventListener("click", () => {
    if (withdrawing) return;
    if (!save("granted")) {
      if (attempted) {
        refuse();
        return;
      }
      status.textContent = "Statistics blocked: cannot save your choice / 无法保存选择，统计未启用。";
      return;
    }
    if (forcedRefusal()) {
      const url = new URL(window.location.href);
      url.searchParams.delete(refusalParameter);
      try {
        window.history.replaceState(null, "", url.href);
      } catch {
        save("denied");
        status.textContent = "Statistics blocked: could not update this page / 无法更新页面，统计未启用。";
        return;
      }
    }
    start();
  });
  reject.addEventListener("click", refuse);
  window.addEventListener("storage", (event) => {
    if ((event.key === key || event.key === null) && choice() !== "granted") {
      if (attempted) refuse();
      else status.textContent = "Statistics blocked / 统计未启用。";
    }
  });

  if (forcedRefusal()) save("denied");
  if (choice() === "granted") start();
  else {
    if (id) window[`ga-disable-${id}`] = true;
    if (choice() === "denied") clearCookies();
    status.textContent = choice() === "denied"
      ? "Statistics refused / 已拒绝统计。"
      : "Statistics off until you allow / 允许前不加载统计。";
  }
})();
