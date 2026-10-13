# Computer workspace

## One authoritative project tree

Each project has one SQLite workspace provided by `@cloudflare/computer`, owned by the existing `DurableObjectFilesystem` binding. Source files, `.git`, and `.agent` live under `/workspace`. Keeping them together gives editor saves, agent tools, Git, and review operations the same durable tree across Durable Object eviction.

The implementation is [ProjectFilesystem](../worker/durable/project-filesystem.ts). Preserve the binding name and project object identity when changing its internals: creating another object would create another storage owner.

[ComputerWorkspace](../worker/lib/computer-workspace.ts) maps root-relative RPC paths and application `/project` paths to `/workspace`. Use these adapters when crossing a boundary; do not create a second working tree or bypass their path containment checks.

## Access from Worker services

Use the `fs` proxy from [project-fs.ts](../worker/lib/project-fs.ts) for filesystem operations in Worker services. It provides a `node:fs/promises`-compatible view over cross-DO RPC. Bind it with `runWithProjectStub` for the lifetime of the operation:

```ts
import { fs, runWithProjectStub } from '@worker/lib/project-fs';

const content = await runWithProjectStub(fsStub, () => fs.readFile('/project/src/main.ts', 'utf8'));
```

The [project HTTP middleware](../worker/http/project-app.ts) establishes this context for project API requests. Background work must establish its own context. Pass the session ID as `runWithProjectStub`'s fourth argument when attributing agent mutations; non-session callers omit it. Worker services must not import `node:fs/promises` to access project files.

[GitService](../worker/durable/git-service.ts) runs `isomorphic-git` inside the filesystem DO through the workspace adapter. The real Git objects, refs, and index stay beside the working tree; Cloudflare Artifacts remains the remote. Git routes validate requests, call the DO's `git*` RPC methods, and broadcast status changes. Keep Git work in the DO so it participates in the same mutation ordering as editor and agent writes.

## Execution backends

| Backend          | Use for                                                      | Limits and network access                                                                                                                       |
| ---------------- | ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `auto` (default) | Selects before dispatch from the shell command AST           | Uses `shell` for supported commands; native tools, installs, network commands, dynamic commands, and full test runners use `container`          |
| `shell`          | Lightweight shell commands and local Git operations          | Isolate shell; 30-second deadline; no direct networking                                                                                         |
| `container`      | Native binaries, package installation, and full test runners | Lazy per-project `standard-1` Linux container; five-minute command deadline; two-minute idle timeout; public HTTP(S) through the policy gateway |

Both backends operate on the same workspace. The shell SDK supplies Code Mode's `state.*` helper over the Computer-backed workspace client. Use foreground commands; use the existing preview infrastructure for application servers.

Previews and deployment builds also select a runtime from the manifest and Vite configuration. Simple static/React templates stay on Workers; vinext and custom Vite projects use the lazy container. `workerIde.runtime` in `package.json` may pin `worker` or `container`. Existing vinext projects need native-compatible Vite/React plugin versions; the template uses Vite 8 and React plugin 6 for vinext 0.1.8's `parseSync` API. Container Vite runs against a staging copy synchronized directly from canonical SQLite bytes after queued mutations, providing real WebSocket HMR without background writes to authoritative source. Native source transfers are capped at 12 MiB of encoded content, and build artifacts at 8 MiB.

[Dockerfile.computer](../Dockerfile.computer) pins computerd and Bun and supplies Node, Git, Python, native build tools, and FUSE. Keep the Computer package and computerd image versions aligned. The container installs Cloudflare's injected gateway CA into its trust store and provides it to Node and Bun for package-manager HTTPS requests.

[ComputerEgress](../worker/lib/computer-egress.ts) controls container HTTP(S). Private hosts, credentialed URLs, and deployment hosts are restricted. Use the existing domain, deployment, MCP, and browser tools for their privileged operations rather than weakening the execution gateway.

Dependency caches and generated container outputs such as `node_modules`, `.cache`, `.bun`, `.next`, `dist`, `coverage`, and `tmp` are excluded from source synchronization and review. They are runtime material, not authoritative source files; do not store source that needs review in an excluded directory.

