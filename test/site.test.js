import test from "node:test";
import assert from "node:assert/strict";
import { readFile, mkdtemp, readdir, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import vm from "node:vm";
import { createHash } from "node:crypto";
import { renderSiteConfiguration } from "../scripts/configure-site.js";
import { loadTelemetryConfig } from "../src/telemetry.js";

const read = (name) => readFile(new URL(`../${name}`, import.meta.url), "utf8");
const [html, source, config, headers] = await Promise.all([
  read("site/index.html"), read("site/analytics.js"), read("site/analytics-config.js"), read("site/_headers")
]);
// This synthetic ID is a TEST FIXTURE ONLY. The supplied public ID is also
// exercised below. All requests are records in memory;
// no browser, fetch, HTTP client, real vendor script, or external network exists.
const TEST_ONLY_ID = "G-TESTONLY00";
const SHIPPED_ID = "G-LD3NXHS35B";
const KEY = "ownhow.website-statistics.v1";

function browser({ saved, storage = new Map(saved === undefined ? [] : [[KEY, saved]]), id = TEST_ONLY_ID,
  href = "https://ownhow.dev/", faults = {}, cookies = "", cookieDomains = {}, cookiePaths = {}, shippedConfig = false, missingConfig = false, configSource = config } = {}) {
  const steps = [], requests = [], tags = [], windowListeners = new Map(), elements = new Map();
  const cookieJar = new Map(cookies.split(";").filter(Boolean).map((part) => part.trim().split("=")));
  for (const match of html.matchAll(/id="([^"]+)"/g)) {
    elements.set(match[1], {
      textContent: "", listeners: new Map(),
      addEventListener(type, handler) {
        const list = this.listeners.get(type) ?? [];
        this.listeners.set(type, [...list, handler]);
      }
    });
  }
  const location = {
    href,
    replace(url) { steps.push(["navigate", url]); this.href = url; },
    reload() { steps.push(["reload", this.href]); }
  };
  const localStorage = {
    getItem(key) { if (faults.read) throw new Error("fixture storage read failure"); return storage.get(key) ?? null; },
    setItem(key, value) {
      if (faults.write) throw new Error("fixture storage write failure");
      if (faults.writeNoop) return;
      steps.push(["save", value]); storage.set(key, value);
    }
  };
  const document = {
    getElementById(id) { return elements.get(id); },
    createElement(name) {
      assert.equal(name, "script");
      return { remove() { steps.push(["remove"]); this.removed = true; } };
    },
    head: { appendChild(tag) {
      tags.push(tag); requests.push({ kind: "script", url: tag.src });
      steps.push(["append", Array.from(window.dataLayer ?? [], (args) => args[0]),
        JSON.parse(JSON.stringify(Array.from(window.dataLayer ?? [], (args) => Array.from(args))))]);
    } },
    get cookie() {
      if (faults.cookies) throw new Error("fixture cookie failure");
      const url = new URL(location.href);
      return [...cookieJar].filter(([name]) => (!cookieDomains[name] || cookieDomains[name] === url.hostname ||
        url.hostname.endsWith(`.${cookieDomains[name]}`)) &&
        url.pathname.startsWith(cookiePaths[name] ?? "/")).map(([k, v]) => `${k}=${v}`).join("; ");
    },
    set cookie(value) {
      if (faults.cookies) throw new Error("fixture cookie failure");
      steps.push(["cookie", value]);
      const [name, content] = value.split(";")[0].split("=");
      const domain = value.match(/;\s*Domain=([^;]+)/i)?.[1].replace(/^\./, "");
      const path = value.match(/;\s*Path=([^;]+)/i)?.[1] ?? "/";
      if (value.includes("Max-Age=0")) {
        if (domain === cookieDomains[name] && path === (cookiePaths[name] ?? "/")) cookieJar.delete(name);
      } else {
        cookieJar.set(name, content); cookieDomains[name] = domain; cookiePaths[name] = path;
      }
    }
  };
  const window = {
    document, location,
    history: { replaceState(_state, _unused, url) {
      if (faults.history) throw new Error("fixture history failure");
      steps.push(["history", url]); location.href = url;
    } },
    get localStorage() {
      if (faults.access) throw new Error("fixture storage access failure");
      return localStorage;
    },
    addEventListener(type, handler) {
      windowListeners.set(type, [...(windowListeners.get(type) ?? []), handler]);
    }
  };
  const context = vm.createContext({ window, document, URL });
  if (shippedConfig) vm.runInContext(configSource, context, { filename: "site/analytics-config.js" });
  else if (!missingConfig) window.ownhowAnalytics = { measurementId: id };
  const configuredId = window.ownhowAnalytics?.measurementId;
  const init = () => vm.runInContext(source, context, { filename: "site/analytics.js", timeout: 1000 });
  const click = (name) => { for (const handler of elements.get(`analytics-${name}`).listeners.get("click") ?? []) handler(); };
  const storageEvent = (key = KEY) => { for (const handler of windowListeners.get("storage") ?? []) handler({ key }); };
  // No vendor implementation/network here. Model both documented startup modes:
  // initialization at load (without waiting for config), or legacy config-led
  // initialization. Prequeued global set parameters precede initialization;
  // onload runs AFTER vendor execution. Defaults reproduce the observed browser
  // URL/default cookie names when settings arrive too late. UI overrides and
  // enhanced events are outside this bounded fake, and need real GUI acceptance.
  const commands = [];
  const initializations = [];
  function vendor({ mode = "immediate", defaultCookies = false } = {}) {
    let settings = {}, initialized = false;
    function collect(parameters = {}, event = "page_view") {
      requests.push({ kind: "collection", url: "https://www.google-analytics.com/g/collect", event,
        parameters: { ...settings, ...parameters },
        page_location: parameters.page_location ?? settings.page_location ?? window.location.href });
    }
    function initialize() {
      if (initialized || window[`ga-disable-${configuredId}`]) return;
      initialized = true;
      initializations.push({ ...settings });
      const prefix = defaultCookies ? "" : settings.cookie_prefix ?? "";
      try {
        document.cookie = `${prefix}_ga=fixture-client; Path=/`;
        document.cookie = `${prefix}_ga_${configuredId.slice(2)}=fixture-session; Path=/`;
      } catch { /* Vendor cookie failure need not abort initialization. */ }
      if (settings.send_page_view !== false) collect();
    }
    function processCommand(command) {
      const args = Array.from(command);
      commands.push(args);
      if (window[`ga-disable-${configuredId}`]) return;
      if (args[0] === "set") settings = { ...settings, ...args[1] };
      if (args[0] === "js" && mode === "immediate") initialize();
      if (args[0] === "config") {
        settings = { ...settings, ...args[2] };
        if (mode === "legacy") initialize();
      }
      if (args[0] === "event" && args[1] === "page_view") collect(args[2]);
    }
    const queue = window.dataLayer;
    for (const command of queue) processCommand(command);
    if (mode === "immediate") initialize();
    queue.push = function (...commands) {
      for (const command of commands) processCommand(command);
      return Array.prototype.push.apply(this, commands);
    };
    // A bounded stand-in for an SDK-generated interaction: inherit the settings
    // already supplied by the shipped bootstrap, without another config call.
    return { enhancedEvent(name) {
      if (!window[`ga-disable-${configuredId}`]) collect({}, name);
    } };
  }
  init();
  return { window, elements, storage, steps, requests, tags, commands, initializations, cookieJar, click, init, storageEvent, vendor,
    status: () => elements.get("analytics-status").textContent };
}

