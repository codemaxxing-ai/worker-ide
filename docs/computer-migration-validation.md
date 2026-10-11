# Computer migration validation

## October 11 production migration

PR #7 merged as `66b6035`; PR #8 corrected production compatibility flags and merged as `5e3ceee`. All nine CI checks passed for both the configuration PR and its merged release. Deploy run `38174590493` and its smoke test passed. The live version `0dd709ab-9d38-4e57-addc-c59d259cb09f` matched the deployment log before migration started.

The approved private Workflow instance `computer-v1-migrate-1791752757272` completed successfully: all 85 registered/stored project workspaces migrated and passed byte/tree verification. The refreshed union inventory remained the same 85 workspaces. Read-only instance `computer-v1-verify-1791752947910` verified all 85 with zero additional migrations. The sorted inventory SHA-256 is `e3e9aee97c177fafe829ebacb74fc2810c5aefa0e7f3ae5c6b8a570634942aad`. Full inventories, Workflow outputs, version checks and migration proof are saved in `/private/tmp/worker-ide-computer-rollout` on the rollout host; project identifiers are omitted here.

Canonical cleanup follows that production proof. It removes the legacy filesystem construction, storage selection, read/find/grep fallbacks, migration copier and status/retry RPCs. New projects initialize the Computer root directly. A missing verified marker on an existing project blocks filesystem reads, writes and execution while preserving retained data. Regression tests cover empty projects, persistence across eviction, untouched recovery rows and metadata, cached access after marker loss, and incomplete/legacy store protection. Frozen recovery bytes, historical Durable Object identities and snapshot/review readers remain intact.

## October 11 recovery validation

Recovered the rollout after the original chat hit a rate-limit error. With Wrangler 4.137.0 and the Cloudflare Vite plugin 1.58.0, local format, typecheck, Knip, 595 unit tests, 920 Worker tests, 485 React tests, 102 Storybook tests, and 57 live integration tests passed. The complete 27-test browser suite passed without retries after the vinext template disabled its counter until hydration completed; before that fix, the first click could be lost while the server-rendered button was visible.

Linux CI passed all nine checks on `0d4931b`. Rootless Docker keeps its bridge namespace attached to the daemon; the dev server and tests enter its network and mount namespaces and preserve the repository working directory. The mount namespace supplies RootlessKit's DNS resolver. CI verifies DNS and FUSE access before starting the server and captures both startup and container diagnostics on failure.

The refreshed production inventory contained 85 registered projects and the same 85 stored filesystem objects. Migration and production verification completed as recorded above before removal of the legacy runtime.

PR #7's first deployment was rejected by Cloudflare because the broad `experimental` compatibility flag cannot be deployed. PR #8 retains only `nodejs_compat`, matching the current [Worker Loader configuration](https://developers.cloudflare.com/dynamic-workers/getting-started/#configure-worker-loader) and the application's previous production flags; generated runtime types were refreshed. The pinned Computer README's experimental flag example applies an unnecessary local flag to the host Worker. Local format, typecheck, Knip, 595 unit, 920 Worker, 485 React, 102 Storybook, 57 live integration and 27 browser tests passed for this corrected configuration. The full Worker/browser runs passed in isolation after an initial concurrent run encountered two Worker timeouts and a Miniflare initialization error; the final browser run used no retries.

## October 7 local validation

Verified locally on October 7, 2026, using the Node 24 and Bun 1.3.14 versions selected by `mise.toml`, workerd, Chromium, and Docker Desktop on macOS ARM64. Computer and the Linux amd64 computerd image are pinned to 0.4.1.

## Required checks

