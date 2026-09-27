# Refactor and stabilize codebase: continuation record

The original task is a staged, whole-repository cleanup that preserves the running application, existing deployments, stored projects and sessions, HTTP and WebSocket contracts, Durable Object identities, and UI behavior. Fix demonstrated bugs. The user explicitly chose existing-deployment compatibility and preserving structured API errors through the validated adapter. Use mise for Node 24 and Bun 1.3.14. Group exports from the same module into one export statement.

The original session log is `/Users/twilhelm/.codex/sessions/2026/09/25/rollout-2026-09-25T18-38-02-01a0db5c-b8f5-7230-b10c-026aa9562314.jsonl`. Its full contents were reviewed before this continuation. Later continuations failed with HTTP 429 and made no further edits. This record is the short handoff; the original plan and discussion are in that log.

## Implemented so far

- Added mise configuration, aligned CI runtimes, added Worker tests to CI, corrected CI trigger and Turborepo inputs, and pinned deployment workflows to the successful CI revision. Local and CI deployment share `scripts/deploy.ts` and include the Vite host Worker.
- Fixed Git-adjacent file tracking, project-scoped transform configuration caching, editor session restoration across project switches, and overlapping/failed agent session loads. Regression tests cover these cases.
- Split shared types and validation by domain with compatibility exports. Split agent message rendering, Worker HTTP composition, frontend store slices, IDE feature files, collaboration socket code, and feature API request helpers. Added typed root Hono RPC routes while retaining existing error payloads.
- Moved project creation, cloning, access checks, limits, and setup into `worker/services/projects/` while keeping root validation and Hono response types. Split static preview external modules and source-map error mapping, review queue persistence modeling, and agent runner input and participant identity helpers. Focused tests cover malformed persisted review data and submitted agent input.
- Split the dashboard's project options and rows, organization membership controls, file-tree model and context menu, and agent message timeline into feature modules. Added focused React tests for membership permissions/invites and timeline reconciliation.
- Moved the agent panel's session header and its rename/delete state, composer controls, and attachment strip into feature components. React tests now cover header rename/delete confirmation as well as recording takeover and send controls.
- Aligned `@vitest/browser` with Vitest 3.2.7 and removed Storybook's duplicate annotation setup. Added ESLint alias-boundary rules for browser, Worker, and shared code. Audited Knip with export/type reporting enabled; preserved compatibility reexports and dynamically loaded modules, and removed only confirmed dead local exports and helpers.
- Added `docs/architecture.md` and updated the README for the new ownership and mise setup.

## Follow-up implementation (September 26)

- Extracted `AgentTurnCoordinator` behind the unchanged `AgentRunner` callable methods. It owns per-session mutation serialization, queued submission/removal, retries, abort transitions, and completion persistence. Focused tests cover ordering and failure recovery; real Durable Object tests cover completion replay after simulated eviction, queued follow-ups, and loading a running session without replacing live messages.
- Released object-valued Durable Object RPC results after use in `WorkspaceClient`, project tree transfer, Git HTTP routes, preview bootstrap, build-artifact snapshot loading, and per-writer workspace change draining. The byte reader copies data before releasing its RPC result. Focused tests cover transformed workspace data and project-tree transfer disposal on success and failure.
- Added a non-gating `knip:audit` script and `docs/knip-audit.md`. The strict report fell from 36 to 31 files with unused value exports and 137 to 131 files with unused type exports; duplicate-export findings remain at 2. Removed only verified dead internals. The default `knip` gate is unchanged.

One intermittent **RPC stub** disposal warning remains un-attributed. Two full 52-test integration runs passed on the same clean local server after the result fixes. The first emitted no RPC warning. The second emitted one stub warning shortly after a documentation edit caused a Vite hot reload; neither run emitted a result warning. Separate creation, clone, file, and snapshot groups had passed without warnings. The warning carries no call-site stack, and these observations do not establish whether the remaining stub belongs to the application or tooling. Do not claim it is fixed or SDK-owned without a targeted reproduction.

## Verification for the follow-ups

- `mise exec -- bun run format`, `bun run lint`, `bun run typecheck`, and `bun run knip`: passed. Strict `bun run knip:audit` completed as a non-gating report.
- Unit: 582/582; React: 472/472; Worker: 883/883 on the final code. A mock filesystem RPC result in `fs-binding.test.ts` was updated to provide the disposable contract used by workerd.
- Production build: a fresh, uncached run passed outside the sandbox with the final disposal scopes and no Wrangler log permission errors.
- Integration: 52/52 passed twice on a live local Vite server on port 3000 after Git route disposal. The server was stopped afterward.
- Playwright: 26/26 passed on the final code, including preview and vinext preview flows, using an isolated local server on port 3000.
- Storybook: 100/100 passed outside the sandbox before the final Worker-only disposal scopes.
- Landing app: Astro check and production build passed in the original continuation. The build required putting mise's Node 24 and Bun 1.3.14 shims ahead of Homebrew's Node 26 for shebang children.

Generated `vendor/*.wasm` and `auxiliary/email/worker-configuration.d.ts` changed during the original session's locked install/type generation. The WASM dependency versions match `HEAD` (`esbuild-wasm@0.27.7` and `@biomejs/wasm-web@2.5.7`), and the local optimizer is `wasm-opt` 132; the committed binaries differ from this machine's regenerated output. The email declaration difference is only Wrangler's generated command hash. Do not discard these without checking the original build inputs. Do not deploy as part of this refactor.
