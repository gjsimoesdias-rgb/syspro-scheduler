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
import { planDbFor } from './planStore';
import SysproDatabaseService from './SysproDatabaseService';
import { AuditLogService } from './AuditLogService';
import { errorMessage } from '../utils/errors';
import type { Request, Response } from 'express';
import type { DbExecutor } from '../database/connection';
import type { AppLike } from '../types/appLocals';
import type { Schedule, ScheduleMetrics } from '../types';
import { asObj } from '../utils/loose';

export const AUTO_PLAN_VERSION_ID = 'whatif-auto-plan';
export const AUTO_PLAN_NAME = 'Auto plan';
const AUTO_PLAN_CREATOR = 'auto-schedule';

/**
 * The what-if the Auto plan writes into. Committing a what-if keeps its id and
 * turns it into the master, so after the Auto plan is committed its id belongs
 * to a plan; the next run then starts a fresh what-if under a new id.
 */
export async function autoPlanVersionId(plan: DbExecutor): Promise<string> {
  const r = await plan.queryWithParams<{ ScheduleID: string }>(
    `SELECT TOP 1 ScheduleID FROM aps.SavedSchedules
     WHERE VersionKind = 'WhatIf' AND CreatedBy = @by ORDER BY SavedAt DESC`,
    { by: AUTO_PLAN_CREATOR });
  const current = r.recordset?.[0]?.ScheduleID;
  if (current) return String(current);
  const newId = (await getVersion(plan, AUTO_PLAN_VERSION_ID))
    ? `${AUTO_PLAN_VERSION_ID}-${Date.now()}`
    : AUTO_PLAN_VERSION_ID;
  await createWhatIf(plan, { name: AUTO_PLAN_NAME, createdBy: AUTO_PLAN_CREATOR, newId });
  return newId;
}

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
  /** What-if the last run wrote into. */
  versionId?: string;
}

export const DEFAULT_AUTO_CONFIG: AutoScheduleConfig = {
  enabled: false, intervalMinutes: 60, onJobChange: true, checkMinutes: 5,
};

export function normaliseAutoConfig(input: unknown, prev: AutoScheduleConfig = DEFAULT_AUTO_CONFIG): AutoScheduleConfig {
  const raw = asObj(input);
  const num = (v: unknown, d: number, lo: number, hi: number) => {
    const n = Number(v);
    return Number.isFinite(n) ? Math.min(hi, Math.max(lo, Math.round(n))) : d;
  };
  return {
    enabled: raw.enabled === undefined ? prev.enabled : !!raw.enabled,
    intervalMinutes: num(raw.intervalMinutes, prev.intervalMinutes, 0, 24 * 60),
    onJobChange: raw.onJobChange === undefined ? prev.onJobChange : !!raw.onJobChange,
    checkMinutes: num(raw.checkMinutes, prev.checkMinutes, 1, 120),
    companyId: (raw.companyId as number | string | undefined) ?? prev.companyId,
    enabledBy: (raw.enabledBy as string | undefined) ?? prev.enabledBy,
  };
}

/** What the open SYSPRO jobs look like, for change detection. */
export function jobsFingerprint(jobs: Array<{
  jobId: string; quantity?: unknown; dueDate?: unknown; status?: unknown;
  operations?: Array<{ opId: string; status?: unknown; workcentreId?: string; duration?: unknown }>;
}>): string {
  const rows = jobs.map((j) => [
    String(j.jobId).trim(), Number(j.quantity) || 0, new Date(j.dueDate as string).getTime() || 0, j.status ?? '',
    (j.operations || []).map((o) => `${o.opId}:${o.status ?? ''}:${o.workcentreId ?? ''}:${Math.round(Number(o.duration) || 0)}`).join(','),
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

type Handler = (req: Request, res: Response) => Promise<unknown>;

export class AutoScheduler {
  private timer: NodeJS.Timeout | null = null;
  readonly status: AutoScheduleStatus = { running: false };

  constructor(private app: AppLike, private generate: Handler) {}

  get config(): AutoScheduleConfig {
    return normaliseAutoConfig(this.app.locals.autoSchedule || {});
  }

  setConfig(raw: unknown): AutoScheduleConfig {
    const cfg = normaliseAutoConfig(raw, this.config);
    setLocal(this.app.locals, 'autoSchedule', cfg);
    this.updateNextRun();
    return cfg;
  }

  /** Forget the last run (e.g. after a company switch). */
  resetStatus(): void {
    if (this.status.running) return;
    for (const k of Object.keys(this.status) as Array<keyof AutoScheduleStatus>) {
      if (k !== 'running') delete this.status[k];
    }
    this.updateNextRun();
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
    return { sub: 0, username: AUTO_PLAN_CREATOR, role: 'planner', companyId: cfg.companyId };
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
      const versionId = await autoPlanVersionId(await planDbFor(this.app));
      this.status.versionId = versionId;
      const opts: Record<string, unknown> = { ...(this.app.locals.lastGenerateOptions || {}) };
      const horizonDays = Number(opts.horizonDays) > 0 ? Number(opts.horizonDays) : 14;
      delete opts.horizonDays;
      const start = new Date();
      const body = {
        ...opts,
        planningHorizonStartDate: start.toISOString(),
        planningHorizonEndDate: new Date(start.getTime() + horizonDays * 86400000).toISOString(),
        versionId,
      };
      let statusCode = 200;
      let payload: { error?: string; schedule?: Schedule } | undefined;
      // A minimal stand-in for the Express request/response the handler uses.
      const req = {
        app: this.app, body, headers: {}, query: {}, params: {},
        user: this.syntheticUser(), autoSchedule: true,
        log: logger.child({ autoSchedule: true, reason }),
      } as unknown as Request;
      const res = {
        status(code: number) { statusCode = code; return res; },
        json(obj: typeof payload) { payload = obj; return res; },
      } as unknown as Response;
      await this.generate(req, res);
      if (statusCode >= 400) throw new Error(payload?.error || `Generate failed (${statusCode})`);
      const js = payload?.schedule?.jobSchedules || [];
      const m: Partial<ScheduleMetrics> = payload?.schedule?.metrics || {};
      this.status.lastResult = {
        ok: true, jobs: js.length,
        scheduled: m.totalJobsScheduled ?? js.filter((j) => j.operationSchedules?.length).length,
        unscheduled: m.jobsUnscheduled ?? 0,
        late: m.jobsTardy ?? js.filter((j) => Number(j.estimatedTardiness) > 0).length,
        ms: Date.now() - started,
      };
      // Remember the job state this plan was built from.
      try { this.status.lastFingerprint = jobsFingerprint(await new SysproDatabaseService(db).getOpenJobs()); } catch { /* next check sets it */ }
      logger.info({ reason, ...this.status.lastResult }, 'Auto plan updated');
    } catch (err) {
      this.status.lastResult = { ok: false, error: errorMessage(err, String(err)), ms: Date.now() - started };
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
          entityId: this.status.versionId ?? AUTO_PLAN_VERSION_ID, after: { reason, ...this.status.lastResult },
        }).catch(() => { /* best effort */ });
      }
    }
    return this.status;
  }
}
