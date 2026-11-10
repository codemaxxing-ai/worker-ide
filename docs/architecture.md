# Architecture and ownership

## Request routing and isolation

[worker/index.ts](../worker/index.ts) exports the Worker handler and the Durable Object, Workflow, and binding classes named in Wrangler configuration. [The HTTP entrypoint](../worker/http/entrypoint.ts) classifies exact configured editor/Git origins and signed project origins under the separate content domain; see [hosting boundaries](content-isolation.md). [app.ts](../worker/http/app.ts) composes application middleware and root routes; [project-app.ts](../worker/http/project-app.ts) mounts project routes once so Hono compiles the route tree at startup.

Preserve middleware ordering when adding endpoints. Unsafe application API methods pass same-origin checks before protected-route authentication; analytics runs after authentication, followed by rate limits. Project middleware checks project existence and membership before binding the filesystem. Agent and coordinator WebSocket paths also validate their origins.

Hosted project content uses signed origins under `CONTENT_ORIGIN`, separate from the editor's `APP_ORIGIN`. Private iframes use a host-only partitioned preview cookie minted through the editor bootstrap flow. Keep app auth cookies on the application origin. Project backend code executes in Worker Loader isolates, separately from the host Worker's bindings and privileged services.

## Typed API pattern

Root endpoints are defined in [root-routes.ts](../worker/routes/root-routes.ts). Project endpoints live in [worker/routes/](../worker/routes/) and expose their success schemas through Hono RPC. Project creation and cloning are coordinated by [worker/services/projects/](../worker/services/projects/); route handlers retain request validation and response shaping.

Browser callers use `createApiClient(projectId)` from [api-client.ts](../src/lib/api-client.ts). Root, user, organization, transfer, and Cloudflare OAuth requests use the corresponding client factories in that module. Feature request functions belong in `src/features/<feature>/api/`.

```ts
import { createApiClient } from '@/lib/api-client';
import { throwApiError } from '@/lib/api-error';

const api = createApiClient(projectId);
const response = await api.git.status.$get({});
if (!response.ok) {
  await throwApiError(response, 'Failed to get git status');
}
const status = await response.json();
```

Application API calls must use these clients. Use `response.json()` directly on success. `throwApiError` validates untyped error payloads when status, error codes, or server messages matter; a plain fallback `Error` is sufficient otherwise.

Route failures use `throw httpError(code, message, optionalStatus)` from [http-error.ts](../worker/lib/http-error.ts). Returning `c.json({ error: ... }, status)` from a typed route adds an error union to Hono's inferred schema, which breaks clean success types in callers. SDK-owned auth, development adapters, and routing middleware retain their separate response contracts.

Use kebab-case route paths and bracket notation for hyphenated RPC segments, such as `api.user['recent-projects'].$get({})`. Preserve endpoint paths and response shapes when moving handlers.

## State owners

| State                                                      | Owner                                                                                                     | Extension rule                                                                                |
| ---------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------- |
| Fetched resources, including the file list                 | React Query                                                                                               | Update or invalidate resource queries after changes.                                          |
| Synchronized agent sessions and authoritative review queue | Cloudflare Agents SDK / `ProjectAgent`                                                                    | Change session and review state through the owning agent boundary.                            |
| Local UI and editor state                                  | Feature slices composed by [store.ts](../src/lib/store.ts)                                                | Keep transient UI state local; review data in Zustand is an editor projection of agent state. |
| Project-specific browser persistence                       | [project-storage.ts](../src/lib/project-storage.ts) and [editor-session.ts](../src/lib/editor-session.ts) | Restore through the IDE lifecycle hooks in `src/features/ide/`.                               |
| Project files, `.git`, and `.agent`                        | `DurableObjectFilesystem` / Computer workspace                                                            | Use request-bound filesystem RPC and the durable mutation queue.                              |
| Project WebSocket coordination                             | `ProjectCoordinatorV2`                                                                                    | Broadcast collaboration, HMR, and runtime events through the existing project coordinator.    |

Keeping these owners distinct prevents browser projections from becoming competing authorities. Calculate derived React values during rendering and keep event-driven work in events; use effects for display lifecycle work or external synchronization with cleanup.

The [agent panel](../src/features/agent/components/agent-panel/) renders native `UIMessage` parts. Original transcript pages own chronological order and branch membership; Think's `useAgentChat` supplies the live assistant. A changed SDK tail starts fresh paging, canceling obsolete requests. Inference compaction summaries never enter the displayed history. Focused components own the session list, composer, transcript and branch dialog. Application commands use typed Hono RPC; the authenticated SDK transport owns chat streaming. Each tab keeps its selection and drafts in sessionStorage. The project directory broadcasts compact summaries and review state only.

## Workspace and agent execution

