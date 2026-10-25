# Worker-IDE

A browser-based full-stack development environment built on Cloudflare Workers. User projects are stored in Durable Object-backed filesystems with Git history backed by Cloudflare Artifacts, transformed on-the-fly with esbuild-wasm, and previewed with HMR. Includes an AI coding assistant powered by the Cloudflare Agents SDK and Workers AI.

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

Dependency and configuration updates hold one durable queue position through their read, update, and regeneration steps. Agent file tools and Code Mode state helpers reject writes to managed configuration, including symlink targets. Shell and container commands preserve managed files through durable baselines; attempted changes are restored before the queue advances and reported as command failures. Ordinary source edits remain available for review.

Successful `user_question` calls pause the agent turn until the user replies. Unanswered questions return when a session is reopened. Tool metadata and errors are persisted per session, including background sessions, so todo lists and other tool results remain available after completion and reload.

Tool calls can be expanded while their arguments are streaming, including dynamically registered tools. Directory listing accepts both `ls` and `list`. Agent model requests and streams fail after two minutes without a response or provider activity; tool execution keeps its separate runtime deadline.

Stopping aborts inference and cancels queued turns without waiting for workspace execution cancellation or empty-snapshot cleanup. Workspace mutations retain FIFO ownership through synchronization. Complete tool inputs update the displayed arguments even when a provider omits incremental argument events.

Streaming deltas are coalesced before crossing the session-to-parent RPC boundary; the internal session facet does not broadcast a second, unused client stream. The parent checks running submissions every 30 seconds so a failed completion notification cannot leave the UI running indefinitely.

Think's durable submission status determines the session's terminal status. A new session facet receives existing conversation history before its first submission, including reverted conversations. The `test:agent` CI suite exercises the production bundle, parent/session RPC, scheduling, provider parsing, and file tools with controlled AI responses; it covers completion, cancellation, stalled requests, failure recovery, and conversation continuity without Docker or live AI credentials.

Each changed file revision reaches the review UI, and tool execution and input-validation errors are reported at the end of their model step.

See [Computer workspace](docs/computer-workspace.md) for access patterns, execution limits, review, and recovery rules. See [development and verification](docs/development.md) for Docker setup, test commands, and generated artifacts.
