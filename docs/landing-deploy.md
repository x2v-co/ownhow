# OwnHow landing page: configuration and deployment

The public site is the static `site/` directory, canonical at
`https://ownhow.dev/`. No build step, npm dependencies, framework, or external fonts
are needed. Two same-origin deferred scripts provide optional, consent-gated GA4.
Website choices are separate from the CLI: CLI telemetry remains off by default.

## Existing deployment and current boundary

Read-only deployment facts supplied for this candidate: Pages project `ownhow`,
custom domain `ownhow.dev`, assigned hostname `ownhow.pages.dev`, production branch
`main`, source `null` (Direct Upload). The canonical deployment is
`80fca87a-e5c4-49ef-96d4-dc3f97b9fe66`, bound to `7d90742`, at
2026-10-19 17:31:54 SGT. The existing project does not need to be recreated.

Workflow `.github/workflows/pages.yml` is intended to upload `site/` using
`cloudflare/wrangler-action@v4` (`pages deploy site --project-name=ownhow`) on
`site/**` pushes to main or manual dispatch. Workflow run `39230736495` reported
success but checkout, setup, and deploy were **skipped** by the credential guard;
that is not evidence of an upload. Credential setup, publishing identity, DNS,
and any future upload remain separate work. This candidate is local source and
tests only; it has not been published. An earlier frozen local candidate was
tested with the real tag; the fixes below still need a new browser capture.