function noAnalytics(b) {
  assert.deepEqual(b.requests, []);
  assert.equal(b.window.dataLayer, undefined);
  assert.equal(b.window.gtag, undefined);
}

for (const saved of [undefined, "denied", "corrupt", '"granted"', "GRANTED"]) {
  test(`no tag or queue on initial load and refresh with choice ${String(saved)}`, () => {
    const b = browser({ saved });
    noAnalytics(b);
    b.init();
    noAnalytics(b);
    noAnalytics(browser({ storage: b.storage }));
  });
}

for (const faults of [{ access: true }, { read: true }, { write: true }, { writeNoop: true }]) {
  test(`inaccessible storage fails closed, including opt-in: ${JSON.stringify(faults)}`, () => {
    const b = browser({ saved: faults.write || faults.writeNoop ? undefined : "granted", faults });
    noAnalytics(b);
    b.click("allow");
    noAnalytics(b);
  });
}

test("deny persists without network and can deliberately become an allow", () => {
  const b = browser();
  b.click("reject");
  assert.equal(b.storage.get(KEY), "denied");
  noAnalytics(b);
  noAnalytics(browser({ storage: b.storage }));
  b.click("allow");
  assert.equal(b.tags.length, 1);
});

for (const id of ["", undefined, null, false, {}, "G-short", " G-TESTONLY00", "G-TESTONLY00\n", "G-testonly00", "G-TESTONLY00&x=1"]) {
  test(`blank or malformed config cannot load: ${JSON.stringify(id)}`, () => {
    const b = browser({ saved: "granted", id: id === undefined ? null : id });
    b.click("allow");
    noAnalytics(b);
  });
}

test("actual shipped configuration uses the supplied ID only after saved consent", () => {
  const b = browser({ shippedConfig: true });
  assert.equal(b.window.ownhowAnalytics.measurementId, SHIPPED_ID);
  noAnalytics(b);
  b.click("allow"); b.click("allow"); b.init();
  assert.deepEqual(b.requests, [{ kind: "script", url: `https://www.googletagmanager.com/gtag/js?id=${SHIPPED_ID}` }]);
  assert.equal(b.storage.get(KEY), "granted");
  assert.deepEqual(Array.from(b.window.dataLayer, (args) => args[0]), ["set", "js", "config", "event"]);
  b.vendor();
  const onload = b.tags[0].onload;
  onload(); onload();
  assert.equal(b.commands.filter(([type, id]) => type === "config" && id === SHIPPED_ID).length, 1);
  assert.equal(b.commands.filter(([type, name]) => type === "event" && name === "page_view").length, 1);
  assert.equal(b.requests.filter(({ kind }) => kind === "collection").length, 1);
  b.steps.length = 0;
  b.click("reject");
  assert.deepEqual(b.steps[0], ["save", "denied"]);
  assert.equal(b.window[`ga-disable-${SHIPPED_ID}`], true);
  onload(); b.window.gtag("event", "page_view");
  assert.equal(b.requests.length, 2);
  noAnalytics(browser({ shippedConfig: true, storage: b.storage, href: b.window.location.href }));
});

test("a generated blank configuration still blocks even a saved grant", () => {
  const b = browser({ shippedConfig: true, configSource: renderSiteConfiguration({}, html).config, saved: "granted" });
  assert.equal(b.window.ownhowAnalytics.measurementId, "");
  b.click("allow"); b.init();
  noAnalytics(b);
});

test("supplied shipped config honors saved grants and later denial across refresh", () => {
  const b = browser({ shippedConfig: true, saved: "granted" });
  assert.equal(b.tags.length, 1);
  assert.deepEqual(Array.from(b.window.dataLayer, (args) => args[0]), ["set", "js", "config", "event"]);
  b.click("reject");
  const refreshed = browser({ shippedConfig: true, storage: b.storage, href: b.window.location.href });
  noAnalytics(refreshed);
  refreshed.click("allow");
  assert.equal(refreshed.tags.length, 1);
  assert.equal(new URL(refreshed.window.location.href).searchParams.has("ownhow-consent"), false);
});

