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

Each project has a single durable [`@cloudflare/shell`](https://github.com/cloudflare/agents/tree/main/packages/shell) `Workspace` (SQLite + R2 spillover) living in the `DurableObjectFilesystem` Durable Object. It holds both the working tree and a real `.git`. Git operations run inside that DO via isomorphic-git against the local Workspace (no in-memory scratch filesystem); Cloudflare Artifacts remains the git remote. Worker code accesses the Workspace through the `fs` proxy in `worker/lib/project-fs.ts` (a `node:fs/promises`-compatible view over a cross-DO RPC client), bound per request via `runWithProjectStub`.
