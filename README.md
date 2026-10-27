# Worker-IDE

A browser-based full-stack development environment built on Cloudflare Workers. User projects are stored in Durable Object-backed filesystems with Git history backed by Cloudflare Artifacts, transformed on-the-fly with esbuild-wasm, and previewed with HMR. Includes an AI coding assistant powered by the Cloudflare Agents SDK and Workers AI.

Model calls use `createAI` with AI SDK 7. The `agents-models` dependency is an npm alias for the official `agents@0.30.1` package, used only for its model provider; `agents@0.20.1` remains the session runtime because later releases remove the experimental session APIs this application uses. Gateway metadata, payload logging controls, session affinity, and provider timeouts are preserved.

The coding assistant offers [GLM 5.3](https://developers.cloudflare.com/workers-ai/models/glm-5.3/) (default), [DeepSeek V4.1 Flash (1017)](https://developers.cloudflare.com/workers-ai/models/deepseek-v4.1-flash-1017/), and [GLM 5.3 Flash](https://developers.cloudflare.com/workers-ai/models/glm-5.3-flash/), all hosted on Workers AI with 1,048,576-token context windows. GLM 5.3 Flash handles summarization and titles. These models require Workers Paid or prepaid AI Gateway credits. Model selection was reviewed on October 26, 2026.

See the [contributor documentation](docs/index.md) for architecture, workspace patterns, development guidance, and design decisions.

## Architecture

### Frontend (`src/`)

- React 19, Tailwind CSS v4, Zustand for state, CodeMirror 6 for the editor.
- Vercel AI SDK for LLM calls. Cloudflare Agents SDK for agent state management. Hono RPC for type-safe API calls.
- Features organized by domain under `src/features/`.

### Backend (`worker/`)

- Cloudflare Workers with Hono. Durable Objects back per-project file storage (SQLite-backed working tree) and WebSocket coordination (HMR, collaboration).
- Git operations use `isomorphic-git` against Cloudflare Artifacts remotes, with the project working tree mounted from the project filesystem DO.
- User backend code runs in isolated V8 isolates via Cloudflare's [Dynamic Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) API.
- Simple static/React SPA projects use the Worker esbuild host. [vinext](https://github.com/cloudflare/vinext) and projects with custom Vite plugins/configuration use a lazy per-project Linux container running native Vite with WebSocket HMR. Production builds run in the same container and deploy as Worker modules plus static assets. The vinext template uses Vite 8 and React plugin 6, matching vinext's native APIs.
- Preview and builds share a durable runtime policy. Worker compilation reserves headroom with 2 MiB per-module and 8 MiB source-graph budgets, including fetched dependencies. Resource-limit failures promote the project to a container; syntax and dependency errors remain errors. Promotion persists across restarts to avoid oscillation, and `package.json` → `workerIde.runtime` can explicitly select `worker` or `container`. This uses source sizes and platform failures, rather than a dependency-name list or live heap telemetry. The Editor Preview toolbar receives runtime changes through the project WebSocket, including startup, switching, errors and container sleep.
- Runtime handover warms the replacement before reloading the existing preview browsing context. Its URL, browser storage, ordinary form values, focus and scroll position are preserved where possible. Applications can preserve serializable state with `window.__WORKER_IDE_PREVIEW_STATE__ = { capture: () => state, restore: (state) => ... }`; handover data is local, bounded to 1 MiB and expires after five minutes to allow cold startup. Password/file fields and arbitrary JavaScript heap state are excluded. Frontend/SSR development and compilation move to the container; project API handlers and deployed applications retain their Worker bindings and execution model.
- AI coding assistant powered by the Cloudflare Agents SDK and Vercel AI SDK. A project-scoped `AgentRunner` coordinates per-session `SessionTurnAgent` Think facets, retained sub-agents, automatic change snapshots, real-time WebSocket state, and a durable Code Mode runtime with configured MCP servers exposed as typed connector namespaces.
- User questions end the current agent turn and resume with the next message. Unanswered questions remain available when reloading a session.
- Hosted project content runs on signed, isolated `codemaxxing.net` origins; the editor and management API stay on `codemaxxing.app`. Private iframes use a host-only partitioned access cookie. See [hosting boundaries](docs/content-isolation.md).

### Shared (`shared/`)

Types, constants, validation, and WebSocket message definitions shared between frontend and worker.

## Prerequisites

- [mise](https://mise.jdx.dev/) for the Node 24 and Bun 1.3.14 versions in `mise.toml`
- [Docker](https://docs.docker.com/get-docker/) running locally for Computer container commands and live integration/E2E suites. Ordinary Worker tests use controlled runtime doubles and do not need Docker.
- Computer 0.4.1's container cache exclusions require FUSE. Docker Desktop on macOS/WSL provides it; Linux development and CI require rootless Docker with `/dev/fuse` available. Rootful Linux Docker falls back to an unsupported userspace mode for this configuration.
- A Cloudflare account for permanent deployments. The IDE can also deploy a Worker to a new temporary Cloudflare account; claim it within 60 minutes to keep the deployment.

## Getting Started

```bash
mise install
mise exec -- bun install --frozen-lockfile
```

Before starting the dev server, configure the required secrets (see below), then:

```bash
mise exec -- bun run dev        # HTTPS editor at https://localhost:3000
```

## Secrets & Environment Variables

Workers with local secrets read them from a `.dev.vars` file in their directory. These files are gitignored. Copy the corresponding `.dev.vars.example` to `.dev.vars` and follow the instructions inside to generate and fill in the values.

The auxiliary email worker does not need a local `.dev.vars` example. It uses Cloudflare Email Service via the `send_email` binding declared in `auxiliary/email/wrangler.jsonc`.

| Worker | Example file                       |
| ------ | ---------------------------------- |
| Main   | `.dev.vars.example`                |
| Push   | `auxiliary/push/.dev.vars.example` |

## Session Verification

Session verification keeps the existing session and device identity; it refreshes only the 24-hour eligibility window for sensitive account actions. Only configured providers linked to the account are offered. Cancellation leaves the session signed in, and successful verification requires retrying the action.

The auth schema includes `worker/migrations/d1-auth/0024_session-authentication.sql`; apply D1 migrations with `mise exec -- bun run db:migrate:local` locally or `mise exec -- bun run db:migrate:remote` for deployment. Existing sessions fall back to their original creation timestamp. Routine session renewal does not refresh verification freshness.

## Push notifications

After notification permission is granted, the IDE automatically restores missing service worker, browser push, and server registrations on opening a project, returning to the tab, or reconnecting. Existing disabled device preferences remain disabled. Browser permission prompts require clicking the notification bell.

The bell also synchronizes after permission or service worker changes and preference updates from other tabs. Changes received during an in-flight operation trigger another check before settling the displayed state.

## Scripts

| Script             | Description                                                             |
| ------------------ | ----------------------------------------------------------------------- |
| `dev`              | Vite dev server with Cloudflare Worker (port 3000)                      |
| `build`            | Production build via Turborepo                                          |
| `deploy`           | Build and deploy to Cloudflare                                          |
| `typecheck`        | Run all TypeScript type checks (app, node, worker, scripts)             |
| `lint`             | Check formatting (Prettier) and lint (ESLint)                           |
| `format`           | Auto-fix formatting and lint issues                                     |
| `test:unit`        | Unit tests (Node env)                                                   |
| `test:worker`      | Worker tests (workerd env via `@cloudflare/vitest-pool-workers`)        |
| `test:agent`       | Production-build agent lifecycle tests with the current Workers runtime |
| `test:react`       | React component tests (jsdom env)                                       |
| `test:e2e`         | Build editor and run Playwright tests in Chromium, Firefox and WebKit   |
| `test:integration` | Integration tests against a live server (`TEST_BASE_URL`)               |
| `test:storybook`   | Storybook component tests                                               |
| `knip`             | Check for unused dependencies and files                                 |
| `knip:audit`       | Report unused exports and types ([audit guidance](docs/knip-audit.md))  |
| `storybook`        | Storybook dev server (port 6006)                                        |
| `cf-typegen`       | Generate worker type bindings (`worker-configuration.d.ts`)             |

### Local browser tests

Run `mise exec -- bunx playwright install` after changing Playwright versions, then `mise exec -- bun run test:e2e`. The default run uses one worker locally and in CI to avoid competing native Docker setup. It owns a fresh server on port 3000 and checks `/api/templates` before starting. Stop a conflicting server or explicitly select an existing one with `TEST_BASE_URL=https://localhost:3000`; E2E no longer silently reuses a server from another checkout. Servers started by Playwright disable host-source watching so concurrent edits cannot reset Worker state during a test. Preview HMR remains enabled.

Firefox on macOS uses a private app-data directory for each Playwright worker through `test/browser-launch.ts`. This avoids the macOS 27 protection of the real Firefox app-data directory ([upstream issue](https://github.com/microsoft/playwright/issues/42768)). The directory and its macOS-created ACLs are removed after browser shutdown. Other repositories using affected Firefox builds can reuse this helper and the `launchOptions` fixture in `test/e2e/test-fixtures.ts`.

E2E and integration teardown explicitly destroy each run's test workspaces and containers before deleting their database rows. Cleanup failures fail the check and retain the project IDs for retry; cleanup never clears another run's projects. Run Docker-dependent suites without restarting or updating Docker Desktop during the run. A Docker restart invalidates active container connections and requires a fresh test server; retrying tests against that server does not repair its runtime.

Native preview tests prepare cold container dependencies in a fixture with a six-minute startup budget, matching the runtime's five-minute command limit plus startup overhead. Browser and HMR assertions retain their two-minute test budget and shorter per-assertion deadlines. Teardown cancels unfinished native setup before waiting for the workspace mutation queue.

## Path Aliases

| Alias       | Resolves to  |
| ----------- | ------------ |
| `@/*`       | `./src/*`    |
| `@shared/*` | `./shared/*` |
| `@server/*` | `./worker/*` |
| `@worker/*` | `./worker/*` |

## Filesystem & Git Storage

Each project has one authoritative `@cloudflare/computer` 0.4.1 SQLite workspace in the existing `DurableObjectFilesystem` Durable Object. The project, `.git`, and `.agent` live under `/workspace`. Root-relative RPC paths and application `/project` paths map to that same tree. Git still runs inside the DO through isomorphic-git; Cloudflare Artifacts remains the remote. Worker code uses the `fs` proxy in `worker/lib/project-fs.ts`, bound with `runWithProjectStub`.

Editor, agent, Git, lifecycle, and review mutations share a durable FIFO queue. Executions retain ownership through synchronization; durable IDs prevent uncertain commands from being replayed. Existing projects without a verified Computer marker report a recovery error, and frozen legacy recovery data remains retained.

Exec defaults to `auto`: supported text, file, and local Git commands use the network-disabled isolate `shell`; native binaries, installs, network commands, and full test runners use `container`. Explicit backend choices are retained, and execution recovery stays on the originally selected backend. Plan and Ask restrict source writes at both the tool and RPC boundaries.

The agent manages project dependencies through `dependencies_list` and `dependencies_update`, available directly and through Code Mode. These tools update the IDE-managed manifest without shell execution. Full Worker projects resolve registered packages for both frontend and backend imports without a container. Projects using container previews and builds install registered packages automatically in that runtime.

List existing dependencies before adding packages. Dependency registration does not require a subsequent `bun install` for Worker previews or builds. Run an install only when a required native validation command needs packages that are missing in the container. Managed TypeScript projects with a root `tsconfig.json` provide `bun run typecheck` (`tsc -b`), which checks referenced projects; a Vite build alone does not check types.

Dependency and configuration updates hold one durable queue position through their read, update, and regeneration steps. Agent file tools and Code Mode state helpers reject writes to managed configuration, including symlink targets. Shell and container commands preserve managed files through durable baselines; attempted changes are restored before the queue advances and reported as command failures. Ordinary source edits remain available for review.

Project DOM tests run with Vitest in the container. Register `jsdom` or `happy-dom` through `dependencies_update`, select it with a `// @vitest-environment jsdom` (or `happy-dom`) directive in each DOM test file, and run `bun run test -- <test-file>` through `exec`. Prefer an already registered DOM environment, investigate missing `window`/`document` errors, and rerun affected tests after correcting their per-file directives. Run `bun install` only if the required native test command needs missing registered packages. The protected `vitest.config.ts` stays unchanged. The lightweight `test_run` tool provides a separate Worker harness with no DOM or Vitest configuration support.

The primary coding agent is instructed to call `completion_review({ draft_summary })` before its final implementation summary. This advisory tool compares the draft with observed tool results (including Code Mode calls), task context, changed paths, and TODOs. It uses internal Workers AI Clef-flash decisions with a two-second deadline and no retries, separately from the selectable coding models. Unknown, incomplete, or unavailable review evidence never counts as successful verification. Review does not block questions, alter completion semantics, or trigger automatic continuations; agent compliance remains model-dependent. Clairic extraction is not needed for the existing structured results.

Build, typecheck, tests, and browser verification are reported separately. Failed verification remains incomplete; attributing failures as pre-existing requires baseline evidence. Visible UI changes require browser checks of rendering, interaction, resizing, and errors; animation requires observations across frames.

Successful `user_question` calls pause the agent turn until the user replies. Unanswered questions return when a session is reopened. Tool metadata and errors are persisted per session, including background sessions, so todo lists and other tool results remain available after completion and reload.

Agent turns save JSON debug logs under `.agent/sessions/<sessionId>/debug-logs/`. The **Agent Log** download beneath the latest response appears after the log is saved and is restored when the session is reopened.

Tool calls can be expanded while their arguments are streaming, including dynamically registered tools. Directory listing accepts both `ls` and `list`. Agent model requests and streams fail after two minutes without a response or provider activity; tool execution keeps its separate runtime deadline.

Stopping aborts inference and cancels queued turns without waiting for workspace execution cancellation or empty-snapshot cleanup. Workspace mutations retain FIFO ownership through synchronization. Complete tool inputs update the displayed arguments even when a provider omits incremental argument events.

Streaming deltas are coalesced before crossing the session-to-parent RPC boundary; the internal session facet does not broadcast a second, unused client stream. The host Worker allows 100,000 subrequests per invocation to provide headroom for agent tools and streaming RPCs. The parent checks running submissions every 30 seconds so a failed completion notification cannot leave the UI running indefinitely.

Think's durable submission status determines the session's terminal status. A new session facet receives existing conversation history before its first submission, including reverted conversations. The `test:agent` CI suite exercises the production bundle, parent/session RPC, scheduling, provider parsing, and file tools with controlled AI responses; it covers completion, cancellation, stalled requests, failure recovery, and conversation continuity without Docker or live AI credentials.

Each changed file revision reaches the review UI, and tool execution and input-validation errors are reported at the end of their model step.

Main and subagent inference sessions compact context after an estimated 100,000 tokens while preserving the original chat transcript. Compaction protects the first three messages and a recent 32,000-token tail (at least four messages); model output and context headroom are budgeted separately. Provider request failures receive up to two SDK retries with backoff and cancellation. Stream failures and completed tools are never automatically replayed. Three consecutive equivalent tool failures without a successful call or workspace change stop the submission with an error. Tool input schemas validate types, enums, nested values, and closed object properties before executor conversion.

Expanded command tools show live stdout and stderr over the existing WebSocket connection, including commands inside CodeMode and subagents. Updates are batched every 100 ms. Each stream retains at most 60,000 bytes, and each outer tool call retains at most 120,000 bytes across 32 executions; truncated output is labeled. Live output delivery is best effort and never releases workspace mutation ownership before synchronization completes.

See [Computer workspace](docs/computer-workspace.md) for access patterns, execution limits, review, and recovery rules. See [development and verification](docs/development.md) for Docker setup, test commands, and generated artifacts.
