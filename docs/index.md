# Contributor documentation

These documents explain how the repository works, how to change it, and why its boundaries exist.

| Guide                                            | Use it for                                                                     |
| ------------------------------------------------ | ------------------------------------------------------------------------------ |
| [Architecture and ownership](architecture.md)    | Request routing, state owners, API patterns, and service boundaries            |
| [Hosted content isolation](content-isolation.md) | Origin boundaries, private previews, browser policy, and hosting configuration |
| [Computer workspace](computer-workspace.md)      | Filesystem access, execution backends, mutation ordering, review, and recovery |
| [Development and verification](development.md)   | Local setup, test environments, generated artifacts, and troubleshooting       |
| [Knip audit guidance](knip-audit.md)             | Evaluating unused exports and preserving runtime or compatibility contracts    |

The repository [README](../README.md) is the setup entrypoint. [AGENTS.md](../AGENTS.md) defines contributor conventions and required checks. Public architecture diagrams are rendered by [the landing docs pages](../landing/src/pages/docs/) from [docs-content.ts](../landing/src/data/docs-content.ts); keep those explanations consistent with these guides.

## What belongs here

Document current behavior, reusable patterns, operational procedures, and decisions that still constrain changes. For a decision, explain the chosen approach, the reason, and the consequences. Link to the owning source or configuration so readers can verify the behavior.

Keep implementation plans, task checklists, rollout timelines, audit counts, test-run results, and progress updates in issues, pull requests, or CI artifacts. Git history preserves earlier documentation; completed work does not need a status log here.

When behavior changes, update its guide and any public diagram in the same change. Replace obsolete guidance, preserve relevant rationale, and fix incoming links when renaming a document.
