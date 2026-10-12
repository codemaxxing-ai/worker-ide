# Hosted content isolation

The editor, authentication and management API use `APP_ORIGIN` (`https://codemaxxing.app`). Browser-executable project documents, assets and generated responses use flat signed origins under `CONTENT_ORIGIN` (`https://codemaxxing.net`):

```text
https://<project-id>-<token>.codemaxxing.net
```

`shared/domain.ts` classifies exact configured HTTPS origins. Only the editor origin, `git.<editor-host>`, content apex and valid signed project hosts route. Unknown hosts return 404. The content apex is a static hosting-information response. The previous hosting domain has no compatibility routes. Tokens retain the current/previous hourly bucket lifetime (one to two hours). A new signed host also creates a new browser storage origin.

## Trust boundaries

Project content is untrusted, including the generated server handler. Authentication runs before generated code. Deleted or banned projects and organizations cannot serve previews. Cookies and authorization headers are removed before either React SPA or vinext generated code runs. Generated cookies, CORS grants, service-worker permissions and platform-header overrides are removed from responses.

A private preview has one host-only cookie, `__Host-worker-ide-preview-access`, with `Secure; HttpOnly; Path=/; SameSite=None; Partitioned`, and no `Domain`. A 60-second signed grant redeems through `/__preview-auth/redeem`; `/__preview-auth/check` verifies that the browser accepted the cookie before redirecting to the project path. The 55-minute cookie and grant bind the exact preview origin, project, organization, purpose and expiry. Authentication paths are reserved and never reach project handlers. Sharing a URL does not share an editor session. A standalone private preview navigates through the editor's top-level authentication bootstrap. Its partition is separate from the editor-embedded partition.

Iframe expiry messages require the current preview window and exact origin. The editor requests a new URL through Hono RPC. Failed cookie acceptance stops with an Open preview action; automatic retries are bounded. Browser settings that disable all cookies cannot authenticate private previews. Browsers must support partitioned cookies for reliable private iframe access; unsupported browsers can use the standalone action.

Browser fetches and unsafe requests from other origins, including same-site sibling projects, are rejected before generated handlers. WebSocket handshakes require the exact preview origin. Safe document and iframe navigations remain available; the exact editor `frame-ancestors` CSP enforces the embedding boundary when navigation carries no origin/referrer. No CORS grants are exposed. Subresources use `Cross-Origin-Resource-Policy: same-origin`.

The same platform response policy covers both runtimes, assets and error pages: `nosniff`, `no-referrer`, `noindex`, origin-agent clustering, disabled `document.domain`, and `Cache-Control: no-store`. HTML uses `COOP: same-origin`, exact editor `frame-ancestors`, no nested frames/plugins, same-origin forms/base URLs, HTTPS resource/API access, existing inline/eval code and ordinary Web Workers. Service-worker script requests are denied and editor/PWA assets are never passed through on content hosts. COEP remains unset so external resources and the opaque DevTools frontend work.

The editor iframe retains scripts, same-origin, forms, popups, modals and clipboard-write permissions, with no referrer. Picker, highlighting, console, errors, HMR, DevTools and embedded deep-link messages require exact source window and origin. Only delivery to the opaque sandboxed DevTools iframe uses a wildcard target; its inbound relay checks its exact window and opaque origin. Standalone error links open canonical editor URLs with `noopener,noreferrer`.

Authenticated source JSON, transcoded chat-image data and attachment-only ZIP downloads remain on the editor origin. They cannot execute as hosted project documents. Internal immutable build-artifact caching stays behind authorization; browser/edge responses are not shared-cacheable.

## Local development and validation

Run `mise install`, `mise exec -- bun install` and the local D1 migrations, then `mise exec -- bun run dev`. Docker is needed for the Computer runtime. The Vite basic SSL plugin caches a local certificate in ignored `.local-certificates/`, covering localhost, the content apex, signed flat content hosts and git.localhost. Use `https://localhost:3000` and accept the local certificate in a development browser. OAuth callback registrations must also use HTTPS. Remove `.local-certificates/` to regenerate certificates after changing development hostnames.

Node test clients trust the generated certificate while remote targets keep normal TLS verification. Playwright accepts local test certificates in its localhost contexts. The browser matrix runs Chromium, Firefox and WebKit against the built editor, retaining the live Worker's headers, APIs, authentication and hosted project runtimes. `test/fixtures/hostile-preview.ts` supplies hostile code to two separate projects; browser tests cover storage/DOM boundaries, sibling/editor access, credentials, ordinary/service workers, picker, private iframe/standalone flows and cookie rejection. Existing HMR suites cover both React SPA and vinext. Chromium and Firefox exercise private iframe redemption and automatic access renewal. The Linux WebKit test port rejects the third-party cookie, so its private-preview test requires the bounded Open preview fallback and verifies real top-level bootstrap access. This is not evidence of current macOS/iOS Safari behavior; verify private iframes in those supported browser versions during production rollout.

