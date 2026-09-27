# Architecture and ownership

## Request path

`worker/index.ts` exports the Worker handler and the Durable Object, Workflow, and binding classes named in Wrangler configuration. `worker/http/entrypoint.ts` selects the application or preview host. `worker/http/app.ts` composes application middleware and root routes; `worker/http/project-app.ts` mounts project routes. Keep authentication, origin checks, rate limits, and project filesystem binding in that order when adding routes.

Root endpoints are typed in `worker/routes/root-routes.ts`. Project endpoints live in `worker/routes/` and are exposed through Hono RPC. Browser requests use the clients in `src/lib/api/create-client.ts`, with feature request functions in `src/features/*/api/`. Route handlers throw `httpError` for failures, and browser callers use `throwApiError` when status, code, or server messages matter. Preserve existing paths and response shapes when moving handlers.

`src/` may import Worker route types for Hono RPC but must not import Worker runtime values. `worker/` and `shared/` must not import browser modules. ESLint enforces these alias boundaries for application code. Project creation and cloning are coordinated by `worker/services/projects/`; the root handlers retain request validation and response shaping.

## State and storage

React Query owns fetched resources such as the file list. The Cloudflare Agents SDK owns synchronized agent sessions and the authoritative review queue. The Zustand store in `src/lib/store.ts` composes feature slices for local UI and editor state. Review changes copied into Zustand are an editor projection of agent state. Project-specific browser persistence lives in `src/lib/project-storage.ts` and `src/lib/editor-session.ts`; the IDE lifecycle hooks in `src/features/ide/` restore it.

The agent panel in `src/features/agent/components/agent-panel/` coordinates submission and session state. Its session header owns rename and delete confirmation state, composer controls render recording and send actions, and the attachment strip renders pending image uploads. Keep transient UI state in those components and RPC orchestration in the panel and session hook.

Each project has one durable `@cloudflare/shell` Workspace, owned by `DurableObjectFilesystem`. It holds the working tree and `.git`. Worker services access it through the request-bound `fs` proxy in `worker/lib/project-fs.ts`. Git operations run in the filesystem Durable Object through `worker/durable/git-service.ts`. `ProjectCoordinatorV2` handles project WebSocket coordination; `AgentRunner` owns agent sessions and review state. Its `AgentTurnCoordinator` handles per-session turn transitions behind the existing `AgentRunner` RPC methods. Keep Durable Object export names, RPC method names, storage keys, and migrations stable across refactors.

`worker/services/static-preview/` owns external module proxying and source-map error mapping for the SPA preview. `worker/services/agent/review-queue-model.ts` owns persisted review-record validation and reconciliation; `review-queue.ts` coordinates the database and workspace. `worker/durable/agent-runner-input.ts` validates submitted message parts before the agent loop, while `agent-runner-presence.ts` shapes participant identities.

Shared types and validation are grouped by domain in `shared/types/` and `shared/validation/`. The original `shared/types.ts` and `shared/validation.ts` remain compatibility entrypoints.

## Development and verification

Install the versions selected by `mise.toml` with `mise install`, then run commands through `mise exec -- bun ...`. Use `mise exec -- bun install --frozen-lockfile` for dependencies. `bun run dev` starts the Vite and Worker development servers. Worker tests use workerd and need access to local sockets and Wrangler's log directory. Integration tests target a live server through `TEST_BASE_URL`; Playwright starts a local server outside CI.

The root package owns the IDE and auxiliary Workers. `landing/` is a separate package with its own checks. `scripts/deploy.ts` is the common local and CI deployment sequence. Generated `worker-configuration.d.ts` files come from `bun run cf-typegen`; the `vendor/*.wasm` files and `auxiliary/vite-host/vendor/` come from postinstall vendor scripts. Review changes to these generated artifacts alongside the dependency or configuration change that caused them.
