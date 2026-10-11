# Worker-IDE

A browser-based full-stack development environment built on Cloudflare Workers. User projects are stored in Durable Object-backed filesystems with Git history backed by Cloudflare Artifacts, transformed on-the-fly with esbuild-wasm, and previewed with HMR. Includes an AI coding assistant powered by the Cloudflare Agents SDK and Workers AI.

See [architecture and ownership](docs/architecture.md) for the request path, state owners, and extension points.

## Architecture

### Frontend (`src/`)

- React 19, Tailwind CSS v4, Zustand for state, CodeMirror 6 for the editor.
- Vercel AI SDK for LLM calls. Cloudflare Agents SDK for agent state management. Hono RPC for type-safe API calls.
- Features organized by domain under `src/features/`.

### Backend (`worker/`)

- Cloudflare Workers with Hono. Durable Objects back per-project file storage (SQLite-backed working tree) and WebSocket coordination (HMR, collaboration). Framework build artifacts are served through a stateless, content-addressed Workers Cache entrypoint.
- Git operations use `isomorphic-git` against Cloudflare Artifacts remotes, with the project working tree mounted from the project filesystem DO.
- User backend code runs in isolated V8 isolates via Cloudflare's [Dynamic Worker Loader](https://developers.cloudflare.com/workers/runtime-apis/bindings/worker-loader/) API.
- vinext (App Router) projects use [vinext](https://github.com/cloudflare/vinext) built by an in-worker Vite/esbuild host (no Vite dev server, since workerd forbids code-gen-from-strings). React Server Components render in a Worker Loader isolate; the browser gets module-level HMR with React Fast Refresh and state-preserving RSC + CSS updates. Deploys produce a standalone Worker (bundled server module set + static client assets).
- AI coding assistant powered by the Cloudflare Agents SDK and Vercel AI SDK. A project-scoped `AgentRunner` coordinates per-session `SessionTurnAgent` Think facets, retained sub-agents, automatic change snapshots, real-time WebSocket state, and a durable Code Mode runtime with configured MCP servers exposed as typed connector namespaces.
- Private previews use a preview-only host cookie minted through an app-origin bootstrap flow, so app auth cookies never leave the main app origin.

### Shared (`shared/`)

Types, constants, validation, and WebSocket message definitions shared between frontend and worker.

## Prerequisites

- [mise](https://mise.jdx.dev/) for the Node 24 and Bun 1.3.14 versions in `mise.toml`
- [Docker](https://docs.docker.com/get-docker/) running locally for Computer container commands and live integration/E2E suites. Ordinary Worker tests use controlled runtime doubles and do not need Docker.
- A Cloudflare account for permanent deployments. The IDE can also deploy a Worker to a new temporary Cloudflare account; claim it within 60 minutes to keep the deployment.

## Getting Started

```bash
mise install
mise exec -- bun install --frozen-lockfile
```

Before starting the dev server, configure the required secrets (see below), then:

```bash
mise exec -- bun run dev        # Vite dev server + worker at localhost:3000
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

Apply the additive auth migration `worker/migrations/d1-auth/0024_session-authentication.sql` before deploying these application changes (`mise exec -- bun run db:migrate:remote`). Existing sessions fall back to their original creation timestamp. Routine session renewal does not refresh verification freshness.

## Scripts

| Script             | Description                                                            |
| ------------------ | ---------------------------------------------------------------------- |
| `dev`              | Vite dev server with Cloudflare Worker (port 3000)                     |
| `build`            | Production build via Turborepo                                         |
| `deploy`           | Build and deploy to Cloudflare                                         |
| `typecheck`        | Run all TypeScript type checks (app, node, worker)                     |
| `lint`             | Check formatting (Prettier) and lint (ESLint)                          |
| `format`           | Auto-fix formatting and lint issues                                    |
| `test:unit`        | Unit tests (Node env)                                                  |
| `test:worker`      | Worker tests (workerd env via `@cloudflare/vitest-pool-workers`)       |
| `test:react`       | React component tests (jsdom env)                                      |
| `test:e2e`         | End-to-end tests (Playwright, Chromium)                                |
| `test:integration` | Integration tests against a live server (`TEST_BASE_URL`)              |
| `test:storybook`   | Storybook component tests                                              |
| `knip`             | Check for unused dependencies and files                                |
| `knip:audit`       | Report unused exports and types (non-gating; see `docs/knip-audit.md`) |
| `storybook`        | Storybook dev server (port 6006)                                       |
| `cf-typegen`       | Generate worker type bindings (`worker-configuration.d.ts`)            |

## Path Aliases

| Alias       | Resolves to  |
| ----------- | ------------ |
| `@/*`       | `./src/*`    |
| `@shared/*` | `./shared/*` |
| `@server/*` | `./worker/*` |
| `@worker/*` | `./worker/*` |

## Filesystem & Git Storage

Each project has one authoritative `@cloudflare/computer` 0.4.1 SQLite workspace in the existing `DurableObjectFilesystem` Durable Object. The project, `.git`, and `.agent` live under `/workspace`. Root-relative RPC paths and application `/project` paths map to that same tree. Git still runs inside the DO through isomorphic-git; Cloudflare Artifacts remains the remote. Worker code uses the `fs` proxy in `worker/lib/project-fs.ts`, bound with `runWithProjectStub`.

Existing SQLite/R2 workspaces migrate in resumable batches. Reads use legacy storage until byte and tree verification succeeds; writes queue during conversion. Initialization state, pending reviews, Git history, snapshots, binary files, directories and symlinks are preserved. The active-store marker changes only after verification. Legacy SQLite and R2 data remain available for recovery. A missing blob, capacity error or verification failure leaves the legacy project readable and writable. Internal `getComputerMigrationStatus` and `retryComputerMigration` RPCs provide failure details and recovery; fix the reported storage problem before retrying.

Computer tools include read, ls, find, grep, write, edit, delete and exec, alongside the full Code Mode `state.*` API and existing domain, MCP, browser and extension tools. Plan and Ask expose read-only tools; write restrictions also apply at the DO RPC boundary.

Exec defaults to the isolate `shell` backend with a 30-second deadline and no direct networking. Select `container` for native commands, package installation and full test runners. Each project starts one lazy `standard-1` container with a two-minute idle timeout. `Dockerfile.computer` pins computerd 0.4.1 and Bun 1.3.14, with Node 24, Git, Python and native build tools. Containers access public HTTP(S) through the policy gateway; private hosts, credentialed URLs and deployment hosts stay restricted. Previews and privileged services use the existing tools. Container commands have a five-minute deadline; Think allows ten minutes without stream progress. Run foreground commands and use existing preview hosting for application servers.

Editor, agent, Git, lifecycle and review mutations share a durable FIFO queue. Commands retain ownership through final synchronization. Cancellation kills the runtime command before synchronization releases queued writes. Durable execution IDs prevent uncertain commands from being replayed after interruption. Synchronization failures retain ownership and report pending status. Changes are attributed to each session, with byte-preserving snapshots for binary files and symlinks. Dependency caches and temporary container outputs are excluded from source review.

To build the image independently:

```bash
docker build --platform linux/amd64 -f Dockerfile.computer -t worker-ide-computer:0.4.1 .
```

Ordinary Worker tests never start Docker. Full `test:worker --run` runs in fresh batches, with the large preview-runtime integrations and D1 fixture suites isolated in separate processes to stay within workerd's heap limit. Targeted Worker runs and watch mode still use Vitest directly. Live integration and E2E suites require the Docker-aware development server; Playwright reuses an existing local server. Plan/todo tools save only their constrained session documents through a typed RPC while source writes remain blocked in Plan/Ask. The container startup trusts Cloudflare's injected gateway CA, including Node/Bun package-manager requests.

See [Computer migration validation](docs/computer-migration-validation.md) for the recorded checks and recovery coverage.