Run the required format, typecheck, Knip, unit, Worker, React, integration, E2E and Storybook checks through `mise exec -- bun …`. Test application isolation before PSL adoption separately from browser site isolation after adoption.

## Production cutover

1. In the existing Cloudflare account, activate `codemaxxing.net` and create proxied apex and `*` DNS records. For a Worker-only zone, use documentation-range placeholder A records (`192.0.2.1`) so unmatched routes do not reach a real origin. The normal zone wildcard certificate covers the flat hosts; verify the certificate is active before cutover. See [Cloudflare custom preview domain guidance](https://developers.cloudflare.com/sandbox/sdk/guides/preview-urls-custom-domain/).
2. Enable Always Use HTTPS for the content zone. Add a cache rule bypassing cache for `codemaxxing.net` and its subdomains, including assets, redirects and errors. Preserve internal authorized build-artifact caching. Remove redirects affecting the content apex or preview subdomains, including Single Redirects, Bulk Redirects and forwarding Page Rules. Disable any zone rules that override platform CORS/CSP or cache preview cookies. DNS/settings require zone administration permissions; CLI OAuth may not cover redirects, cache rules or zone settings.
3. Record the current production Worker version IDs, routes and DNS configuration before cutover. Verify the CI deployment token has Workers Routes Edit access to both zones and review pending D1 migrations. A successful push CI run on `main` automatically deploys through `.github/workflows/deploy.yml`, so prepare the infrastructure before merging. The authoritative `wrangler.jsonc` routes are the editor and Git custom domains, `*.codemaxxing.net/*`, and `codemaxxing.net/*`. Do not connect the new content routes to the old implementation. Deploy the single implementation using the repository deployment script. Remove the old preview Worker routes and DNS records in the `.app` zone during the same cutover; do not add redirects or compatibility cookies. Reload existing editor tabs after deployment; old preview links intentionally stop working.
4. Verify public and private iframe previews, standalone authentication, picker, DevTools, clipboard, error deep links, HMR and WebSocket connections against production in all three browsers. Confirm no edge cache hits, no app cookies on content requests, no generated Set-Cookie/CORS grants, unknown-host 404s and service-worker denial. Keep deploy status and this verification evidence in the release record.

If rollback is necessary, disable both `.net` Worker routes before restoring old code. The old host classifier does not enforce the new domain boundary. Restore the previous `.app` preview routes and DNS only when reverting the complete release. Worker rollback does not restore DNS, routes or database data; see [Cloudflare rollback guidance](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/). Review the saved versions of the auxiliary Workers if their deployment also changed.

## Future Public Suffix List milestone

Do not submit a PSL request at the current project size. `codemaxxing.net` is not assumed to be a public suffix. Until browsers adopt an entry, sibling previews can be same-site despite being different origins. User JavaScript can still create parent-domain cookies before adoption; those cookies confer no platform access and are stripped before generated handlers run. Host-only partitioned authentication, request rejection, CORP, CSP and messaging checks remain necessary independently of PSL.

When the hosting service meets the [PSL guidelines](https://github.com/publicsuffix/list/wiki/Guidelines):

1. Review current PRIVATE-section eligibility, demonstrated use/scale, domain ownership, registration lifetime and security rationale. Submit as a verified domain owner; do not submit on behalf of an unauthenticated third party.
2. Prepare a PRIVATE-section addition for `codemaxxing.net` in publicsuffix/list, with the service URL and responsible maintainer contact. Explain that unrelated users host applications on immediate signed subdomains. A literal entry is sufficient for the flat structure.
3. Once a PR exists, publish `_psl.codemaxxing.net` TXT containing the PR URL as required by the maintainers, verify it resolves publicly, and retain the verification record while the entry is listed. This repository does not create a PR or publish the TXT record now.
4. Record acceptance and upstream merge separately from application deployment. Track incorporation into Chromium, Firefox and WebKit releases; merge alone does not prove browser adoption.
5. In each supported browser version, verify sibling hosts are distinct sites, Domain=codemaxxing.net cookies are rejected, storage/credential isolation still holds, private iframe CHIPS and standalone bootstrap still work, and HMR/picker/DevTools remain functional. Record versions and dates. Keep server protections in place after adoption.
