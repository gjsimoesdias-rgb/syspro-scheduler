# Security & dependency audit policy

`npm audit` against `frontend/` reports ~38 advisories. Most of them live
inside the React-Scripts (Create-React-App) toolchain and are dev-time
only — they never ship to a browser. Here is the triage so future
maintainers don't waste time chasing red boxes.

## Fixed (production paths)

| Package | Where it was | Fix |
|---|---|---|
| `axios` | frontend runtime (used by `services/api.ts` and `bulkImportService.ts`) | Pinned to `^1.16.0` in `frontend/package.json`. This package is shipped to the browser; the prototype-pollution / SSRF advisories there are real. |

## Accepted (dev-only, behind react-scripts 5)

CRA 5.0.1 hasn't been updated since early 2022 and the only "fix" `npm
audit fix --force` offers is `react-scripts@0.0.0` — which removes the
build tool entirely. We accept the following advisories until/unless
the project migrates off CRA (planned move: Vite, see
`ENHANCEMENT_PLAN.md` § P2 #23):

- `nth-check` / `css-select` / `svgo` — only run during `npm run build`,
  on developer machines and CI. No browser-side exposure.
- `serialize-javascript` / `webpack-dev-server` — both are dev-time. The
  webpack-dev-server advisory specifically affects browsing untrusted
  sites *while running the dev server*, which is moot for an internal
  APS console.
- `postcss` — same, dev-only.
- `lodash` (transitive via react-scripts test runner) — only loaded by
  Jest. Application code does not import lodash.
- `minimatch` (transitive via `@typescript-eslint`) — runs at lint time.
- `underscore` / `jsonpath` / `bfj` — debug/dev paths only.
- `@tootallnate/once` — transitive of `jsdom` used by Jest.

## Backend audit

The single warning on the backend (`@azure/identity` / `tedious` / `mssql`)
ships in production. The "fix" upgrades `mssql` from 9.x to 12.x, which
is a major version bump. We've **deferred** that bump because:

1. Our SQL Server queries use `Request.input()`, `withTransaction()`, and
   `mssql.Transaction` APIs which changed signatures across major versions.
2. We just rewrote `APSDatabaseService` to use those APIs heavily (Week 1).
3. The advisory chain (`@azure/identity → tedious`) only affects
   credential flows we don't use — we hit SQL with `userName / password`
   plus `trustServerCertificate: true`, never the Azure AD path.

If you ever switch the backend to Azure AD auth, prioritise the bump to
`mssql@12`.

## Adding new dependencies

When adding a new package:

1. Prefer ones used in production code over dev-only.
2. Run `npm audit` *before* committing — keep the count from drifting up.
3. If you must accept a new advisory, add a row to the table above with
   the rationale.

## Reporting a vulnerability

Email gj.simoes.dias@gmail.com or open a private security advisory
through your normal channel. Do not file public issues for security bugs.
