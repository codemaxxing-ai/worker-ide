# Hosted content isolation

## Origins and routing

The editor, authentication, and management API use `APP_ORIGIN` (`https://codemaxxing.app`). Browser-executable project documents, assets, and generated responses use flat signed origins under `CONTENT_ORIGIN` (`https://codemaxxing.net`):

```text
https://<project-id>-<token>.codemaxxing.net
```

[shared/domain.ts](../shared/domain.ts) classifies exact configured HTTPS origins. Only the editor origin, `git.<editor-host>`, the content apex, and valid signed project hosts route. Unknown hosts return 404; the content apex serves static hosting information. Keep the allowlist exact rather than adding compatibility hosts on the editor domain. Tokens use the current/previous hourly bucket lifetime of one to two hours. A new signed host creates a new browser storage origin.

A separate content domain keeps user-controlled documents outside the editor's origin and cookie scope. Different project origins also separate DOM and storage access. Origin separation does not imply site separation; see [public suffix boundaries](#public-suffix-boundaries).

## Authentication and private previews

Project content is untrusted, including generated server handlers. Authentication runs before generated code. Deleted or banned projects and organizations cannot serve previews. Cookies and authorization headers are removed before either React SPA or vinext generated code runs. Generated cookies, CORS grants, service-worker permissions, and platform-header overrides are removed from responses.

A private preview has one host-only cookie, `__Host-worker-ide-preview-access`, with `Secure; HttpOnly; Path=/; SameSite=None; Partitioned` and no `Domain`. A 60-second signed grant redeems through `/__preview-auth/redeem`; `/__preview-auth/check` verifies cookie acceptance before redirecting to the project path. The 55-minute cookie and grant bind the exact preview origin, project, organization, purpose, and expiry. These authentication paths are reserved and never reach project handlers. Sharing a URL does not share an editor session.

Standalone private previews navigate through the editor's top-level authentication bootstrap. Their cookie partition is separate from the editor-embedded partition. Iframe expiry messages require the current preview window and exact origin; the editor obtains a new URL through Hono RPC.

Failed cookie acceptance stops with an Open preview action, and automatic retries are bounded. Browsers that disable all cookies cannot authenticate private previews. Reliable private iframe access requires partitioned-cookie support; the standalone action provides a separate navigation path.

The implementation boundaries are [preview-access.ts](../worker/lib/preview-access.ts), [the bootstrap routes](../worker/http/preview-access.ts), and [preview request handling](../worker/http/preview.ts). Keep authentication outside generated handlers and credentials scoped to their exact preview origin.

## Request, response, and messaging policy

Browser fetches and unsafe requests from other origins, including same-site sibling projects, are rejected before generated handlers. WebSocket handshakes require the exact preview origin. Safe document and iframe navigations remain available; the exact editor `frame-ancestors` CSP enforces embedding when a navigation has no origin/referrer. No CORS grants are exposed. Subresources use `Cross-Origin-Resource-Policy: same-origin`.

[The platform response policy](../worker/lib/preview-response-headers.ts) covers both runtimes, assets, and error pages:

| Policy                                                                                   | Purpose and extension constraint                                                                                                               |
| ---------------------------------------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------- |
| `nosniff`, `no-referrer`, `noindex`, origin-agent clustering, disabled `document.domain` | Prevent MIME reinterpretation, referrer leakage, indexing, and origin relaxation. Apply to generated responses and errors.                     |
| `Cache-Control: no-store`                                                                | Keep authorized preview responses out of browser and shared edge caches. Internal immutable build-artifact caching stays behind authorization. |
| HTML `COOP: same-origin` and exact editor `frame-ancestors`                              | Preserve window and embedding boundaries. Nested frames/plugins are blocked; forms and base URLs stay same-origin.                             |
| HTTPS resource/API access, existing inline/eval code, and ordinary Web Workers           | Preserve supported project execution. Service-worker script requests are denied, and content hosts never receive editor/PWA assets.            |
| COEP remains unset                                                                       | Support external resources and the opaque DevTools frontend without weakening the other origin checks.                                         |

The editor iframe retains scripts, same-origin, forms, popups, modals, and clipboard-write permissions, with no referrer. Picker, highlighting, console, errors, HMR, DevTools, and embedded deep-link messages require the exact source window and origin. Only delivery to the opaque sandboxed DevTools iframe uses a wildcard target; its inbound relay checks the exact window and opaque origin. Standalone error links open canonical editor URLs with `noopener,noreferrer`.

Authenticated source JSON, transcoded chat-image data, and attachment-only ZIP downloads remain on the editor origin. Keep these data responses separate from executable hosted documents.

## Development and browser verification