Each project has one authoritative Computer SQLite workspace under `/workspace`. Git runs inside the filesystem DO against that same tree, with Cloudflare Artifacts as the remote. Editor, agent, Git, lifecycle, and review mutations share durable FIFO ordering. Commands retain ownership through synchronization and change attribution; durable execution IDs support recovery without replaying uncertain commands.

These choices make concurrent edits and review restoration operate on one durable baseline. See [Computer workspace](computer-workspace.md) for access patterns, backend selection, mode restrictions, and recovery rules.

`ProjectAgent` owns the catalog, shared context, MCP and review records. Each `SessionTurnAgent` Think facet owns its transcript, branches, queue and recovery. Durable submissions enter through `runTurn({mode: "submit", channel: "web"})`; server-authenticated author metadata and stable message IDs cross the boundary once. The shared tool catalog centralizes validation, mode restrictions, cancellation and attribution for direct and Code Mode calls. Orchestration holds no filesystem lease; each leaf mutation acquires the FIFO once.

Terminal ledger outcomes create a submission-keyed outbox. Before a later turn starts, the previous turn's filesystem receipts settle and are checkpointed into immutable snapshot/review data. Parent delivery, logs and notifications are retried independently. Startup replays pending finalization. Native regeneration creates sibling branches; restoration remains a separate confirmed operation, deduplicated by the filesystem DO. SDK recovery may continue safe inference but cannot replay an uncertain mutation. See [the upgrade checklist](think-upgrade.md).

Session deletion persists an admission tombstone in the catalog and closes the child before draining native requests, ledger submissions and finalization. Failed deletion leaves admissions closed for retry. Review records have one project projection; there is no legacy singleton pending-change table or endpoint.

Use Cloudflare Workflows for durable, resumable jobs with meaningful steps, external I/O, retries, and asynchronous status. Make steps idempotent. Use regular Workers or Durable Objects for fast request/response operations, interactive actions, or work already owned by a DO. This keeps orchestration proportional to the job while preserving retries where they matter.

## Preview and service boundaries

| Owner                                                                   | Responsibility                                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [worker/services/static-preview/](../worker/services/static-preview/)   | External module proxying and source-map error mapping for SPA previews            |
| [worker/services/vite-host/](../worker/services/vite-host/)             | Framework detection and Worker hosting for simple static projects                 |
| [container/native-runtime.ts](../container/native-runtime.ts)           | Native Vite preview/HMR and production builds for vinext and custom Vite projects |
| [review-queue-model.ts](../worker/services/agent/review-queue-model.ts) | Persisted review-record validation and reconciliation                             |
| [review-queue.ts](../worker/services/agent/review-queue.ts)             | Review database and workspace coordination                                        |
| [submission-input.ts](../worker/services/agent/submission-input.ts)     | Submitted message-part validation before the agent loop                           |

Preview and deployment begin on Workers, including vinext. Compilation resource limits or unsupported host capabilities trigger the project's lazy Linux container; application errors remain errors. The toolbar uses runtime icons and permits a one-way manual promotion. Temporary promotion lasts until automatic container shutdown. The `alwaysUseContainer` project metadata flag starts subsequent sessions on containers without changing workspace files. Native previews forward HTTP and WebSocket upgrades through the content authorization boundary. The authoritative Computer workspace is copied into a container-local staging tree; source updates retain FIFO ownership through synchronization and HMR. Native builds use durable execution IDs and refuse changed snapshots before dispatch; both build paths upload Worker modules and static assets.

`OrganizationContainerCapacity` serializes container admission per organization in SQLite. `ProjectContainerAdmission` gates every Computer host start/restart, including commands, builds, and snapshot restores. Reservations count starting and running instances, with one slot per project and tokens guarding against stale releases. Existing running instances are adopted before admission. Exit monitoring releases slots; admission and status requests reconcile missed exits without periodic keepalive polling. Org capacity comes from `org:max_running_containers` (Free 3, Pro 10, Enterprise 100). Exhaustion returns `CONTAINER_LIMIT_REACHED` (409), preserves existing previews, and allows manual retry. Live project transfers reserve destination capacity before atomically updating ownership, then release the source reservation; a durable transfer record recovers interrupted accounting.

## Module boundaries

Group code by feature under `src/features/` and colocate unit tests with their owners. Put strictly reusable UI components in `src/components/ui/`.

`src/` may import Worker route types for Hono RPC, but must not import Worker runtime values. `worker/` and `shared/` must not import browser modules. ESLint enforces these alias boundaries.

Shared types and validation are grouped by domain in [shared/types/](../shared/types/) and [shared/validation/](../shared/validation/). The original `shared/types.ts` and `shared/validation.ts` remain compatibility entrypoints. Review their consumers before narrowing exports; see [Knip audit guidance](knip-audit.md).

See [development and verification](development.md) for setup, test environments, generated artifacts, and deployment configuration.
