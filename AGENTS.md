# Agents.md

This document is a collection of guidelines for agents working on the project.

## Definition of Done

- [ ] If you made significant changes, add appropriate tests (unit, integration, e2e, storybook) to cover them.
- [ ] You ran `bun run format` to format the code and it passes with no errors.
- [ ] You ran `bun run typecheck` to check for type errors and it passes with no errors.
- [ ] You ran `bun run knip` to check for unused dependencies, exports and files and it passes with no errors.
- [ ] You ran `bun run test:unit --run` to run unit tests and it passes with no errors.
- [ ] You ran `bun run test:worker --run` to run worker tests and it passes with no errors.
- [ ] You ran `bun run test:react --run` to run react tests and it passes with no errors.
- [ ] You ran `bun run test:integration --run` to run integration tests and it passes with no errors.
- [ ] You ran `bun run test:e2e` to run end-to-end tests and it passes with no errors.
- [ ] You ran `bun run test:storybook` to run storybook tests and it passes with no errors.
- [ ] You checked the `README.md` to make sure it is up to date.

## Coding Conventions

- All file names must use kebab-case (e.g., `my-component.tsx`, `api-client.ts`).
- Use TypeScript for all code.
- Use early returns when possible.
- Follow existing code patterns in the codebase.
- Always use the `cn` utility from `@/lib/utils` when merging or applying conditional classes.
- Use `undefined` instead of `null` (`unicorn/no-null` ESLint rule enforced). Exception: WebSocket wire format types in `shared/types.ts`.
- No `as` type assertions (`@typescript-eslint/consistent-type-assertions` enforced).
- No `forwardRef` — use React 19 ref-as-prop pattern.
- No abbreviated variable names (`unicorn/prevent-abbreviations` enforced). Use `AppEnvironment` not `AppEnv`, `properties` not `props` (in non-React contexts), etc.
- Install all dependencies as devDependencies (`bun add -d`) since everything is bundled with Vite.
- Use `bun` as the package manager (not npm/yarn/pnpm).

## API Communication (Hono RPC)

All frontend-to-backend API calls **must** use the Hono RPC client (`createApiClient(projectId)` from `@/lib/api-client`). This gives fully type-safe requests and responses inferred from route definitions. For non-project-scoped routes, use `createUserApiClient()`, `createOrgApiClient()`, or `createTransferApiClient()` from the same module.

**Rules:**

- **NEVER use raw `fetch()`** to call backend API routes. Always use the typed RPC client (e.g., `api.git.status.$get({})`). Root application routes use `createRootApiClient()`. External requests and SDK-owned authentication transports are separate from application API calls.
- **API route paths must use spinal-case** (e.g., `/user/push-vapid-key`, `/user/recent-projects`), not camelCase. Hono RPC resolves hyphenated path segments via bracket notation (e.g., `api.user['recent-projects'].$get({})`). File names remain kebab-case per the file naming convention.
- **NEVER use `response.text()` + `JSON.parse()`** to parse responses. The RPC client's `response.json()` returns the correctly typed result.
- **In the `!response.ok` branch**, use `throwApiError(response, fallback)` from `@/lib/api-error` when status, error codes, or server messages matter. Only that adapter may parse an untyped error body, validating it as `unknown`. A plain fallback `Error` is sufficient otherwise. Error payloads remain outside the Hono success schema.
- **In the success branch**, call `response.json()` directly — the return type is clean (no union with error types).

**Example (correct):**

```ts
const api = createApiClient(projectId);
const response = await api.git.status.$get({});
if (!response.ok) {
  throw new Error('Failed to get git status');
}
const data = await response.json(); // ← fully typed, no assertion needed
```

**Why this matters:** Hono infers response types from all `return c.json(...)` calls in a route. If a route returns both `c.json(successData, 200)` and `c.json({ error: '...' }, 500)`, the inferred type becomes an unresolvable union. We solved this by using `throw httpError()` for all errors (see Error Handling below), which keeps error types OUT of the route schema. Using raw `fetch()` or `response.text()` workarounds bypasses this type safety and must not be reintroduced.

## Error Handling in Route Handlers

All route handler errors **must** use `throw httpError(code, message, optionalStatus)` from `worker/lib/http-error.ts` instead of `return c.json({ error: '...' }, status)`. The status defaults to the shared `HttpErrorCode` mapping.

**Rules:**

- **NEVER use `return c.json({ error: '...' }, statusCode)`** in route handlers under `worker/routes/`. This pollutes Hono's typed response schema with error union types.
- **Always use `throw httpError(code, message, optionalStatus)`** — this throws an `HTTPException` that Hono handles outside the typed route schema, keeping return types clean for the RPC client.
- SDK-owned auth, development-only HTTP adapters, and routing middleware preserve their existing response contracts outside the typed API route schema.

**Example (correct):**

```ts
import { httpError } from '../lib/http-error';
import { HttpErrorCode } from '@shared/http-errors';

const route = new Hono<AppEnvironment>().post('/example', async (c) => {
  const data = await someOperation();
  if (!data) {
    throw httpError(HttpErrorCode.NOT_FOUND, 'Resource not found');
  }
  return c.json({ result: data });
});
```

## Cloudflare Workflows Guidance

Use Cloudflare Workflows for backend jobs that need durable, resumable orchestration across multiple steps. They are a good fit when work may take longer than a normal request, depends on external APIs or network I/O, benefits from retries, and can be represented as meaningful asynchronous status for the user.