See [development and verification](development.md) for HTTPS setup, certificates, Docker, and test commands. Local certificates cover localhost, the content apex, signed flat content hosts, and git.localhost. OAuth callbacks also use HTTPS.

[hostile-preview.ts](../test/fixtures/hostile-preview.ts) supplies hostile code to separate projects. [The browser isolation suite](../test/e2e/content-isolation.test.ts) covers DOM/storage boundaries, sibling/editor access, credentials, ordinary/service workers, picker, private iframe/standalone flows, and cookie rejection. Existing HMR suites cover React SPA and vinext.

Chromium and Firefox exercise private iframe redemption and automatic renewal. The Linux WebKit test port rejects the third-party cookie, so its private-preview test requires the bounded Open preview fallback and verifies top-level bootstrap access. That test does not establish macOS/iOS Safari iframe behavior; validate the supported browser versions when changing preview authentication. Test application isolation separately from browser site isolation after public-suffix adoption.

## Hosting configuration and rollback

[wrangler.jsonc](../wrangler.jsonc) owns the editor and Git custom domains and the `*.codemaxxing.net/*` and `codemaxxing.net/*` content routes. [The deployment script](../scripts/deploy.ts) is the shared local/CI entrypoint; successful push CI on `main` automatically deploys through [deploy.yml](../.github/workflows/deploy.yml).

Maintain these hosting invariants when configuring a zone or changing domains:

| Configuration                          | Requirement                                                                                                                                                                                                                          |
| -------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| Content DNS and TLS                    | Proxied apex and wildcard records, with an active wildcard certificate covering flat project hosts. For a Worker-only zone, documentation-range placeholder A records (`192.0.2.1`) avoid sending unmatched routes to a real origin. |
| HTTPS and caching                      | Always Use HTTPS and cache bypass for the content apex and subdomains, including assets, redirects, and errors. Preserve internal authorized build-artifact caching.                                                                 |
| Redirects and header overrides         | Content routes must not inherit redirects or zone rules that override platform CORS/CSP or cache preview cookies. Check Single Redirects, Bulk Redirects, and forwarding Page Rules.                                                 |
| Administration permissions             | Zone settings need zone administration access; the deployment token needs Workers Routes Edit for both zones. CLI OAuth may not cover redirects, cache rules, or zone settings.                                                      |
| Route and implementation compatibility | Route content traffic only to code enforcing the separate-domain boundary. Do not add redirects or compatibility cookies back to editor-domain project hosts.                                                                        |

See [Cloudflare custom preview domain guidance](https://developers.cloudflare.com/sandbox/sdk/guides/preview-urls-custom-domain/) for domain setup. Before a routing change, preserve Worker version IDs, routes, and DNS configuration and review pending D1 migrations. Infrastructure must be ready before merging because deployment follows successful CI. Reload editor tabs after host changes; links for removed hosts stop working.

Validate public/private iframes, standalone authentication, picker, DevTools, clipboard, error deep links, HMR, and WebSockets against the configured origins. Confirm no edge cache hits, no app cookies on content requests, no generated Set-Cookie/CORS grants, unknown-host 404s, and service-worker denial. Keep deployment status and verification evidence in the release record.

For rollback to code that lacks the separate-domain classifier, disable both content-domain Worker routes before restoring that code. Restore editor-domain preview routes and DNS only as part of the complete rollback. Worker rollback does not restore DNS, routes, or database data; review saved auxiliary Worker versions too. See [Cloudflare rollback guidance](https://developers.cloudflare.com/workers/versions-and-deployments/rollbacks/).

## Public suffix boundaries

Public Suffix List registration is deferred until the service meets the [PSL guidelines](https://github.com/publicsuffix/list/wiki/Guidelines). The application does not assume `codemaxxing.net` is a public suffix. Before browser adoption, sibling previews can be same-site despite having different origins. User JavaScript can create parent-domain cookies; those cookies confer no platform access and are stripped before generated handlers run.

Host-only partitioned authentication, request rejection, CORP, CSP, and exact-window messaging checks remain necessary independently of PSL status. Do not relax them after registration.

Registration requires demonstrated eligibility, verified domain ownership, a responsible maintainer, and the maintainers' DNS ownership proof. The flat hosting structure calls for a literal PRIVATE-section entry. An accepted upstream entry and browser adoption are separate events; application deployment does not establish either.

To validate adoption in a supported browser, check that sibling hosts are distinct sites and `Domain=codemaxxing.net` cookies are rejected. Also verify storage/credential isolation, private iframe CHIPS, standalone bootstrap, HMR, picker, and DevTools. Record browser versions in the release evidence rather than maintaining a milestone tracker here.
