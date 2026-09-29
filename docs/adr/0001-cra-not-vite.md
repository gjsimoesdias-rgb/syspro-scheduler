# ADR 0001 — Use CRA (Create React App) instead of Vite

**Date:** 2026-04-01  
**Status:** Superseded by ADR 0006 (Vite migration, 2026-05)

## Context

At project start the team needed a React toolchain with zero config, working TypeScript support, and Jest pre-wired. Two options were seriously evaluated: Create React App (CRA) and Vite.

## Decision

CRA was chosen because:

1. **Stability at the time** — the initial scaffolding sprint was on a tight timeline. CRA produces a working, well-understood build with no extra config.
2. **Jest included** — CRA ships `react-scripts test` backed by Jest with a jsdom environment. Vite requires manual wiring of Vitest or Jest.
3. **Team familiarity** — the development team had shipped several CRA projects and knew exactly which edge cases to watch for.

## Consequences

**Positive**
- Zero-configuration start: `npm start` worked on day one.
- Jest tests run with `npm test` without any additional setup.

**Negative**
- CRA is in maintenance mode since Meta archived the repo in 2023. No new features, slow security updates.
- Dev server restarts on every save are slower than Vite's HMR.
- Bundle splitting is limited without ejecting.
- ROADMAP item #57 plans migration to Vite once the app is stable.
