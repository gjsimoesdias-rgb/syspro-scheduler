/**
 * Background autoschedule — re-plans on a timer and/or when SYSPRO jobs change,
 * into a dedicated what-if ("Auto plan"). The master is never touched: the
 * planner compares and commits from Versions as usual.
 *
 * Runs the same /api/schedule/generate handler as the Generate button, with the
 * planner's last-used options and the planning window moved to start now.
 */
import crypto from 'crypto';
import { logger } from '../utils/logger';
import { setLocal } from '../utils/setLocal';
import { getVersion, createWhatIf } from './ScheduleStore';
import SysproDatabaseService from './SysproDatabaseService';
import { AuditLogService } from './AuditLogService';

export const AUTO_PLAN_VERSION_ID = 'whatif-auto-plan';
export const AUTO_PLAN_NAME = 'Auto plan';

export interface AutoScheduleConfig {
  enabled: boolean;
  /** Re-plan at least this often (minutes); 0 = only on change. */
  intervalMinutes: number;
  /** Re-plan when open SYSPRO jobs change (checked every checkMinutes). */
  onJobChange: boolean;
  checkMinutes: number;
  /** Company whose settings the run uses, and who switched it on. */
  companyId?: number | string;
  enabledBy?: string;
}

export interface AutoScheduleStatus {
  running: boolean;
  lastRunAt?: string;
  lastReason?: string;
  lastResult?: { ok: boolean; jobs?: number; scheduled?: number; unscheduled?: number; late?: number; ms?: number; error?: string };
  lastCheckAt?: string;
  lastFingerprint?: string;
  nextRunAt?: string;
}

export const DEFAULT_AUTO_CONFIG: AutoScheduleConfig = {
  enabled: false, intervalMinutes: 60, onJobChange: true, checkMinutes: 5,
};

export function normaliseAutoConfig(raw: any, prev: AutoScheduleConfig = DEFAULT_AUTO_CONFIG): AutoScheduleConfig {
  const num = (v: any, d: number, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  };
  return {
    enabled: raw?.enabled === undefined ? prev.enabled : !!raw.enabled,
    intervalMinutes: num(raw?.intervalMinutes, prev.intervalMinutes, 0, 24 * 60),
    onJobChange: raw?.onJobChange === undefined ? prev.onJobChange : !!raw.onJobChange,
    checkMinutes: num(raw?.checkMinutes, prev.checkMinutes, 1, 120),
    companyId: raw?.companyId ?? prev.companyId,
    enabledBy: raw?.enabledBy ?? prev.enabledBy,
  };
}

/** What the open SYSPRO jobs look like, for change detection. */
export function jobsFingerprint(jobs: Array<any>): string {
  const rows = jobs.map((j) => [
    String(j.jobId).trim(), Number(j.quantity) || 0, new Date(j.dueDate).getTime() || 0, j.status ?? '',
    (j.operations || []).map((o: any) => `${o.opId}:${o.status ?? ''}:${o.workcentreId ?? ''}:${Math.round(Number(o.duration) || 0)}`).join(','),
  ].join('|')).sort();
  return crypto.createHash('sha1').update(rows.join('\n')).digest('hex');
}

/** Pure decision: should a tick run now, check for changes, or wait? */
export function decideAutoRun(cfg: AutoScheduleConfig, st: AutoScheduleStatus, now: Date):
  { action: 'run'; reason: string } | { action: 'check' } | { action: 'wait' } {
  if (!cfg.enabled || st.running) return { action: 'wait' };
  const since = (iso?: string) => (iso ? now.getTime() - new Date(iso).getTime() : Infinity);
  if (!st.lastRunAt) return { action: 'run', reason: 'first run' };
  if (cfg.intervalMinutes > 0 && since(st.lastRunAt) >= cfg.intervalMinutes * 60000) {
    return { action: 'run', reason: `every ${cfg.intervalMinutes} min` };
  }
  if (cfg.onJobChange && since(st.lastCheckAt) >= cfg.checkMinutes * 60000) return { action: 'check' };
  return { action: 'wait' };
}

type Handler = (req: any, res: any) => Promise<any>;

export class AutoScheduler {
  private timer: NodeJS.Timeout | null = null;
  readonly status: AutoScheduleStatus = { running: false };

  constructor(private app: any, private generate: Handler) {}

  get config(): AutoScheduleConfig {
    return normaliseAutoConfig(this.app.locals.autoSchedule || {});
  }

  setConfig(raw: any): AutoScheduleConfig {
    const cfg = normaliseAutoConfig(raw, this.config);
    setLocal(this.app.locals, 'autoSchedule', cfg);
    this.updateNextRun();
    return cfg;
  }

