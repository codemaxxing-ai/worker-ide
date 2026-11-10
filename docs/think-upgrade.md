# Think 0.23 upgrade

The beta release makes a clean cutover to Think 0.23.0, Agents 0.33.0,
Computer/computerd 0.8.0, Code Mode 0.5.6, AI SDK 7 and exactly pinned
`@ai-sdk/react` 4.0.170. Install with `mise exec -- bun install --frozen-lockfile`.
The published Think package requires Computer `^0.8.0`; Computer 0.10 is outside
that peer range. See the [published manifest](https://registry.npmjs.org/@cloudflare%2fthink/0.23.0)
and [Think changelog](https://github.com/cloudflare/agents/blob/agents%400.33.0/packages/think/CHANGELOG.md).

## API audit

The application audit covers the intervening Think 0.16–0.23 and Agents releases.

| Surface                                    | Current implementation                                                                                                         |
| ------------------------------------------ | ------------------------------------------------------------------------------------------------------------------------------ |
| Experimental session/memory imports        | `agents/sessions`, `agents/context`, Think's exported `Session`                                                                |
| Context forwarding and cached prompt calls | `configureContext()` and `this.context`; removed no-op cached prompt configuration                                             |
| Compactor options                          | `summarize`, `keepRecentTokens: 32_000`, threshold 100,000; removed ignored minimum-message/token-counter options              |
| Provider input budget                      | Final model wrapper checks the assembled input, output allowance and headroom                                                  |
| Hydration and media                        | Bounded inference view; page original transcript rows for UI history; Sessions attachments with `mediaEviction: false`         |
| Lifecycle                                  | Await Think startup, `beforeTurn`, `onStepEnd`, `onSubmissionStatus`, bounded `maxInterruptedAttempts`                         |
| Dynamic children                           | `dynamicAgents.get/delete`; `parentAgent` and authenticated `routeSubAgentRequest` remain current APIs                         |
| Queuing and streaming                      | Native `runTurn` submit ledger and `@cloudflare/think/react`; removed parent transcript, token relay and custom reconciliation |
| Finalization                               | Durable submission-keyed outbox, immutable workspace receipts, startup replay and idempotent review/log delivery               |
| Models                                     | `agents/models/ai-sdk`; removed `agents-models` alias                                                                          |
| Computer                                   | Direct `ctx.storage`, current shell/tool imports, `runtime.backends`, bounded output and spill files; matching daemon image    |
| Shell helpers                              | Removed `@cloudflare/shell`, `state.*`, `bash` and `list` aliases; guarded `tools.*` catalog                                   |
| Code Mode                                  | `createCodemodeRuntime`, `ToolSetConnector`, shared leaf validation/mode/cancellation/observation pipeline                     |
| Browser                                    | Agents `Browser` and `browserTool`; preview restrictions and constrained read tool for Plan/Ask                                |
| MCP                                        | Project-owned connections and public catalog/call methods; `includeMcpTools: false` prevents duplicate tools                   |
| Questions                                  | Successful structured result stops inference via `stopWhen`; pending question derived from persisted messages                  |
| Delegation                                 | Retained `runAgentTool`, native task streaming/progress and propagated cancellation                                            |
| Branches/search                            | Native Sessions branches and lazy indexing; no copied conversation stores                                                      |
| Extensions/skills                          | Removed unused extension machinery; no enabled application skill sources to migrate                                            |
| Other new SDK features                     | Messenger channels, actions, workflows and client approvals are unused; no alternate runtime introduced                        |

The project directory owns summaries, shared context, MCP and reviews. Each chat
owns its transcript, configuration, submissions and recovery. Tool orchestration
does not acquire a filesystem queue lease; each mutation leaf acquires it once.
Uncertain executions retain queue ownership until reconciliation, and inference
does not automatically replay a turn that may have mutated the workspace.

## Release cutover

This is an operational cutover, not an in-place SDK storage migration. Do not
deploy it while the old harness is admitting or executing work.

1. Put the agent entry points into maintenance mode at the edge, blocking new
   submissions and regeneration while keeping project file access available.
2. Stop and drain all old turns and queued submissions. Confirm Computer has no
   starting, running or synchronization-pending execution. Reconcile uncertain
   executions before continuing; do not replay them.
3. Back up the current deployment and filesystem recovery data. Deploy the new
   Worker and matching Computer 0.8.0 container together. Wrangler migration
   `v11-think-sessions` creates `ProjectAgent` and retires `AgentRunner`; all
   historical migrations remain unchanged. The filesystem DO namespace stays
   intact.
4. The fresh project agent queues generated-artifact cleanup under the existing
   filesystem FIFO, then initializes shared context/MCP and becomes ready. It
   clears old agent sessions, snapshots, plans, todos and generated logs. It preserves project
   source, `.git`, configuration, Computer baselines and frozen recovery data.
5. Verify an existing workspace, fresh conversation, direct stream/reconnect,
   command synchronization and change review. Reopen admissions after readiness
   and these checks pass.

Old conversations, memory and review state are intentionally unavailable. Do not
restore the retired agent namespace into the new classes or reset the filesystem
DO. A rollback involving existing new turns requires draining them first; retain
their filesystem recovery records.

## Verification

Run every command through `mise exec -- bun`: `format`, `typecheck`, `knip`,
`test:unit --run`, `test:worker --run`, `test:react --run`,
`test:integration --run`, `test:e2e`, `test:storybook`, `build` and `test:agent`.
Live integration/E2E tests require a migrated development database, a running
development server, Docker and local test authentication. The production-bundle
agent suite supplies controlled providers and does not need live AI credentials.

Review cancellation, deduplication, queued withdrawal, recovery/outbox replay,
receipt ownership across restart, protected paths/symlinks, direct/Code Mode
parity, browser/MCP failures, image/history/branch behavior and independent tab
selection. For the panel, inspect desktop/mobile rendering, focus order,
resizing, command output and streamed argument performance.
