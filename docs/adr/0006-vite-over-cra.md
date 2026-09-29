# ADR 0006 — Migrate from CRA to Vite 8

**Date:** 2026-05
**Status:** Accepted
**Supersedes:** ADR 0001

## Context

CRA (Create React App) was chosen at project start (ADR 0001) for its zero-config setup and bundled Jest support. After the application stabilised, three problems became blocking:

1. **CRA is archived.** Meta archived the repo in 2023. Security updates arrive slowly and no new features are planned.
2. **Slow builds.** A full rebuild took 45–90 s; incremental HMR took 3–8 s. Vite's native-ESM dev server delivers sub-100 ms hot updates.
3. **Poor bundle splitting.** CRA uses a single `main.*.js` bundle; Vite's Rollup-based output supports fine-grained `manualChunks` and lazy loading.

ROADMAP items #57 and #58 planned the migration once the feature set was stable.

## Decision

Migrate the frontend build to **Vite 8** (using the `rolldown` bundler backend).

Key implementation choices:

| Choice | Reason |
|--------|--------|
| Keep `react-scripts test` for Jest | Vite dev server uses `import.meta.env`; Jest/jsdom cannot parse `import.meta`. CRA's babel-jest transform handles existing `.test.tsx` files without changes. |
| Vite `define` shim for `process.env` | Source code uses `process.env.REACT_APP_API_URL`; Vite replaces it at build time via `define: { 'process.env.REACT_APP_API_URL': ... }` so Jest tests (which never touch the define) continue to read `process.env` normally. |
| `manualChunks` as function (not object) | rolldown's `manualChunks` requires a function that returns a string key; object form is silently ignored. |
| Vite proxy for `/api`, `/health`, `/events` | Replaces CRA's `proxy` field in `package.json`. SSE (`/events`) requires `{ ws: true }`. |

## Consequences

**Positive**
- Dev server HMR: <100 ms per save (vs 3–8 s with CRA webpack).
- Vite `build` outputs 627 kB main bundle + 16 lazy chunks (code-split by tab panel).
- Active maintenance: Vite releases regularly, Rollup ecosystem is healthy.
- `size-limit` CI step now enforces per-chunk limits against `build/assets/index-*.js`.

**Negative**
- Two test commands exist: `npm test` (Jest via react-scripts) and `npm run build` (Vite). Team must know which is which.
- `vite/client` types don't include `process`; a `declare const process` shim is added to `react-app-env.d.ts` and `"types": ["node"]` is added to `tsconfig.json`.
- `index.html` must live at `frontend/` root (not `public/`) — Vite's entry point convention.
