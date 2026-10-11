# Computer migration validation

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

Worker tests verify resumable copy and byte/tree verification for text, binary data, R2-backed files, directories, absolute and relative symlinks, `.git`, snapshots, initialization state, and pending change records. They cover interruption, retry after verification failure, missing blobs, and capacity errors while preserving legacy storage.

Runtime tests cover durable FIFO ordering, internal execution ownership, rejection of stale runtime filesystem facets, session attribution, cached execution IDs, reattachment, synchronization recovery without command replay, cancellation, bounded output, Plan/Ask restrictions, constrained plan/todo writes, shell networking restrictions, and the container HTTP gateway policy. Large text and binary files exceed SQLite's row limit; tests verify chunked queue payloads, workspace-backed change baselines, restart reconstruction, and missing-chunk detection.

The live Docker suite installs a package with Bun, runs Node 24, Git and Python, and verifies editor-to-container and container-to-editor synchronization for text, binary bytes, and symlinks. It also verifies two sessions competing with an editor save, completed-ID replay protection, snapshot rejection, cancellation of native descendants, synchronization of partial writes, and release of queued editor saves. Dependency caches are excluded from source changes.

React and Storybook tests cover native command results, backend and exit information, cancellation, and rich file output. The browser flow edits through the editor, executes a Computer command, reviews the resulting change, and rejects it to restore the editor baseline. Existing preview HMR and application browser suites also pass.

## Review fixes

Regression tests verify that Plan/Ask-to-Code transitions persist the new mode before snapshot initialization. Fresh executions validate paths, JSON input, and container preparation before recording a command; these failures release queued writes, while commands with uncertain outcomes retain ownership until synchronization succeeds.

State writes, binary writes, and appends resolve final, parent-directory, and dangling symlinks before capturing changes. Snapshot rejection restores the actual source files and preserves the links. Snapshot restoration also handles directory-to-file and file-to-directory changes in dependency order, preserving binary children and symlinks.

Computer's local Git client uses the authoritative workspace. Worker and live isolate tests cover init, add, commit, status, and `git -C /project diff`; network Git commands remain blocked with and without `-C`.

## Test configuration and delivery

Ordinary Worker tests use controlled runtime doubles and do not start Docker. Fresh Worker batches avoid the workerd heap limit; preview-runtime and D1 fixture suites run in separate processes. Live integration and E2E run against the Docker-aware development server. The gateway CA is installed in the container trust store and supplied to Node/Bun so package installation works through the HTTPS gateway.

The custom Bash runtime was removed after shell parity and lifecycle checks passed. `tools.bash` delegates to Computer's isolate shell. Historical Durable Object migrations and project identities are preserved. Legacy SQLite/R2 recovery data is retained, and migration changes the active-store marker only after verification. No production deployment or legacy recovery-data deletion was performed.