  start(tickMs = 60000): void {
    if (this.timer) return;
    this.timer = setInterval(() => { void this.tick(); }, tickMs);
    this.timer.unref?.();
    this.updateNextRun();
  }

  stop(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
  }

  private updateNextRun() {
    const cfg = this.config;
    if (!cfg.enabled) { this.status.nextRunAt = undefined; return; }
    const base = this.status.lastRunAt ? new Date(this.status.lastRunAt).getTime() : Date.now();
    this.status.nextRunAt = cfg.intervalMinutes > 0 ? new Date(base + cfg.intervalMinutes * 60000).toISOString() : undefined;
  }

  private syntheticUser() {
    const cfg = this.config;
    return { sub: 0, username: 'auto-schedule', role: 'planner', companyId: cfg.companyId };
  }

  async tick(now = new Date()): Promise<void> {
    const decision = decideAutoRun(this.config, this.status, now);
    if (decision.action === 'wait') return;
    if (decision.action === 'run') { await this.runNow(decision.reason); return; }
    // check for SYSPRO job changes
    this.status.lastCheckAt = now.toISOString();
    try {
      const db = this.app.locals.sysproDb;
      if (!db) return;
      const fp = jobsFingerprint(await new SysproDatabaseService(db).getOpenJobs());
      if (this.status.lastFingerprint && fp !== this.status.lastFingerprint) {
        await this.runNow('SYSPRO jobs changed');
      } else if (!this.status.lastFingerprint) {
        this.status.lastFingerprint = fp;
      }
    } catch (err) {
      logger.warn({ err }, 'Auto plan: change check failed');
    }
  }

  async runNow(reason: string): Promise<AutoScheduleStatus> {
    if (this.status.running) return this.status;
    const db = this.app.locals.sysproDb;
    this.status.running = true;
    const started = Date.now();
    try {
      if (!db) throw new Error('SYSPRO database not connected');
      if (!(await getVersion(db, AUTO_PLAN_VERSION_ID))) {
        await createWhatIf(db, { name: AUTO_PLAN_NAME, createdBy: 'auto-schedule', newId: AUTO_PLAN_VERSION_ID });
      }
      const opts = { ...(this.app.locals.lastGenerateOptions || {}) };
      const horizonDays = Number(opts.horizonDays) > 0 ? Number(opts.horizonDays) : 14;
      delete opts.horizonDays;
      const start = new Date();
      const body = {
        ...opts,
        planningHorizonStartDate: start.toISOString(),
        planningHorizonEndDate: new Date(start.getTime() + horizonDays * 86400000).toISOString(),
        versionId: AUTO_PLAN_VERSION_ID,
      };
      let statusCode = 200;
      let payload: any;
      const req: any = {
        app: this.app, body, headers: {}, query: {}, params: {},
        user: this.syntheticUser(), autoSchedule: true,
        log: logger.child({ autoSchedule: true, reason }),
      };
      const res: any = {
        status(code: number) { statusCode = code; return res; },
        json(obj: any) { payload = obj; return res; },
      };
      await this.generate(req, res);
      if (statusCode >= 400) throw new Error(payload?.error || `Generate failed (${statusCode})`);
      const js = payload?.schedule?.jobSchedules || [];
      const m = payload?.schedule?.metrics || {};
      this.status.lastResult = {
        ok: true, jobs: js.length,
        scheduled: m.totalJobsScheduled ?? js.filter((j: any) => j.operationSchedules?.length).length,
        unscheduled: m.jobsUnscheduled ?? 0,
        late: m.jobsTardy ?? js.filter((j: any) => Number(j.estimatedTardiness) > 0).length,
        ms: Date.now() - started,
      };
      // Remember the job state this plan was built from.
      try { this.status.lastFingerprint = jobsFingerprint(await new SysproDatabaseService(db).getOpenJobs()); } catch { /* next check sets it */ }
      logger.info({ reason, ...this.status.lastResult }, 'Auto plan updated');
    } catch (err: any) {
      this.status.lastResult = { ok: false, error: err?.message || String(err), ms: Date.now() - started };
      logger.warn({ err, reason }, 'Auto plan run failed');
    } finally {
      this.status.running = false;
      this.status.lastRunAt = new Date().toISOString();
      this.status.lastCheckAt = this.status.lastRunAt;
      this.status.lastReason = reason;
      this.updateNextRun();
      const schedulerDb = this.app.locals.schedulerDb;
      if (schedulerDb) {
        new AuditLogService(schedulerDb).log({
          actorId: 'auto-schedule', action: 'auto_plan_run', entityType: 'plan_version',
          entityId: AUTO_PLAN_VERSION_ID, after: { reason, ...this.status.lastResult },
        }).catch(() => { /* best effort */ });
      }
    }
    return this.status;
  }
}