## Mutation ownership and recovery

Editor, agent, Git, lifecycle, and review mutations share the [durable FIFO queue](../worker/lib/computer-mutation-queue.ts). A new mutation must enter through the queued DO boundary. Runtime filesystem facets retain the original execution's ownership, and stale facets cannot write after that ownership changes.

Execution completion includes synchronization and session change attribution. Releasing ownership as soon as a process exits would allow a queued editor save to race with container output being pulled into the workspace.

Use durable execution IDs to recover interrupted work:

- A completed ID returns its stored result for the owning session.
- A recorded execution without a result reattaches to the runtime command.
- A synchronization failure keeps queue ownership and reports pending status. Recovery retries synchronization without replaying the command.
- Cancellation kills the runtime command before final synchronization releases queued writes. Partial writes still need synchronization and attribution.

Validation of paths, JSON input, and container preparation happens before recording a potentially dispatched command. Known preparation failures may release the queue; uncertain execution outcomes must retain ownership. Never resolve uncertainty by submitting the command again under a fresh ID.

## Modes, changes, and review

Plan and Ask expose read-only source tools. The DO also enforces write restrictions so tool filtering cannot be bypassed through another RPC path. Plan/todo tools can write only their constrained session documents through typed RPC. Mode transitions must persist the new mode before snapshot initialization.

[ComputerChanges](../worker/lib/computer-changes.ts) attributes changes to sessions and captures baselines. Preserve file bytes, binary content, and symlinks when recording or restoring changes. Resolve symlink targets before capturing mutations so rejecting a change restores the modified source and preserves the link.

[Snapshot restoration](../worker/lib/computer-snapshots.ts) and [review resolution](../worker/lib/computer-review.ts) run through the mutation queue. File-to-directory and directory-to-file replacements require dependency ordering when restoring children. Large payloads use chunked queue storage and workspace-backed baselines to avoid SQLite row limits; missing chunks must be reported rather than silently dropping content.

## Existing-project protection

New projects initialize the Computer root directly. Existing projects require the verified `project-active-store` marker. If an existing project lacks that marker, reads, writes, and execution fail with a workspace recovery error. This prevents an incomplete or damaged store from appearing as an empty replacement project.

Frozen legacy SQLite/R2 recovery data and historical snapshot/review readers remain available for retained records. There is no legacy runtime fallback or migration status/retry RPC. Preserve the recovery bytes, metadata, storage keys, and historical Durable Object identities.

For a recovery error, inspect the existing object's marker and retained metadata before making changes. Do not mark it verified, initialize a replacement, or delete retained data merely to clear the error. A recovery must establish the workspace's integrity before ordinary access resumes.

## Verification boundaries

Use [development and verification](development.md) for commands and environment setup. Workspace changes need coverage at the boundary they affect:

| Boundary                                       | Regression coverage                                                                                                              |
| ---------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------- |
| Canonical store and retained data              | [computer-canonical.test.ts](../worker/durable/computer-canonical.test.ts)                                                       |
| Queue ownership and interruption               | [computer-mutation-queue.test.ts](../worker/lib/computer-mutation-queue.test.ts)                                                 |
| Execution IDs, synchronization, and modes      | [computer-exec.test.ts](../worker/lib/computer-exec.test.ts)                                                                     |
| Isolate shell and gateway policy               | [computer-shell.test.ts](../worker/lib/computer-shell.test.ts), [computer-egress.test.ts](../worker/lib/computer-egress.test.ts) |
| Review restoration                             | [computer-review.test.ts](../worker/lib/computer-review.test.ts)                                                                 |
| Native tools and bidirectional synchronization | [computer.integration.test.ts](../test/integration/computer.integration.test.ts)                                                 |

Ordinary Worker tests use controlled runtime doubles. The live Docker suite exercises real package installation, text/binary/symlink synchronization, competing mutations, cancellation, and execution replay protection. Keep both forms of coverage: doubles verify ownership rules, while live tests verify the runtime integration.
