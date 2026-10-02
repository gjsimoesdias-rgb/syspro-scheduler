/**
 * What the server keeps on app.locals: the live database connections, the
 * per-company state loaded from sch_AppState, and the background Auto plan.
 * Express types app.locals as Record<string, any>; code that only needs the
 * app (services, helpers) takes an AppLike instead so these are typed.
 */
import type DatabaseConnection from '../database/connection';
import type AppStateStore from '../services/AppStateStore';
import type { AutoScheduler } from '../services/autoScheduler';
import type { PinnedOperation } from '../types';

export type AppLocals = Record<string, unknown> & {
  sysproDb?: DatabaseConnection | null;
  schedulerDb?: DatabaseConnection | null;
  appState?: AppStateStore | null;
  autoScheduler?: AutoScheduler;
  pinnedOperations?: Record<string, PinnedOperation>;
  /** The planner's last Generate options (re-used by the Auto plan). */
  lastGenerateOptions?: Record<string, unknown>;
};

export interface AppLike {
  locals: AppLocals;
}
