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
| Synchronized agent sessions and authoritative review queue | Cloudflare Agents SDK / `AgentRunner`                                                                     | Change session and review state through the owning agent boundary.                            |
| Local UI and editor state                                  | Feature slices composed by [store.ts](../src/lib/store.ts)                                                | Keep transient UI state local; review data in Zustand is an editor projection of agent state. |
| Project-specific browser persistence                       | [project-storage.ts](../src/lib/project-storage.ts) and [editor-session.ts](../src/lib/editor-session.ts) | Restore through the IDE lifecycle hooks in `src/features/ide/`.                               |
| Project files, `.git`, and `.agent`                        | `DurableObjectFilesystem` / Computer workspace                                                            | Use request-bound filesystem RPC and the durable mutation queue.                              |
| Project WebSocket coordination                             | `ProjectCoordinatorV2`                                                                                    | Broadcast collaboration, HMR, and runtime events through the existing project coordinator.    |

Keeping these owners distinct prevents browser projections from becoming competing authorities. Calculate derived React values during rendering and keep event-driven work in events; use effects for display lifecycle work or external synchronization with cleanup.

The [agent panel](../src/features/agent/components/agent-panel/) coordinates submission and session state. Its session header owns rename/delete confirmation state, composer controls own recording/send presentation, and the attachment strip renders pending uploads. Keep transient UI state in those components and RPC orchestration in the panel and session hook.

Use `loadSession` for explicit session selection and restoration. Background history refreshes use the read-only `readSession` RPC, keyed by session ID and history version, so they cannot change selection or replace live streaming state. Delayed selections yield to newer selections, clears, or message submissions.

## Workspace and agent execution

Each project has one authoritative Computer SQLite workspace under `/workspace`. Git runs inside the filesystem DO against that same tree, with Cloudflare Artifacts as the remote. Editor, agent, Git, lifecycle, and review mutations share durable FIFO ordering. Commands retain ownership through synchronization and change attribution; durable execution IDs support recovery without replaying uncertain commands.

These choices make concurrent edits and review restoration operate on one durable baseline. See [Computer workspace](computer-workspace.md) for access patterns, backend selection, mode restrictions, and recovery rules.

`AgentRunner` owns project-scoped sessions and review state. Its `AgentTurnCoordinator` handles per-session transitions behind the existing RPC facade, while each `SessionTurnAgent` Think facet owns a durable turn submission queue. Keep Durable Object export names, RPC method names, storage keys, and migrations stable across refactors: they identify persisted state and live service contracts.

Use Cloudflare Workflows for durable, resumable jobs with meaningful steps, external I/O, retries, and asynchronous status. Make steps idempotent. Use regular Workers or Durable Objects for fast request/response operations, interactive actions, or work already owned by a DO. This keeps orchestration proportional to the job while preserving retries where they matter.

## Preview and service boundaries

| Owner                                                                   | Responsibility                                                                    |
| ----------------------------------------------------------------------- | --------------------------------------------------------------------------------- |
| [worker/services/static-preview/](../worker/services/static-preview/)   | External module proxying and source-map error mapping for SPA previews            |
| [worker/services/vite-host/](../worker/services/vite-host/)             | Framework detection and Worker hosting for simple static projects                 |
| [container/native-runtime.ts](../container/native-runtime.ts)           | Native Vite preview/HMR and production builds for vinext and custom Vite projects |
| [review-queue-model.ts](../worker/services/agent/review-queue-model.ts) | Persisted review-record validation and reconciliation                             |
| [review-queue.ts](../worker/services/agent/review-queue.ts)             | Review database and workspace coordination                                        |
| [agent-runner-input.ts](../worker/durable/agent-runner-input.ts)        | Submitted message-part validation before the agent loop                           |
| [agent-runner-presence.ts](../worker/durable/agent-runner-presence.ts)  | Participant identity shaping                                                      |

Preview and deployment share runtime detection. Simple static projects stay on Workers; vinext and custom Vite configuration run in the project's lazy Linux container. Native previews forward HTTP and WebSocket upgrades through the existing content authorization boundary. The authoritative Computer workspace is copied into a container-local staging tree, so Vite's watchers and generated files do not write outside a queued command. Editor mutations push source changes under FIFO ownership and synchronize the staging tree for HMR. Native builds use durable execution IDs and refuse changed snapshots before dispatch; their output is uploaded as Worker modules and static assets. The previous Worker vinext host remains available through an explicit `workerIde.runtime: "worker"` manifest override.

## Module boundaries

Group code by feature under `src/features/` and colocate unit tests with their owners. Put strictly reusable UI components in `src/components/ui/`.

`src/` may import Worker route types for Hono RPC, but must not import Worker runtime values. `worker/` and `shared/` must not import browser modules. ESLint enforces these alias boundaries.

Shared types and validation are grouped by domain in [shared/types/](../shared/types/) and [shared/validation/](../shared/validation/). The original `shared/types.ts` and `shared/validation.ts` remain compatibility entrypoints. Review their consumers before narrowing exports; see [Knip audit guidance](knip-audit.md).

See [development and verification](development.md) for setup, test environments, generated artifacts, and deployment configuration.