test("supplied shipped config fails closed on refusal, corrupt or inaccessible storage", () => {
  for (const saved of [undefined, "denied", "corrupt", '"granted"', "GRANTED"]) {
    const b = browser({ shippedConfig: true, saved });
    noAnalytics(b); b.init();
    noAnalytics(browser({ shippedConfig: true, storage: b.storage }));
  }
  for (const faults of [{ access: true }, { read: true }, { write: true }, { writeNoop: true }]) {
    const b = browser({ shippedConfig: true, saved: faults.write || faults.writeNoop ? undefined : "granted", faults });
    noAnalytics(b); b.click("allow"); noAnalytics(b);
  }
});

test("supplied shipped config cancels withdrawal/load races with storage or cookie failures", () => {
  for (const fault of [null, "write", "read", "access", "cookies"]) {
    const faults = {};
    const b = browser({ shippedConfig: true, saved: "granted", faults });
    const lateLoad = b.tags[0].onload, lateError = b.tags[0].onerror;
    if (fault) faults[fault] = true;
    b.click("reject");
    b.vendor(); lateLoad(); lateError(); b.window.gtag("event", "page_view");
    assert.equal(b.window[`ga-disable-${SHIPPED_ID}`], true);
    assert.equal(b.commands.length, 0);
    assert.equal(b.requests.length, 1);
    noAnalytics(browser({ shippedConfig: true, saved: "granted", href: b.window.location.href }));
  }
});

test("missing same-origin configuration script fails closed", () => {
  const b = browser({ saved: "granted", missingConfig: true });
  b.click("allow");
  noAnalytics(b);
});

test("opt-in, double click, repeated init/load emit one tag and one explicit view", () => {
  const b = browser({ href: "https://ownhow.dev/?sensitive=excluded#install" });
  b.click("allow"); b.click("allow"); b.init();
  assert.equal(b.tags.length, 1);
  assert.deepEqual(b.requests, [{ kind: "script", url: `https://www.googletagmanager.com/gtag/js?id=${TEST_ONLY_ID}` }]);
  assert.deepEqual(Array.from(b.window.dataLayer, (args) => args[0]), ["set", "js", "config", "event"]); // Only after saved grant, before vendor execution.
  assert.equal(b.storage.get(KEY), "granted");
  b.vendor();
  b.tags[0].onload(); b.tags[0].onload(); b.click("allow");
  assert.equal(b.commands.filter(([type]) => type === "config").length, 1);
  assert.equal(b.commands.filter(([type, name]) => type === "event" && name === "page_view").length, 1);
  const options = b.commands.find(([type]) => type === "config")[2];
  assert.equal(options.send_page_view, false);
  assert.equal(options.allow_google_signals, false);
  assert.equal(options.allow_ad_personalization_signals, false);
  assert.equal(options.cookie_domain, "none");
  assert.equal(options.cookie_prefix, "ownhow");
  assert.equal(options.page_location, "https://ownhow.dev/");
  assert.equal(options.page_referrer, "");
  assert.equal(options.user_id, undefined);
  assert.equal(b.requests.filter(({ kind }) => kind === "collection").length, 1);
  assert.equal(b.elements.get("analytics-allow").listeners.get("click").length, 1);
});

test("a saved grant loads once on refresh with settings queued before vendor initialization", () => {
  const b = browser({ saved: "granted" });
  assert.equal(b.tags.length, 1);
  assert.deepEqual(Array.from(b.window.dataLayer, (args) => args[0]), ["set", "js", "config", "event"]);
});

for (const mode of ["immediate", "legacy"]) {
  test(`vendor ${mode} startup sees privacy/cookie settings before any initialization and one initial view`, () => {
    const b = browser({ shippedConfig: true, href: "http://127.0.0.1:12345/?private=fixture#install" });
    noAnalytics(b);
    b.click("allow"); b.click("allow"); b.init();
    assert.deepEqual(b.steps.find(([kind]) => kind === "append")[1], ["set", "js", "config", "event"]);
    b.vendor({ mode }); // Execute the SDK BEFORE firing its script onload.
    assert.equal(b.initializations.length, 1);
    const initial = b.initializations[0];
    assert.equal(initial.send_page_view, false);
    assert.equal(initial.allow_google_signals, false);
    assert.equal(initial.allow_ad_personalization_signals, false);
    assert.equal(initial.cookie_prefix, "ownhow");
    assert.equal(initial.cookie_domain, "none");
    assert.equal(initial.cookie_path, "/");
    assert.equal(initial.page_location, "https://ownhow.dev/");
    assert.equal(initial.page_referrer, "");
    const beforeLoad = b.requests.filter(({ kind }) => kind === "collection");
    assert.equal(beforeLoad.length, 1);
    assert.equal(beforeLoad[0].page_location, "https://ownhow.dev/");
    const commandsBeforeLoad = b.commands.length;
    b.tags[0].onload(); b.tags[0].onload(); b.click("allow"); b.init();
    assert.equal(b.commands.length, commandsBeforeLoad); // onload is status/guard only.
    assert.equal(b.requests.filter(({ kind }) => kind === "collection").length, 1);
    assert.equal(b.cookieJar.has("_ga"), false);
    assert.equal(b.cookieJar.has(`_ga_${SHIPPED_ID.slice(2)}`), false);
    assert.equal(b.cookieJar.has("ownhow_ga"), true);
    assert.equal(b.cookieJar.has(`ownhow_ga_${SHIPPED_ID.slice(2)}`), true);
  });
}