Prefer Workflows when each step can be made idempotent and the user experience benefits from starting a job, polling status, and receiving a final result. They are especially useful when partial progress should be preserved across retries, restarts, or transient failures.

Prefer regular Workers or Durable Objects for fast request/response operations, low-latency reads, interactive actions, and work already naturally owned by a Durable Object. Choose the simplest reliable primitive for the job.

## React Best Practices

- If you can calculate something during render, you don't need an Effect.
- To cache expensive calculations, add useMemo instead of useEffect.
- To reset the state of an entire component tree, pass a different key to it.
- To reset a particular bit of state in response to a prop change, set it during rendering.
- Code that runs because a component was displayed should be in Effects, the rest should be in events.
- If you need to update the state of several components, it's better to do it during a single event.
- Whenever you try to synchronize state variables in different components, consider lifting state up.
- You can fetch data with Effects, but you need to implement cleanup to avoid race conditions.

## Project Structure

- **Group by Feature**: Organize files by feature, not type. Code that changes together stays together.
- **Reusable Components**: Place strictly reusable UI components in `src/components/ui/`.
- **Feature Modules**: Each part of the IDE has its own folder in `src/features/` containing its specific components, hooks, and utilities.
- Colocate unit tests with the code they test.
- E2E tests remain in `test/e2e/` directory.

## Directories

- `src/` - React app sources.
  - `components/` - Reusable UI components.
  - `features/` - Feature-based modules, one folder per IDE feature.
  - `lib/` - Shared utilities and libraries.
  - `hooks/` - Shared global hooks.
- `worker/` - Cloudflare Worker (API routes, Durable Objects, services).
- `shared/` - Shared code between frontend and worker (types, constants, validation, errors).
- `test/` - E2E tests.
- `.storybook/` - Storybook configuration.

## Tech Stack

### Frontend

- React 19 with TypeScript.
- Tailwind CSS v4 for styling.
- Zustand for client state management.
- CodeMirror 6 for the code editor.
- Hono RPC client for type-safe API calls.
- Vercel AI SDK for LLM calls. Cloudflare Agents SDK for agent state management.

### Backend

- Cloudflare Workers with Hono framework.
- Cloudflare Durable Objects for filesystem and project coordination.
- WebSockets (hibernation API) for real-time communication.
- Durable Objects SQLite for storage.
- Vercel AI SDK (`streamText`, `generateObject`) for the AI agent loop. Agents SDK for state sync and observability.

### Build and Tooling

- Runtime versions: use `mise install` and `mise exec -- bun ...`; `mise.toml` selects Node and Bun for local development and CI.
- Package manager: bun (use bun commands, not npm/yarn/pnpm).
- Build tool: Vite with @cloudflare/vite-plugin.
- Dev server: `bun run dev`.
- Turborepo for task caching.
- Install all dependencies as dev dependencies (`bun add -d`) since they are bundled with Vite.

## Testing & Quality

- Unit tests: Vitest (`bun run test:unit --run`).
- Worker tests: Vitest (`bun run test:worker --run`)
- Integration tests: Vitest (`bun run test:integration --run`).
- React component tests: Vitest + jsdom (`bun run test:react --run`).
- Component visual tests: Vitest + Storybook (`bun run test:storybook`).
- E2E tests: Playwright (`bun run test:e2e`).
- Linting: ESLint (`bun run lint`).
- Formatting: Prettier (`bun run format`).
- Report unused dependencies: Knip (`bun run knip`).
- Type checking: TypeScript (`bun run typecheck`).

## Worker Testing

Worker code runs in Cloudflare's workerd runtime, which requires special test configuration.

- Worker tests are located in `worker/**/*.test.ts` and `shared/**/*.test.ts`.
- Configuration uses `@cloudflare/vitest-pool-workers` — see `vitest.config.ts` for details.
- Tests run in a simulated Workers environment with isolated storage disabled.

## Accessibility Testing

Accessibility is built into the development workflow.

- Storybook includes `@storybook/addon-a11y` for real-time a11y audits in the UI.
- Stories display accessibility violations directly in the Storybook panel.
- Use semantic HTML elements and proper ARIA attributes.
- Ensure all interactive elements have unique, descriptive `id` attributes.
- Include visible focus indicators on all focusable elements.
- Use sufficient color contrast (neo-brutalism style helps with this).
- Test with keyboard navigation (Tab, Enter, Escape keys).

## Important Notes

- The `@server/*` path alias resolves to `./worker/*` at build time.
- Each project has one durable `@cloudflare/shell` `Workspace` (SQLite + R2) in the `DurableObjectFilesystem` DO, holding both the working tree and a real `.git`. There is no in-memory filesystem.
- Worker code must not import `node:fs/promises`. Use the `fs` proxy from `@worker/lib/project-fs` (a `node:fs/promises`-compatible view over the project Workspace via cross-DO RPC), bound per request with `runWithProjectStub(fsStub, fn)`.
- Git runs inside the DO via isomorphic-git against the local Workspace (`worker/durable/git-service.ts`); Cloudflare Artifacts remains the git remote. Git routes are thin pass-throughs to the DO's `git*` RPC methods.
- The global `Env` interface from `worker-configuration.d.ts` (generated by `bunx wrangler types`) is used for worker bindings.
- `AppEnvironment` in `worker/types.ts` references `Env` for its `Bindings`.
