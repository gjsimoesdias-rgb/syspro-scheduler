/**
 * Load the connected company's app state (pins, shifts, crews, markers, Auto
 * plan settings…) into app.locals. Runs at startup and after every
 * /api/status/connect, so switching SYSPRO company never carries the
 * previous company's state across.
 */
import AppStateStore from './AppStateStore';
import { companyDbOf } from './planStore';
import { logger } from '../utils/logger';
import type { AppLike } from '../types/appLocals';

export async function loadCompanyState(app: AppLike): Promise<AppStateStore | null> {
  const schedulerDb = app.locals.schedulerDb;
  if (!schedulerDb) return null;
  const companyDb = companyDbOf(app.locals.sysproDb);
  const previous: AppStateStore | null | undefined = app.locals.appState;
  const store = new AppStateStore(schedulerDb, companyDb);
  await store.ensureTable();
  await store.hydrateAppLocals(app.locals);
  app.locals.appState = store;
  if (previous && previous.companyDb !== companyDb) {
    // The Auto plan's last run / job fingerprint belong to the old company.
    app.locals.autoScheduler?.resetStatus?.();
    logger.info({ from: previous.companyDb, to: companyDb }, 'Switched company state');
  }
  return store;
}