For a later authorized upload, the contents of `site/` must be the upload root,
including `_headers`, `404.html`, `sitemap.xml`, and `BingSiteAuth.xml`. Cloudflare applies `_headers`
to static responses. Keep automatic Cloudflare analytics/script injection and
other trackers disabled so they cannot bypass the website consent gate.
See [Direct Upload](https://developers.cloudflare.com/pages/get-started/direct-upload/)
and [headers](https://developers.cloudflare.com/pages/configuration/headers/).

## Public GA4 configuration

`site/analytics-config.js` contains the owner-supplied public measurement ID
`G-LD3NXHS35B`, relayed by the parent from COO. It is not a credential or proof of
collection. Neither an allow click nor a previously saved grant loads GA4 with a
blank/malformed ID. The loader accepts only `G-` plus ten uppercase ASCII
letters/digits. Do not place
an API key, secret, fabricated property, or test ID in production source.

Use `node scripts/configure-site.js` with one complete JSON object on **stdin**.
The only permitted fields are `measurementId`, `googleSiteVerification`, and
`bingSiteVerification`. Missing or empty fields clear the corresponding public
configuration. Use actual provider values, review the resulting source diff, and
keep private input files outside the public directory. An empty configuration is:

```json
{"measurementId":"","googleSiteVerification":"","bingSiteVerification":""}
```

The helper writes only the fixed `site/analytics-config.js` and the marked meta
region of `site/index.html`. It validates all input before writing, accepts no
paths or HTML, and rejects unknown fields and unsafe characters. It does not
create accounts/properties or contact providers. There is no automatic injection
in the deployment workflow. It does not modify the separate Bing root file.
Re-run the focused site tests after configuration. Current property settings and
their limitations are recorded below; this task does not inspect or change Google
consoles or permissions.

## Preview markers and reversible reporting exclusion

The same real stream is used on previews. Canonical `page_location` and empty
`page_referrer` remain unchanged, so a preview hostname or URL UTM alone is not
evidence of separable traffic. No documented no-source alternative in the supplied
evidence establishes both campaign attribution under those overrides and coverage
of applicable enhanced events. DebugView alone is not an attribution report.

Only the exact normalized hostname
**fix-ownhow-search-consent-20261118.ownhow.pages.dev** gets these static
parameters after saved consent: `debug_mode:true`,
`campaign_name:ownhow_preview_validation`,
`campaign_source:ownhow_pages_preview`, and `campaign_medium:qa`.
This is the controlled alias for the nonmain branch
`fix/ownhow-search-consent-20261118`: Cloudflare documents lowercasing branch
names and replacing nonalphanumeric characters with hyphens
([preview aliases](https://developers.cloudflare.com/pages/configuration/preview-deployments/)).
It is a contract for the upcoming upload, not proof an alias/deployment already
exists. URL hostname normalization handles case; ports do not change the host.
Every other host omits all four fields, including `ownhow.dev`, bare
`ownhow.pages.dev`, the known production hash `80fca87a.ownhow.pages.dev`, all
future/arbitrary deployment hashes (even genuine preview hashes), `main`, unknown
labels and other branch aliases. Nested aliases, lookalike suffixes, other Pages
projects, arbitrary local hosts and userinfo/query switches do not qualify.
`debug_mode` is omitted entirely on those hosts, never set to false. Marker
values do not include the preview label, URL, query, fragment or referrer.

These options enter both the existing global `set` and stream `config` before
script insertion, following successful consent persistence. They are settings
for page events, including applicable Enhanced Measurement, rather than markers
on only the explicit view. Event scope outranks config, which outranks global
set; the explicit view overrides only location/referrer, leaving marker settings
inherited. Remote vendor/UI behavior still needs payload verification. See
[campaign configuration](https://developers.google.com/analytics/devguides/collection/ga4/reference/config),
[parameter precedence](https://developers.google.com/tag-platform/gtagjs/reference#parameter_precedence)
and [debug configuration](https://support.google.com/analytics/answer/7201382?hl=en).

For the later separately authorized preview capture, the upload must use exact
branch metadata `fix/ownhow-search-consent-20261118`. Before browser consent,
verify the deployment receipt has `environment=preview`, that exact branch, the
exact controlled alias in its alias list, and the exact frozen candidate source
bytes. Recheck that the alias response serves that candidate: branch aliases are
mutable, and normalization collisions or later uploads could change their target.
If receipt or alias/source binding is unproven, **stop GUI validation**; do not
fall back to a deployment hash URL or widen matching. No upload, DNS, alias or
receipt verification has occurred in this local task.

1. Use a fresh isolated browser profile/session exclusively at
   `https://fix-ownhow-search-consent-20261118.ownhow.pages.dev/`, never the
   deployment hash, for marked validation. Record the exact preview host,
   verified deployment/source binding, and actual start/end timestamps in
   Asia/Singapore (SGT, UTC+08:00). No test window is claimed here.
   Avoid mixing production visits into that session. Inspect real request
   parameters and applicable enhanced events for the fixed markers, unchanged
   canonical location/referrer, and existing consent/withdrawal behavior.
2. After reporting data is available, use Traffic acquisition with **Session
   campaign** exactly `ownhow_preview_validation`; cross-check **Session source**
   `ownhow_pages_preview`, **Session medium** `qa`, or **Session source / medium**
   `ownhow_pages_preview / qa`. First include the cohort to establish that the
   actual session was attributed as intended. Keep the recorded SGT window and
   report date/time-zone boundaries alongside the comparison. DebugView can help
   inspect debug events, but does not prove those acquisition dimensions.
3. For a comparison excluding previews, apply an **exclude** report filter (or
   exploration exclusion) for that exact Session campaign and compare with the
   unfiltered view. Remove the filter/exclusion to restore that view. Only the
   selected report/exploration changes; other views and raw property data are
   not cleaned or deleted. The fixed campaign identifies a preview cohort, not
   an individual deployment; correlate deployments using the external run log.

Attribution scope, processing delays and existing session history can affect
results: session exclusions exclude the associated sessions, not a proven
event-by-event production/test partition. Confirm the actual cohort before using
the comparison. References: [Traffic acquisition](https://support.google.com/analytics/answer/12923437?hl=en)
and [manual campaign dimensions](https://support.google.com/analytics/answer/11242870?hl=en).
Treat raw data/unfiltered totals as containing preview test traffic. Debug mode
does not itself exclude it. COO reports only Internal Traffic in Testing, with
no Developer filter; this task creates/activates none. An active developer-data
exclusion is a different, permanent collection-processing choice, outside scope:
[developer traffic filters](https://support.google.com/analytics/answer/13296662?hl=en).
Actual vendor/browser and backend reporting acceptance remains incomplete.

## Website privacy and withdrawal

The landing page contains bilingual disclosure and always reachable native
statistics controls, linked from the footer. No choice, refusal, corrupt values,
and unavailable storage all block third-party statistics. A grant must be saved
and read back successfully before a valid ID can cause one tag request. Grants
persist in localStorage as `ownhow.website-statistics.v1`; refusal can later be
changed explicitly. No preconnect, pixel, analytics queue, or denied-consent ping
is sent before grant. There is no Consent Mode request before grant.

After saved consent, before inserting the vendor script, this bootstrap queues
global `set` parameters before `js`, then configures one property and makes one
explicit `page_view` call, with `send_page_view:false` on that config call. That
explicit call uses the canonical homepage location and an empty referrer. The
bootstrap adds no custom interaction tracking or User-ID, sets
`allow_google_signals:false` and `allow_ad_personalization_signals:false`, and adds
no Ads tags. These tag settings and the explicit-call count do not disable
property Enhanced Measurement, prove property-wide advertising settings, or bound
all vendor-generated events and parameters.
The same settings are supplied globally before initialization and in the legacy
config call: the vendor may initialize before `onload` and without waiting for
config. `onload` only checks consent and updates status; it sends no events.
Withdrawal and script load failure discard pending commands and disable our
wrapper. No automatic retry occurs in that document. See Google's
[initialization modes](https://support.google.com/analytics/answer/18411054),
[global parameters](https://developers.google.com/tag-platform/gtagjs/reference#set)
and [default page-view suppression](https://developers.google.com/tag-platform/security/guides/privacy#turn_off_default_page_view_measurement_in_google_analytics).

According to COO's read-only property check on 2026-11-18 13:15 SGT, Enhanced
Measurement was enabled for page views, scrolls, outbound link clicks, site search,
video engagement, file downloads and form interactions; Signals was not enabled;
Ads links/requests were 0, while regional advertising personalization was allowed
in 307/307 regions. That regional permission does not mean Ads is running or this
page's tag personalization is enabled. No backend settings were changed in this
task, and no independent console sign-in was performed. After consent, Google may
generate applicable enhanced and standard session/first-visit events and collect
technical/device information. An enabled category is not proof that it fired on
this page. Local fakes do not establish actual vendor collection, event counts,
or sanitization of automatically generated event parameters; verify these
separately in the real browser capture.

Withdrawal first attempts to save refusal, then invalidates pending callbacks,
blocks our gtag wrapper, sets `ga-disable-<ID>`, and attempts to expire exact
root-path cookie names: `ownhow_ga`, `ownhow_ga_<measurement suffix>`, `_ga`, and
`_ga_<measurement suffix>`. The default names were observed with the earlier
candidate despite its late prefix config. Cleanup tries host-only and
current-host Domain scopes, never ancestor domains, other paths or other stream
suffixes; a refused new document repeats this cleanup for late cookie writes.
The shared `_ga` name is included because this site's real tag used it; its name
cannot identify which application originally wrote a shared same-host cookie.
Unrelated cookie names and other stream cookies are preserved. Cookie
access/deletion is best effort. Google documents
[cookie defaults and prefixes](https://developers.google.com/tag-platform/security/guides/customize-cookies).
If the tag was requested, a controlled navigation/reload terminates the live
vendor document. A refusal parameter (`ownhow-consent=denied`) protects that next
URL and refresh even if writing localStorage failed. Deliberate opt-in removes
the parameter before loading. If storage later recovers an older grant, visiting
a clean URL may expose that grant; clear site data to remove it. If scripts,
navigation, or the browser itself fail, reload/close the page with the refused URL
to terminate vendor execution. A removed tag or GA disable flag alone is not a
claim that already-running vendor code has stopped. Previously collected data
and in-flight requests cannot be undone by this control.

## Restrictive CSP and pending browser acceptance

`_headers` retains default denial and the existing non-CSP security headers.
`script-src` allows self and exactly `https://www.googletagmanager.com` for the
single `gtag/js?id=...` request. `connect-src` allows exactly
`https://www.google-analytics.com` and `https://region1.google-analytics.com`;
those two origins are also allowed for collection-image fallback. The existing
same-origin stylesheet/data favicon remain allowed. There are no wildcards,
inline/eval exceptions, Ads/DoubleClick endpoints, or scheme-wide HTTPS grants.
These origins are permissions, not requests: blank config and refusal use none.

This deliberately narrow policy is **not proof that live GA4 works**. A real-ID
browser capture may reveal CSP-blocked vendor behavior or different regional
collection hosts. Review actual requests at the separate GUI gate; do not widen
hosts speculatively. Reference: [Google tag CSP guidance](https://developers.google.com/tag-platform/security/guides/csp).
A basic local file server does not apply Pages `_headers` or Pages route behavior.
Use the later GUI task's header-aware static fixture and request capture.
The earlier frozen candidate's capture recorded two initial page views (local
and canonical URLs), a scroll event, successful collection HTTP 204s, and blocked
tag-initiated `www.googletagmanager.com/a?...` requests. The recorded truncated
queries do not establish `/a`'s purpose or necessity. It remains blocked by the
unchanged image/connect policy; no host was added just to clear console errors.
The local DevTools `.well-known` probe and Permissions-Policy warnings are
separate observations. HTTP 204 is not backend receipt proof. Repeat the real
capture to assess startup settings, initial page views and cookie removal; the
local fake cannot establish the vendor's actual initialization mode or UI
overrides. The observed enhanced scroll is not itself a duplicate-view defect.

## Search discovery and ownership verification

`sitemap.xml` is XML and contains only `https://ownhow.dev/`; no anchors, invented
pages, or guessed modification dates. `robots.txt` advertises its absolute URL.
The top-level `404.html` disables Pages' default SPA homepage fallback, including
for unknown verification files. See [Pages serving behavior](https://developers.cloudflare.com/pages/configuration/serving-pages/).
A local file's presence does not establish deployed status codes: later verify
unknown paths and nonexistent verification files return a real 404 rather than
homepage HTML 200, and sitemap is XML with an appropriate content type.

The helper supports GSC URL-prefix `google-site-verification` and Bing
`msvalidate.01` meta tags with actual provider-supplied public values. Google
values accept letters, digits, underscore and hyphen (up to 256 characters);
Bing values accept 32 hexadecimal characters. No verification meta is injected:
COO reports GSC DNS verification, which is not independent console proof here,
and no GSC meta/file or DNS change is needed. URL-prefix meta does **not** verify
a GSC Domain property.

The supplied `site/BingSiteAuth.xml` is an exact 85-byte copy of the approved
provider file, SHA-256
`78ddef22f98d82405aeb4bf5eef4ae1a7f7dfd0ea206e48393741fbe782ad0c9`.
Its value is intentionally not reproduced in docs or test output. No operational
note or Bing API key is published. Root file generation is not implemented; keep
the supplied original bytes. Later validate `/BingSiteAuth.xml` returns HTTP 200,
an XML content type, and exactly that body hash, while nonexistent files return
404. Check exact URLs and redirects for any future provider files: Pages may
normalize `.html` paths. Local file checks do not establish Bing verification.

## Local validation and later upload checks

Run `node --test test/site.test.js` and explicit `node --check` for both shipped
scripts and the configuration helper. The site tests execute the shipped scripts
in a no-network DOM/storage/vendor fixture; they do not model a complete browser
or Google implementation. Existing CLI tests and checks remain unchanged. The
coordinator runs the normal-shell full `npm run verify` separately.

Later browser acceptance must use the actual shipped markup, scripts, and
security headers and the supplied ID under separate network authorization.
Also check an isolated blank-config copy to retain the fail-closed acceptance
case. Check desktop/mobile controls, keyboard focus,
request initiators, deny/refresh, allow once, load failures/races, cross-tab
refusal, and withdrawal/reload with unavailable storage/cookies. Preserve install
commands, SEO/canonical metadata, Chinese copy, and Cloudflare email-off markers.
Neither local test success nor workflow status establishes a live deployment,
search verification, or analytics collection.
