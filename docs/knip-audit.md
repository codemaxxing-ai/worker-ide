# Knip audit guidance

## Gate and strict audit

```bash
mise exec -- bun run knip
mise exec -- bun run knip:audit
```

The regular gate uses [knip.json](../knip.json) to check unused files and dependencies. Export, type, namespace, enum-member, and duplicate-export rules are disabled there.

The strict audit uses [knip-audit.json](../knip-audit.json) to enable those rules as warnings and include exports used only within their own file. It is a non-gating review tool. Use the current compact report for exact findings rather than maintaining counts in documentation.

This split preserves a useful CI gate while letting maintainers investigate exports that static analysis cannot prove safe to remove. A warning is evidence to inspect a boundary, not permission to delete its contract.

## Evaluating a finding

1. Check direct imports, reexports, tests, and consumers of the owning API or feature.
2. Check dynamic registries, module-name resolution, named/default export reflection, and tooling entrypoints. Knip may not trace these consumers.
3. Determine whether the symbol is an internal declaration, a compatibility entrypoint, or a runtime contract. Make local-only declarations private; remove them when unused. Preserve contracts unless their consumers are updated together.
4. Run the affected tests, typecheck, and regular Knip gate. Review the strict report again for unintended changes to the module surface.

Avoid broad deletion or new ignore rules just to suppress warnings. Change an ignore or entrypoint only when it describes a real loader or tooling boundary.

## Contracts requiring additional review

| Surface                                                                    | Why it may remain exported                                                                                                                                                              |
| -------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `shared/**`, including `shared/types.ts` and `shared/validation.ts`        | Cross-layer types, schemas, and compatibility barrels connect frontend, routes, and tools. Review removals with their consumers.                                                        |
| `src/lib/api-client.ts`, feature API modules, and feature `index.ts` files | Compatibility barrels and feature boundaries expose request functions and types. Update callers together when narrowing these surfaces.                                                 |
| Component properties, hook results, and feature types                      | Exported types describe module interfaces. Review them with the owning component or hook rather than deleting them solely for having no runtime cost.                                   |
| `worker/db/auth-schema.ts`, routes, and Workflows                          | Drizzle tooling, Hono RPC inference, and Workflow payloads consume these declarations as service boundaries.                                                                            |
| `worker/services/vite-host/**` and `worker/fixtures/vinext/**`             | Vite/vinext loaders resolve modules by name and inspect exports. Named/default pairs such as `statSync`/`lstatSync` and `transformWithOxc`/`transformWithEsbuild` serve shim contracts. |
| Agent tool modules and registries                                          | Tools and algorithm helpers may have dynamic consumers. Confirm registration and behavior before removal.                                                                               |
| Durable Object, library, and service interfaces                            | Exported implementation types or test support may form an intentional module boundary. Keep that boundary explicit or update its consumers in the same change.                          |

These are review considerations, not blanket exemptions. A symbol in one of these groups can still be removed when it is demonstrably internal and unused.
