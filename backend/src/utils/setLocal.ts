/**
 * setLocal — write a key to both `app.locals` (sync, authoritative for this
 * process run) and the AppStateStore (async, best-effort, survives restart).
 *
 * Usage (in a route handler):
 *   import { setLocal } from '../../utils/setLocal';
 *   setLocal(req.app.locals, 'constraintOverrides', overrides);
 *
 * The AppStateStore call is fire-and-forget; failures are already logged by
 * AppStateStore.set() itself.
 */

import type { AppStateKey } from '../services/AppStateStore';

export function setLocal<T>(
  appLocals: Record<string, unknown> & { appState?: { set(key: AppStateKey, value: unknown): unknown } | null },
  key: AppStateKey,
  value: T
): void {
  appLocals[key] = value;
  // Best-effort persist — if appState is not yet wired (e.g., SCHEDULER DB
  // still connecting) the optional-chain silently skips the DB write.
  appLocals.appState?.set(key, value);
}