| Command                                                                                     | Result                                                                  |
| ------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| `mise exec -- bun run format`                                                               | Passed; Prettier and ESLint                                             |
| `mise exec -- bun run typecheck`                                                            | Passed; application, Worker, Node configuration, and scripts            |
| `mise exec -- bun run knip`                                                                 | Passed                                                                  |
| `mise exec -- bun run test:unit --run`                                                      | 595 tests passed across 42 files                                        |
| `mise exec -- bun run test:worker --run`                                                    | 919 tests passed across 116 files in 23 fresh batches                   |
| `mise exec -- bun run test:react --run`                                                     | 485 tests passed across 67 files                                        |
| `mise exec -- bun run test:integration --run`                                               | 57 tests passed across 3 files, including 5 live Computer runtime tests |
| `mise exec -- bun run test:e2e`                                                             | 27 tests passed; the vinext preview test required one retry             |
| `mise exec -- bun run test:storybook`                                                       | 102 tests passed across 29 files                                        |
| `docker build --platform linux/amd64 -f Dockerfile.computer -t worker-ide-computer:0.4.1 .` | Passed; the development server also built and ran this image            |
| `git diff --check`                                                                          | Passed                                                                  |

No required check remains blocked by the local environment. The installed Worker test pool reports a compatibility-date fallback from 2026-03-24 to 2026-03-10 and an optional `node:worker_threads` import warning. The Worker suites pass with these diagnostics. Production deployment was outside scope and was not performed.

The full E2E run's initial vinext counter click did not update its state; the test passed on retry. A focused run with `mise exec -- bun run test:e2e test/e2e/vinext-preview.test.ts --retries=0` then passed without retries. The Computer edit/execute/review/reject flow passed on its first attempt.

## Migration and runtime coverage

The migration release's Worker tests verified resumable copy and byte/tree verification for text, binary data, R2-backed files, directories, absolute and relative symlinks, `.git`, snapshots, initialization state, and pending change records. They covered interruption, retry after verification failure, missing blobs, and capacity errors while preserving legacy storage. Those copier tests were removed with the migration runtime after production verification; canonical protection tests replace them.

Runtime tests cover durable FIFO ordering, internal execution ownership, rejection of stale runtime filesystem facets, session attribution, cached execution IDs, reattachment, synchronization recovery without command replay, cancellation, bounded output, Plan/Ask restrictions, constrained plan/todo writes, shell networking restrictions, and the container HTTP gateway policy. Large text and binary files exceed SQLite's row limit; tests verify chunked queue payloads, workspace-backed change baselines, restart reconstruction, and missing-chunk detection.

The live Docker suite installs a package with Bun, runs Node 24, Git and Python, and verifies editor-to-container and container-to-editor synchronization for text, binary bytes, and symlinks. It also verifies two sessions competing with an editor save, completed-ID replay protection, snapshot rejection, cancellation of native descendants, synchronization of partial writes, and release of queued editor saves. Dependency caches are excluded from source changes.

React and Storybook tests cover native command results, backend and exit information, cancellation, and rich file output. The browser flow edits through the editor, executes a Computer command, reviews the resulting change, and rejects it to restore the editor baseline. Existing preview HMR and application browser suites also pass.

## Review fixes

Regression tests verify that Plan/Ask-to-Code transitions persist the new mode before snapshot initialization. Fresh executions validate paths, JSON input, and container preparation before recording a command; these failures release queued writes, while commands with uncertain outcomes retain ownership until synchronization succeeds.

State writes, binary writes, and appends resolve final, parent-directory, and dangling symlinks before capturing changes. Snapshot rejection restores the actual source files and preserves the links. Snapshot restoration also handles directory-to-file and file-to-directory changes in dependency order, preserving binary children and symlinks.

Computer's local Git client uses the authoritative workspace. Worker and live isolate tests cover init, add, commit, status, and `git -C /project diff`; network Git commands remain blocked with and without `-C`.

## Test configuration and delivery

Ordinary Worker tests use controlled runtime doubles and do not start Docker. Fresh Worker batches avoid the workerd heap limit; preview-runtime and D1 fixture suites run in separate processes. Live integration and E2E run against the Docker-aware development server. The gateway CA is installed in the container trust store and supplied to Node/Bun so package installation works through the HTTPS gateway.

The custom Bash runtime was removed after shell parity and lifecycle checks passed. `tools.bash` delegates to Computer's isolate shell. Historical Durable Object migrations and project identities are preserved. Legacy SQLite/R2 recovery data is retained, and migration changed the active-store marker only after verification. The October 7 validation did not deploy production or delete recovery data; production migration was completed on October 11 as recorded above.
