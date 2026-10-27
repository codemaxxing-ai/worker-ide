# Development and verification

## Local environment

Use the Node and Bun versions selected by [mise.toml](../mise.toml):

```bash
mise install
mise exec -- bun install --frozen-lockfile
```

Configure local secrets using the examples listed in the [README](../README.md#secrets--environment-variables). Do not commit `.dev.vars` files. Start Docker before the development server: the Cloudflare Vite plugin builds the Computer container image declared in [wrangler.jsonc](../wrangler.jsonc).

For a local database and server:

```bash
mise exec -- bun run db:migrate:local
mise exec -- bun run dev
```

The editor runs at `https://localhost:3000`; signed previews use `*.content.localhost:3000`. Vite caches local certificates in the ignored `.local-certificates/` directory. Accept the certificate for manual development, use HTTPS OAuth callbacks, and regenerate certificates after changing development hostnames. See [hosted content isolation](content-isolation.md) for the origin and authentication boundaries.

`dev` builds Worker declarations and watches them alongside Vite. The root package owns the IDE and auxiliary Workers; `landing/` is a separate package with its own dependency installation and checks.

## Choosing a test environment

| Command                                       | Environment                                                           | Prerequisites                                                               |
| --------------------------------------------- | --------------------------------------------------------------------- | --------------------------------------------------------------------------- |
| `mise exec -- bun run test:unit --run`        | Node                                                                  | Installed dependencies                                                      |
| `mise exec -- bun run test:worker --run`      | workerd with controlled runtime doubles                               | Local sockets and access to Wrangler's log directory; no Docker             |
| `mise exec -- bun run test:agent`             | Production Worker bundle in the current Miniflare runtime             | Local sockets; builds automatically; no Docker or live AI credentials       |
| `mise exec -- bun run test:react --run`       | jsdom                                                                 | Installed dependencies                                                      |
| `mise exec -- bun run test:integration --run` | Live application server and real Computer runtimes                    | Docker, migrated local database, and a running dev server                   |
| `mise exec -- bun run test:e2e`               | Built editor in Playwright Chromium, Firefox, and WebKit; live Worker | Docker and installed browsers; starts a local server when needed outside CI |
| `mise exec -- bun run test:storybook`         | Storybook in headless Chromium                                        | Installed Chromium and local sockets                                        |

Install the browser matrix with `mise exec -- bunx playwright install chromium firefox webkit` if it is absent. Storybook needs only Chromium. Linux CI also installs browser system dependencies; see [ci.yml](../.github/workflows/ci.yml).

Integration tests target `TEST_BASE_URL`, defaulting to `https://localhost:3000`, and do not start a server. Node test clients trust the generated local certificate while remote targets keep normal TLS verification. Playwright accepts local test certificates and starts a fresh server locally unless `TEST_BASE_URL` explicitly selects an existing server. CI expects an already-running server. E2E uses one worker locally and in CI to avoid competing native Docker setup. These suites create and clean up test projects through development-only helpers; point them at a local or isolated test instance.

Keep the Workers compatibility date at `2026-04-01` or later so containers use private PID namespaces by default. Each container needs its own process namespace so destruction also terminates native preview servers and command subprocesses. This is required for CI's rootless Docker without cgroups; sharing the host namespace leaves surviving children that block container teardown. The live Computer integration suite checks that computerd runs as PID 1 and that project cleanup completes.

The `workerd` package override pins the local runtime to a release that supports the configured compatibility date. Keep that pin current when advancing the date so preview isolates and Worker tests exercise the same runtime behavior.

The Bun patch for `@cloudflare/vitest-pool-workers` keeps the Vitest 3 adapter compatible with that runtime: it reserves the `connect` handler and explicitly requests ArrayBuffer frames for the test transport. Remove the patch when upgrading to a test adapter that includes these fixes.

E2E builds the editor and serves its frontend files through a [browser fixture](../test/e2e/built-editor.ts) that preserves the live Worker's response policy. APIs, authentication, and hosted project runtimes remain live. This tests the production frontend without replacing the backend or security headers.

Full Worker runs use [test-worker.ts](../scripts/test-worker.ts) to start fresh batches below workerd's heap limit. Large preview-runtime integrations and D1 fixture suites run in separate processes. Targeted runs and watch mode use Vitest directly through the same script:

```bash
mise exec -- bun run test:worker --run worker/lib/computer-exec.test.ts
mise exec -- bun run test:react --run src/features/agent/components/agent-panel/messages.test.tsx
```

The older Worker Vitest pool cannot execute the session facets used in production. `test:agent` runs them through the production bundle with the current Miniflare runtime and deployment compatibility flags. Its test-only entrypoint supplies a controlled Workers AI transport and disables the external documentation connection; the application agent classes, scheduler, provider adapter, and workspace tools run unchanged. Keep this suite in CI when changing the agent SDK, session state, cancellation, or conversation persistence.

## Required checks

[AGENTS.md](../AGENTS.md#definition-of-done) defines the repository's completion requirements. Run formatting, typechecking, Knip, and all test commands above. Add appropriate regression coverage for significant behavior changes and check the README when changing setup or public behavior.

```bash
mise exec -- bun run format
mise exec -- bun run typecheck
mise exec -- bun run knip
git diff --check
```

Formatting applies Prettier and ESLint fixes across the root package. Review the resulting diff for unrelated changes. Typechecking covers application, Worker, Node configuration, and scripts. The strict export audit is separate from the Knip gate; see [Knip audit guidance](knip-audit.md).

For landing changes, install its locked dependencies and run its checks from `landing/`:

```bash
mise exec -- bun install --frozen-lockfile
mise exec -- bun run check
mise exec -- bun run build
```

Keep validation results in the pull request or CI output. A previous passing run is not evidence for a later change.

## Docker and Linux troubleshooting

Computer's container cache exclusions require FUSE. Docker Desktop on macOS/WSL supplies it. Linux development and CI use rootless Docker with `/dev/fuse` available; rootful Docker's userspace fallback does not support this configuration.

CI pins Ubuntu 24.04 and Docker 29.9.1 to keep the browser libraries and rootless container runtime reproducible. Playwright caches include the resolved package version, OS release, and architecture. Validate the live integration and browser suites when updating these pins.

To verify the pinned image independently of the development server:

```bash
docker build --platform linux/amd64 -f Dockerfile.computer -t worker-ide-computer:0.4.1 .
```

On Linux, workerd's gateway and the rootless Docker daemon must share network access. CI keeps the bridge namespace attached to the daemon and runs the dev server and live tests in the daemon's network and mount namespaces while preserving the repository working directory. The mount namespace supplies RootlessKit's DNS resolver. CI explicitly preserves the runner's home, Docker connection, credentials, and test settings with `sudo --preserve-env=...`; `sudo-rs` ignores `sudo -E`. Preserve this arrangement when changing CI; otherwise containers may start but package installation or gateway traffic can fail.

When live tests fail, check Docker availability, `/dev/fuse`, DNS from the daemon namespace, and the dev-server startup log. CI captures container state and logs on failure. A workerd heap failure in a full Worker run calls for checking batching, rather than starting Docker. See [Computer workspace](computer-workspace.md) for command deadlines, synchronization behavior, and recovery constraints.

## Generated artifacts and deployment

CI lets an in-progress `main` run finish while retaining the newest pending update, so repeated pushes cannot starve deployment. Pull request checks still cancel superseded runs. Deployments remain gated on successful CI and run serially.

[scripts/deploy.ts](../scripts/deploy.ts) is the shared local and CI deployment sequence. The host Worker uses the compatibility flags in [wrangler.jsonc](../wrangler.jsonc), currently `nodejs_compat`; preserve the deployable configuration instead of copying broad experimental flags from runtime examples.

| Artifact                                                  | Generator                                                                 |
| --------------------------------------------------------- | ------------------------------------------------------------------------- |
| Worker binding declarations (`worker-configuration.d.ts`) | `mise exec -- bun run cf-typegen`                                         |
| Worker TypeScript declarations used by the app            | `mise exec -- bun run build:worker-types`                                 |
| `vendor/*.wasm`                                           | [vendor-wasm.ts](../scripts/vendor-wasm.ts), run by postinstall           |
| `auxiliary/vite-host/vendor/`                             | [vendor-vite-host.ts](../scripts/vendor-vite-host.ts), run by postinstall |

Review generated changes alongside the dependency, schema, or configuration change that produced them. Keep Computer's package version aligned with the computerd image in [Dockerfile.computer](../Dockerfile.computer).