test("load-time automatic initialization cannot add a local URL view before our canonical view", () => {
  const b = browser({ shippedConfig: true, href: "http://127.0.0.1:12345/" });
  b.click("allow"); b.vendor(); b.tags[0].onload();
  const views = b.requests.filter(({ kind }) => kind === "collection");
  assert.deepEqual(views.map(({ page_location }) => page_location), ["https://ownhow.dev/"]);
});

test("observed default own-stream cookies are removed on withdrawal and refused startup without touching other streams", () => {
  const cookies = `_ga=fixture-client; _ga_${SHIPPED_ID.slice(2)}=fixture-session; _ga_TESTOTHER0=other-stream; ownhow_ga_TESTOTHER0=other-prefix; session=keep`;
  const b = browser({ shippedConfig: true, cookies });
  b.click("allow"); b.vendor({ defaultCookies: true }); b.tags[0].onload();
  b.click("reject");
  const assertClean = (page) => {
    assert.equal(page.cookieJar.has("_ga"), false);
    assert.equal(page.cookieJar.has(`_ga_${SHIPPED_ID.slice(2)}`), false);
    assert.equal(page.cookieJar.has("ownhow_ga"), false);
    assert.equal(page.cookieJar.has(`ownhow_ga_${SHIPPED_ID.slice(2)}`), false);
    assert.equal(page.cookieJar.get("_ga_TESTOTHER0"), "other-stream");
    assert.equal(page.cookieJar.get("ownhow_ga_TESTOTHER0"), "other-prefix");
    assert.equal(page.cookieJar.get("session"), "keep");
  };
  assertClean(b);
  // A late vendor cookie write before document teardown is cleaned in the next
  // refused document, including when persistence is inaccessible/old-granted.
  for (const options of [{ saved: "denied" }, { saved: "granted", faults: { access: true } }]) {
    const refreshed = browser({ shippedConfig: true, cookies, href: b.window.location.href, ...options });
    noAnalytics(refreshed); assertClean(refreshed);
  }
});

test("a failed tag load clears granted pending commands and blocks late vendor execution", () => {
  const b = browser({ shippedConfig: true }); b.click("allow");
  const lateLoad = b.tags[0].onload;
  b.tags[0].onerror();
  b.vendor(); lateLoad(); b.window.gtag("event", "page_view");
  assert.equal(b.window[`ga-disable-${SHIPPED_ID}`], true);
  assert.equal(b.window.dataLayer.length, 0);
  assert.equal(b.commands.length, 0);
  assert.equal(b.requests.length, 1);
});

test("cleanup targets only exact current-host root cookies and the configured stream", () => {
  for (const hostname of ["ownhow.dev", "127.0.0.1"]) {
    for (const domain of [undefined, hostname]) {
      const names = ["_ga", `_ga_${SHIPPED_ID.slice(2)}`, "ownhow_ga", `ownhow_ga_${SHIPPED_ID.slice(2)}`];
      const b = browser({ shippedConfig: true, saved: "denied", href: `http://${hostname}/`,
        cookies: [...names.map((name) => `${name}=fixture`), "session=keep", "_ga_TESTOTHER0=other-stream"].join("; "),
        cookieDomains: Object.fromEntries(names.map((name) => [name, domain])) });
      noAnalytics(b);
      for (const name of names) assert.equal(b.cookieJar.has(name), false, name);
      assert.equal(b.cookieJar.get("session"), "keep");
      assert.equal(b.cookieJar.get("_ga_TESTOTHER0"), "other-stream");
      for (const [, expiration] of b.steps.filter(([kind]) => kind === "cookie")) {
        assert.match(expiration, /; Path=\//);
        const targetDomain = expiration.match(/; Domain=([^;]+)/)?.[1];
        assert.ok(targetDomain === undefined || targetDomain === hostname);
      }
    }
  }
  const scoped = browser({ shippedConfig: true, saved: "denied", href: "https://sub.ownhow.dev/",
    cookies: `_ga=ancestor-cookie; _ga_${SHIPPED_ID.slice(2)}=other-path; session=keep`,
    cookieDomains: { _ga: "ownhow.dev" }, cookiePaths: { [`_ga_${SHIPPED_ID.slice(2)}`]: "/other-app" } });
  assert.equal(scoped.cookieJar.get("_ga"), "ancestor-cookie");
  assert.equal(scoped.cookieJar.get(`_ga_${SHIPPED_ID.slice(2)}`), "other-path");
  assert.equal(scoped.cookieJar.get("session"), "keep");
  for (const [, expiration] of scoped.steps.filter(([kind]) => kind === "cookie")) {
    const domain = expiration.match(/; Domain=([^;]+)/)?.[1];
    assert.ok(domain === undefined || domain === "sub.ownhow.dev");
  }
});

test("withdraw after load saves denial before teardown and blocks retained handlers", () => {
  const b = browser({ cookies: `ownhow_ga=one; ownhow_ga_${TEST_ONLY_ID.slice(2)}=two; _ga=own-default; _ga_TESTOTHER0=other-stream; ownhow_ga_TESTOTHER0=other-prefixed-stream; session=keep` });
  b.click("allow"); b.vendor();
  const lateLoad = b.tags[0].onload;
  b.tags[0].onload();
  const gtag = b.window.gtag;
  const requestCount = b.requests.length;
  b.steps.length = 0;
  b.click("reject");
  assert.deepEqual(b.steps[0], ["save", "denied"]);
  assert.equal(b.window[`ga-disable-${TEST_ONLY_ID}`], true);
  assert.equal(b.tags[0].removed, true);
  assert.equal(b.tags[0].onload, null);
  assert.equal(b.cookieJar.has("ownhow_ga"), false);
  assert.equal(b.cookieJar.has(`ownhow_ga_${TEST_ONLY_ID.slice(2)}`), false);
  assert.equal(b.cookieJar.has("_ga"), false); // Observed own-site default cookie, not an unrelated app fixture.
  assert.equal(b.cookieJar.get("_ga_TESTOTHER0"), "other-stream");
  assert.equal(b.cookieJar.get("ownhow_ga_TESTOTHER0"), "other-prefixed-stream");
  assert.equal(b.cookieJar.get("session"), "keep");
  assert.equal(b.steps.at(-1)[0], "navigate");
  lateLoad(); gtag("event", "page_view"); b.click("allow"); b.init();
  assert.equal(b.requests.length, requestCount);
  assert.equal(b.storage.get(KEY), "denied");
  noAnalytics(browser({ storage: b.storage, href: b.window.location.href }));
});

test("withdraw before onload cancels captured load/error callbacks and pending queue", () => {
  const b = browser(); b.click("allow");
  const lateLoad = b.tags[0].onload, lateError = b.tags[0].onerror;
  b.click("reject");
  // Even a removed script that executes late sees an empty queue + disable flag.
  b.vendor(); lateLoad(); lateError(); b.window.gtag("event", "page_view");
  assert.equal(b.commands.length, 0);
  assert.equal(b.requests.length, 1); // The original tag request cannot be undone.
  assert.match(b.status(), /refused/);
});

test("load failure does not retry or queue page views and still permits withdrawal", () => {
  const b = browser(); b.click("allow"); b.tags[0].onerror();
  assert.match(b.status(), /could not load/);
  b.click("allow"); b.init();
  assert.equal(b.tags.length, 1);
  assert.equal(b.window.dataLayer.length, 0);
  b.click("reject");
  noAnalytics(browser({ storage: b.storage, href: b.window.location.href }));
});

for (const faults of [{ write: false }, { read: false }, { access: false }, { cookies: false }]) {
  test(`withdraw survives storage/cookie failure and refused URL overrides old grant: ${Object.keys(faults)[0]}`, () => {
    const b = browser({ saved: "granted", faults });
    const lateLoad = b.tags[0].onload;
    faults[Object.keys(faults)[0]] = true;
    b.click("reject"); lateLoad();
    assert.equal(b.window[`ga-disable-${TEST_ONLY_ID}`], true);
    assert.match(b.window.location.href, /ownhow-consent=denied/);
    assert.equal(b.requests.length, 1);
    noAnalytics(browser({ saved: "granted", href: b.window.location.href }));
    noAnalytics(browser({ saved: "granted", href: b.window.location.href, faults }));
  });
}

test("refused URL persists refusal on startup; later deliberate opt-in clears URL", () => {
  const b = browser({ saved: "granted", href: "https://ownhow.dev/?ownhow-consent=denied#install" });
  noAnalytics(b);
  assert.equal(b.storage.get(KEY), "denied");
  b.click("allow");
  assert.equal(b.window.location.href, "https://ownhow.dev/#install");
  assert.equal(b.tags.length, 1);
});

test("failure to remove refusal URL cannot load analytics", () => {
  const b = browser({ saved: "granted", href: "https://ownhow.dev/?ownhow-consent=denied", faults: { history: true } });
  b.click("allow");
  noAnalytics(b);
  assert.equal(b.storage.get(KEY), "denied");
});

test("storage failure on repeated opt-in also terminates an attempted tag", () => {
  const faults = {};
  const b = browser({ saved: "granted", faults });
  faults.write = true;
  b.click("allow");
  assert.equal(b.window[`ga-disable-${TEST_ONLY_ID}`], true);
  assert.match(b.window.location.href, /ownhow-consent=denied/);
  noAnalytics(browser({ saved: "granted", href: b.window.location.href }));
});

test("rejection without a tag but with broken storage navigates into refused state", () => {
  const b = browser({ faults: { write: true } });
  b.click("reject");
  assert.match(b.window.location.href, /ownhow-consent=denied/);
  noAnalytics(browser({ saved: "granted", href: b.window.location.href }));
});

test("already-refused URL with inaccessible storage uses a controlled reload", () => {
  const b = browser({ saved: "granted", faults: { access: true }, href: "https://ownhow.dev/?ownhow-consent=denied" });
  b.click("reject");
  assert.deepEqual(b.steps.at(-1), ["reload", b.window.location.href]);
  noAnalytics(b);
});

test("cross-tab denial/removal and consent lost during load trigger safe withdrawal", () => {
  for (const value of ["denied", null, "corrupt"]) {
    const b = browser({ saved: "granted" });
    if (value === null) b.storage.delete(KEY); else b.storage.set(KEY, value);
    b.storageEvent(value === null ? null : KEY);
    assert.match(b.window.location.href, /ownhow-consent=denied/);
    assert.equal(b.window[`ga-disable-${TEST_ONLY_ID}`], true);
  }
  const b = browser({ saved: "granted" });
  b.storage.set(KEY, "denied"); b.tags[0].onload();
  assert.equal(b.commands.length, 0);
  assert.equal(b.window[`ga-disable-${TEST_ONLY_ID}`], true);
});

test("CSP permits only exact tag/collection origins and preserves security headers", () => {
  const policy = headers.match(/Content-Security-Policy: (.+)/)[1];
  const directives = new Map(policy.split(";").map((part) => part.trim().split(/\s+/)).map(([name, ...values]) => [name, values]));
  assert.deepEqual(directives.get("default-src"), ["'none'"]);
  assert.deepEqual(directives.get("script-src"), ["'self'", "https://www.googletagmanager.com"]);
  const collection = ["https://www.google-analytics.com", "https://region1.google-analytics.com"];
  assert.deepEqual(directives.get("connect-src"), collection);
  assert.deepEqual(directives.get("img-src"), ["'self'", "data:", ...collection]);
  assert.deepEqual(directives.get("style-src"), ["'self'"]);
  for (const name of ["base-uri", "form-action", "frame-ancestors"]) assert.deepEqual(directives.get(name), ["'none'"]);
  assert.ok(directives.has("upgrade-insecure-requests"));
  assert.doesNotMatch(policy, /unsafe-|\*|https:(?:\s|;|$)|doubleclick|googleadservices|analytics\.google/);
  for (const line of ["X-Content-Type-Options: nosniff", "X-Frame-Options: DENY", "Referrer-Policy: strict-origin-when-cross-origin", "Permissions-Policy: camera=(), microphone=(), geolocation=(), payment=(), browsing-topics=()", "Strict-Transport-Security: max-age=31536000"]) assert.ok(headers.includes(line));
  const b = browser(); b.click("allow"); b.vendor(); b.tags[0].onload();
  for (const request of b.requests) {
    const directive = request.kind === "script" ? "script-src" : "connect-src";
    assert.ok(directives.get(directive).includes(new URL(request.url).origin));
  }
});

test("actual HTML has accessible persistent controls and no pre-consent resource hints", () => {
  assert.match(html, /<details id="analytics-settings" open>/);
  assert.match(html, /<summary>Statistics settings/);
  for (const name of ["allow", "reject"]) assert.match(html, new RegExp(`<button id="analytics-${name}" type="button">[^<]+<`));
  assert.match(html, /id="analytics-status" role="status" aria-live="polite"/);
  assert.match(html, /href="#website-privacy"/);
  assert.match(html, /<noscript>/);
  assert.match(html, /<!--email_off-->/); assert.match(html, /<!--\/email_off-->/);
  assert.match(html, /Telemetry off by default/);
  assert.deepEqual([...html.matchAll(/<script\b([^>]*)>/g)].map((m) => m[1].trim()), ['src="/analytics-config.js" defer', 'src="/analytics.js" defer']);
  assert.doesNotMatch(html, /\bon[a-z]+\s*=|rel="(?:preconnect|dns-prefetch|preload)"|<(?:img|iframe)\b[^>]*https:/i);
  assert.match(html, /<link rel="canonical" href="https:\/\/ownhow.dev\/">/);
});

test("XML sitemap has exactly the canonical root; robots advertises it; 404 is script-free", async () => {
  // The intentionally tiny document has one exact valid XML representation.
  // A separate recorded Python ElementTree parse provides parser validation;
  // this test remains usable where Node child-process spawning is restricted.
  assert.equal(await read("site/sitemap.xml"), '<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n  <url><loc>https://ownhow.dev/</loc></url>\n</urlset>\n');
  assert.equal(await read("site/robots.txt"), "User-agent: *\nAllow: /\n\nSitemap: https://ownhow.dev/sitemap.xml\n");
  const notFound = await read("site/404.html");
  assert.match(notFound, /name="robots" content="noindex"/);
  assert.match(notFound, /href="\/"/);
  assert.doesNotMatch(notFound, /<script|http-equiv="refresh"|rel="canonical"/);
});

test("optional verification meta injection is bounded, repeatable, removable and omitted on the shipped homepage", () => {
  assert.doesNotMatch(html, /name="(?:google-site-verification|msvalidate\.01)"/);
  const input = { googleSiteVerification: "TEST_FIXTURE_ONLY_not_provider_issued", bingSiteVerification: "A".repeat(32), measurementId: TEST_ONLY_ID };
  const rendered = renderSiteConfiguration(input, html);
  assert.match(rendered.html, /name="google-site-verification" content="TEST_FIXTURE_ONLY_not_provider_issued"/);
  assert.match(rendered.html, /name="msvalidate.01"/);
  assert.equal(renderSiteConfiguration(input, rendered.html).html, rendered.html);
  assert.equal(renderSiteConfiguration({}, rendered.html).html, html);
  const outside = (text) => text.replace(/<!-- ownhow-verification:start -->[\s\S]*?<!-- ownhow-verification:end -->/, "");
  assert.equal(outside(rendered.html), outside(html));
  const context = vm.createContext({ window: {} });
  vm.runInContext(rendered.config, context);
  assert.equal(context.window.ownhowAnalytics.measurementId, TEST_ONLY_ID);
});

test("supplied Bing root file preserves exact approved bytes without exposing its value", async () => {
  const bytes = await readFile(new URL("../site/BingSiteAuth.xml", import.meta.url));
  assert.equal(bytes.length, 85);
  assert.equal(createHash("sha256").update(bytes).digest("hex"), "78ddef22f98d82405aeb4bf5eef4ae1a7f7dfd0ea206e48393741fbe782ad0c9");
});

test("configuration rejects traversal, HTML/script injection, API keys and malformed objects", () => {
  for (const input of [null, [], "text", { path: "../x" }, { apiKey: "secret" }, { measurementId: "G-TESTONLY00\n" },
    { googleSiteVerification: '\"><script src="evil"></script>' }, { googleSiteVerification: "../x" },
    { googleSiteVerification: "x".repeat(257) }, { bingSiteVerification: "../x" }, { bingSiteVerification: "G".repeat(32) },
    { measurementId: { toString: "bad" } }, JSON.parse('{"__proto__":"bad"}')]) {
    assert.throws(() => renderSiteConfiguration(input, html));
  }
  assert.throws(() => renderSiteConfiguration({}, html + "<!-- ownhow-verification:start -->"));
  assert.throws(() => renderSiteConfiguration({}, html.replace("<!-- ownhow-verification:end -->", "")));
});

test("site module boundaries preserve the independent CLI telemetry default", async () => {
  for (const text of [source, config]) assert.doesNotMatch(text, /\b(?:import|require|fetch|XMLHttpRequest|sendBeacon)\b|src\/|telemetry\.js/);
  const directory = await mkdtemp(join(tmpdir(), "ownhow-site-cli-boundary-"));
  try {
    assert.equal((await loadTelemetryConfig(directory)).mode, "off");
    assert.deepEqual(await readdir(directory), []);
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});

test("bilingual disclosure qualifies enhanced interactions and scopes reported property facts", async () => {
  assert.ok(html.includes("It measures page visits, technical/device information and, where applicable, interactions such as scrolling, outbound link clicks, site searches, video engagement, file downloads and form interactions; Google may set first-party analytics cookies."));
  assert.ok(html.includes("统计页面访问、技术／设备信息，以及适用时的滚动、出站链接点击、站内搜索、视频互动、文件下载和表单互动，可能设置第一方统计 Cookie。"));
  const docs = (await read("docs/landing-deploy.md")).replace(/\s+/g, " ");
  for (const fact of [
    "makes one explicit `page_view` call, with `send_page_view:false` on that config call",
    "That explicit call uses the canonical homepage location and an empty referrer",
    "`allow_google_signals:false` and `allow_ad_personalization_signals:false`",
    "do not disable property Enhanced Measurement, prove property-wide advertising settings, or bound all vendor-generated events and parameters",
    "According to COO's read-only property check on 2026-11-18 13:15 SGT",
    "Enhanced Measurement was enabled for page views, scrolls, outbound link clicks, site search, video engagement, file downloads and form interactions",
    "Signals was not enabled; Ads links/requests were 0",
    "regional advertising personalization was allowed in 307/307 regions",
    "That regional permission does not mean Ads is running or this page's tag personalization is enabled",
    "no independent console sign-in was performed",
    "An enabled category is not proof that it fired on this page",
    "Local fakes do not establish actual vendor collection, event counts, or sanitization of automatically generated event parameters"
  ]) assert.ok(docs.includes(fact), fact);
  assert.doesNotMatch(docs, /settings still need COO confirmation|must also check that enhanced measurement/);
});

const PREVIEW_MARKERS = {
  debug_mode: true,
  campaign_name: "ownhow_preview_validation",
  campaign_source: "ownhow_pages_preview",
  campaign_medium: "qa"
};

function previewMarkers(options, expected) {
  for (const [key, value] of Object.entries(PREVIEW_MARKERS)) {
    assert.equal(Object.hasOwn(options, key), expected, key);
    if (expected) assert.equal(options[key], value, key);
  }
}

test("controlled OwnHow branch alias configures static markers after shipped-ID consent and before append", () => {
  for (const host of ["fix-ownhow-search-consent-20.ownhow.pages.dev",
    "FIX-OWNHOW-SEARCH-CONSENT-20.OWNHOW.PAGES.DEV"]) {
    const href = `https://${host}/?utm_source=private-source&utm_campaign=private-campaign#private-fragment`;
    for (const mode of ["immediate", "legacy"]) {
      const b = browser({ shippedConfig: true, href });
      noAnalytics(b);
      b.click("allow"); b.click("allow"); b.init();
      assert.equal(b.storage.get(KEY), "granted");
      assert.deepEqual(b.requests, [{ kind: "script", url: `https://www.googletagmanager.com/gtag/js?id=${SHIPPED_ID}` }]);
      assert.deepEqual(b.steps.find(([kind]) => kind === "append")[1], ["set", "js", "config", "event"]);
      const queue = Array.from(b.window.dataLayer, (args) => Array.from(args));
      const appendedQueue = b.steps.find(([kind]) => kind === "append")[2];
      previewMarkers(appendedQueue[0][1], true);
      previewMarkers(appendedQueue[2][2], true);
      previewMarkers(queue[0][1], true);
      assert.equal(queue[2][1], SHIPPED_ID);
      previewMarkers(queue[2][2], true);
      assert.equal(queue[0][1].send_page_view, false);
      assert.equal(queue[2][2].send_page_view, false);
      // Event scope supplies only the unchanged URL/referrer overrides; it does
      // not override the config/global markers inherited by other page events.
      assert.deepEqual(Object.keys(queue[3][2]).sort(), ["page_location", "page_referrer"]);
      assert.doesNotMatch(JSON.stringify(queue), /private-|utm_|pages\.dev/);
      const sdk = b.vendor({ mode });
      previewMarkers(b.initializations[0], true);
      const commands = b.commands.length;
      b.tags[0].onload(); b.tags[0].onload(); b.click("allow"); b.init();
      assert.equal(b.commands.length, commands);
      assert.equal(b.commands.filter(([type]) => type === "config").length, 1);
      assert.equal(b.commands.filter(([type, name]) => type === "event" && name === "page_view").length, 1);
      assert.equal(b.requests.filter(({ kind }) => kind === "collection").length, 1);
      sdk.enhancedEvent("scroll");
      for (const request of b.requests.filter(({ kind }) => kind === "collection")) {
        previewMarkers(request.parameters, true);
        assert.equal(request.parameters.page_location, "https://ownhow.dev/");
        assert.equal(request.parameters.page_referrer, "");
      }
      assert.equal(b.requests.filter(({ event }) => event === "page_view").length, 1);
      b.click("reject");
      const requestCount = b.requests.length;
      sdk.enhancedEvent("scroll"); b.window.gtag("event", "page_view");
      assert.equal(b.requests.length, requestCount);
      noAnalytics(browser({ shippedConfig: true, storage: b.storage, href: b.window.location.href }));
    }
  }
});

test("production and lookalike hosts omit every preview field even with marker-like queries", () => {
  for (const host of ["ownhow.dev", "www.ownhow.dev", "ownhow.pages.dev", "other.pages.dev",
    "fix-ownhow-search-consent-20261118.ownhow.pages.dev",
    "FIX-OWNHOW-SEARCH-CONSENT-20261118.OWNHOW.PAGES.DEV",
    "a.ownhow.pages.dev", "ab12cd34.ownhow.pages.dev", "feature-search.ownhow.pages.dev",
    `${"a".repeat(63)}.ownhow.pages.dev`, "FEATURE.OWNHOW.PAGES.DEV",
    "feature.other.pages.dev", "ownhow.pages.dev.evil.example", "feature.ownhow.pages.dev.evil.example",
    "nested.feature.ownhow.pages.dev", "feature-ownhow.pages.dev", "notownhow.pages.dev",
    "feature.ownhowpages.dev", "feature.ownhow.pages.dev.", "-feature.ownhow.pages.dev",
    "feature-.ownhow.pages.dev", "feature_name.ownhow.pages.dev", `${"a".repeat(64)}.ownhow.pages.dev`,
    "localhost", "127.0.0.1", "[::1]"]) {
    const b = browser({ shippedConfig: true, saved: "granted",
      href: `https://${host}/?debug_mode=true&utm_campaign=ownhow_preview_validation&preview=feature.ownhow.pages.dev` });
    for (const args of b.window.dataLayer) {
      const options = args[0] === "set" ? args[1] : args[2];
      if (options && typeof options === "object") previewMarkers(options, false);
    }
    b.vendor(); b.tags[0].onload();
    previewMarkers(b.initializations[0], false);
    const views = b.requests.filter(({ kind }) => kind === "collection");
    assert.equal(views.length, 1);
    previewMarkers(views[0].parameters, false);
  }
  const b = browser({ shippedConfig: true, saved: "granted", href: "https://feature.ownhow.pages.dev@evil.example/" });
  previewMarkers(b.window.dataLayer[0][1], false);
  previewMarkers(b.window.dataLayer[2][2], false);
});

test("only the exact controlled alias is marked, never production or arbitrary deployment hashes", () => {
  const alias = "fix-ownhow-search-consent-20.ownhow.pages.dev";
  const cases = [
    [`https://${alias}/`, true],
    [`https://${alias.toUpperCase()}:443/`, true],
    ["https://fix-ownhow-search-consent-20261118.ownhow.pages.dev/", false],
    ["https://80fca87a.ownhow.pages.dev/", false],
    ["https://deadbeef.ownhow.pages.dev/", false],
    ["https://0123456789abcdef.ownhow.pages.dev/", false],
    ["https://main.ownhow.pages.dev/", false],
    ["https://unknown.ownhow.pages.dev/", false],
    ["https://fix-another-branch.ownhow.pages.dev/", false],
    [`https://nested.${alias}/`, false],
    [`https://${alias}.evil.example/`, false],
    [`https://${alias}./`, false],
    [`https://${alias}@evil.example/`, false],
    [`https://ownhow.dev/?preview=${alias}&debug_mode=true`, false]
  ];
  for (const [href, marked] of cases) {
    const b = browser({ shippedConfig: true, saved: "granted", href });
    const appendedQueue = b.steps.find(([kind]) => kind === "append")[2];
    assert.deepEqual(appendedQueue.map(([type]) => type), ["set", "js", "config", "event"], href);
    previewMarkers(appendedQueue[0][1], marked);
    assert.equal(appendedQueue[2][1], SHIPPED_ID);
    previewMarkers(appendedQueue[2][2], marked);
    assert.equal(appendedQueue[0][1].send_page_view, false);
    assert.equal(appendedQueue[2][2].send_page_view, false);
    assert.doesNotMatch(JSON.stringify(appendedQueue), /pages\.dev|evil\.example|debug_mode=true/);
    const sdk = b.vendor();
    b.tags[0].onload(); b.click("allow"); b.init();
    previewMarkers(b.initializations[0], marked);
    sdk.enhancedEvent("scroll");
    assert.equal(b.requests.filter(({ kind }) => kind === "script").length, 1);
    assert.equal(b.requests.filter(({ event }) => event === "page_view").length, 1);
    for (const request of b.requests.filter(({ kind }) => kind === "collection")) {
      previewMarkers(request.parameters, marked);
      assert.equal(request.page_location, "https://ownhow.dev/");
      assert.equal(request.parameters.page_referrer, "");
    }
  }
});

test("preview markers retain no-choice/deny/invalid-config/storage and pending withdrawal guards", () => {
  const href = "https://fix-ownhow-search-consent-20.ownhow.pages.dev/";
  for (const saved of [undefined, "denied", "corrupt"]) {
    const b = browser({ shippedConfig: true, href, saved });
    noAnalytics(b); b.click("reject"); noAnalytics(b);
    noAnalytics(browser({ shippedConfig: true, href: b.window.location.href, storage: b.storage }));
  }
  for (const faults of [{ access: true }, { read: true }, { write: true }, { writeNoop: true }]) {
    const b = browser({ shippedConfig: true, href, faults });
    noAnalytics(b); b.click("allow"); noAnalytics(b);
  }
  for (const id of ["", "G-invalid"]) {
    const b = browser({ href, saved: "granted", id });
    b.click("allow"); noAnalytics(b);
  }
  for (const fault of [null, "write", "read", "access", "cookies"]) {
    const faults = {};
    const b = browser({ shippedConfig: true, href, saved: "granted", faults });
    previewMarkers(b.window.dataLayer[2][2], true);
    const lateLoad = b.tags[0].onload, lateError = b.tags[0].onerror;
    if (fault) faults[fault] = true;
    b.click("reject");
    assert.equal(b.window.dataLayer.length, 0);
    b.vendor(); lateLoad(); lateError(); b.window.gtag("event", "page_view");
    assert.equal(b.commands.length, 0);
    assert.equal(b.initializations.length, 0);
    assert.equal(b.requests.length, 1);
    assert.equal(b.window[`ga-disable-${SHIPPED_ID}`], true);
    noAnalytics(browser({ shippedConfig: true, href: b.window.location.href, saved: "granted" }));
  }
});
