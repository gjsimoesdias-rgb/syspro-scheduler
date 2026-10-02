import { DatabaseConnection, type DbExecutor } from '../database/connection';
import { asObj, type Loose } from '../utils/loose';

/** Default company-wide settings */
export const DEFAULT_COMPANY_SETTINGS = {
  general: {
    loadCompanyAtStartup: true,
    saveWindowsLayout: true,
    saveScheduleZoom: false,
    savePlanningWarning: true,
    showRelatedJobsOnly: true,
    theme: 'Blue',
  },
  jobManagement: {
    defaultPriority: 'priority',
    defaultDirection: 'forward',
    includeCompletedOps: false,
    scheduleWhereStatusComplete: true,
    hideCompletedOperations: true,
  },
  materials: {
    calculations: 'manual',
    includePastActiveJobs: true,
    effectiveStartMode: 'today-plus-days',
    todayPlusDays: 0,
    specifiedDate: '',
  },
  fcs: {
    designer: {
      wideRowWidth: false,
      hideWCWithNoMachines: true,
      barHeight: 35,
      separationMargin: 0,
      labelFontSize: 10,
      showShifts: true,
      showResources: true,
      resourceHideWhenZero: 'always',
      showAvailableHours: false,
      showConsumptionAs: 'text',
    },
    planningInterval: {
      mode: 'from-today',
      fromTodayStartOffset: -7,
      fromTodayDurationWeeks: 12,
      customFrom: '',
      customTo: '',
    },
    schedulingRules: {
      floatResources: 'off',
      splitTasks: true,
      splitTaskConsumptionMin: true,
      splitTaskInterruptionMax: true,
      useQueueTime: false,
      queueAsHours: false,
      queueToNonWorkingTime: false,
      autoScheduleNextDay: false,
      applyQueueAfterPrevious: false,
      useSetupTime: false,
      setupFirstJobOnly: false,
      skipSetupIfQtyReported: false,
      setupApplyEvenNoQty: false,
      useWaitTime: false,
      useTeardownTime: false,
      useMoveTime: true,
      moveAsHours: true,
      moveToNonWorkingTime: true,
      moveAutoNextDay: false,
      moveAfterPrevious: false,
      useTransfer: true,
      transferApplyTo: 'next-operation',
      // Overlap: next op may start after this % of the previous run (100 = no overlap).
      overlapPercent: 100,
      // Use SYSPRO's per-operation transfer qty/% (TransferQtyOrPct) for overlap.
      transferFromSyspro: false,
      // auto scheduling
      schedulingMethod: 'forward',
      forwardFrom: 'today',
      backwardFrom: 'job-end',
      sequenceBy: 'grid-grouping',
      linkJobs: false,
      machineBalancing: 'schedule-critical',
      asap: true,
      // When false, autoschedule places jobs even if their components are short
      // in SYSPRO (shortages still show as warnings in the Constraints tab).
      enforceMaterialConstraints: true,
      // Operations start inside the planning window but may finish after it.
      allowFinishAfterHorizon: false,
      // Plan SYSPRO MRP suggested jobs (MrpSugJobMaster) as 'Planned' jobs.
      includeMrpSuggestedJobs: false,
    },
    tracking: {
      showExecutionInJobPanels: true,
      runningLateThreshold: 10,
      runningEarlyThreshold: 10,
      showTimeShiftGreaterThan: 0,
    },
  },
};

/** Literal types widened (true → boolean, 'Blue' → string), recursively. */
type Widen<T> = T extends boolean ? boolean : T extends number ? number : T extends string ? string
  : { [K in keyof T]: Widen<T[K]> };

/** Company settings: the defaults' shape (stored JSON is merged over the defaults). */
export type CompanySettings = Widen<typeof DEFAULT_COMPANY_SETTINGS>;
export type SchedulingRulesSettings = CompanySettings['fcs']['schedulingRules'];

/** Default user-level settings */
export const DEFAULT_USER_SETTINGS = {
  gantt: {
    zoom: 'day',
    colorMode: 'workcentre',
    barStyle: 'segmented',
    showUtilBars: true,
    showShift: true,
    showNowLine: true,
    showLegend: false,
    rowHeight: 20,
    barOpacity: 1.0,
    labelMinWidth: 80,
    wcColWidth: 120,
    machineColWidth: 220,
    defaultZoom: 'day',
    highlightWeekends: false,
    showDueDate: false,
    showOperationSeq: true,
    opBarRadius: 2,
  },
  ui: {
    defaultView: 'gantt',
    sidebarCollapsed: false,
  },
};

export type UserSettings = Widen<typeof DEFAULT_USER_SETTINGS>;

/** True for a lic_users id (local sign-in); false for Windows sign-ins like 'ntlm:DOMAIN\user'. */
export const isLocalUserId = (sub: unknown): boolean =>
  (typeof sub === 'number' || (typeof sub === 'string' && /^\d+$/.test(sub))) && Number(sub) > 0;

/** Upsert one column of a sch_NamedUserSettings row. */
export async function saveNamed(db: DbExecutor, key: string, column: 'SettingsJson' | 'ColumnProfile', json: string): Promise<void> {
  await db.queryWithParams(
    `MERGE dbo.sch_NamedUserSettings WITH (HOLDLOCK) AS t
     USING (SELECT @key AS UserKey) AS s ON t.UserKey = s.UserKey
     WHEN MATCHED THEN UPDATE SET ${column} = @json, UpdatedAt = SYSUTCDATETIME()
     WHEN NOT MATCHED THEN INSERT (UserKey, ${column}) VALUES (@key, @json);`,
    { key: key.slice(0, 256), json });
}

export class SettingsService {
  private db: DatabaseConnection;
  constructor(db: DatabaseConnection) { this.db = db; }

  async getCompanySettings(companyId: number): Promise<CompanySettings> {
    const res = await this.db.queryWithParams(
      `SELECT settings_json FROM dbo.lic_company_settings WHERE company_id = @cid`,
      { cid: companyId }
    );
    const raw = res?.recordset?.[0]?.settings_json;
    if (!raw) return { ...DEFAULT_COMPANY_SETTINGS };
    try {
      const stored = JSON.parse(raw);
      return this.deepMerge({ ...DEFAULT_COMPANY_SETTINGS }, stored);
    } catch { return { ...DEFAULT_COMPANY_SETTINGS }; }
  }

  async saveCompanySettings(companyId: number, settings: unknown, updatedBy?: number): Promise<void> {
    const json = JSON.stringify(settings);
    const exists = await this.db.queryWithParams(
      `SELECT id FROM dbo.lic_company_settings WHERE company_id = @cid`, { cid: companyId }
    );
    if (exists?.recordset?.length > 0) {
      await this.db.queryWithParams(
        `UPDATE dbo.lic_company_settings SET settings_json = @json, updated_at = GETDATE(), updated_by = @uid WHERE company_id = @cid`,
        { json, uid: updatedBy || null, cid: companyId }
      );
    } else {
      await this.db.queryWithParams(
        `INSERT INTO dbo.lic_company_settings (company_id, settings_json, updated_by) VALUES (@cid, @json, @uid)`,
        { cid: companyId, json, uid: updatedBy || null }
      );
    }
  }

  async getUserSettings(userId: number): Promise<UserSettings> {
    const res = await this.db.queryWithParams(
      `SELECT settings_json FROM dbo.lic_user_settings WHERE user_id = @uid`,
      { uid: userId }
    );
    const raw = res?.recordset?.[0]?.settings_json;
    if (!raw) return { ...DEFAULT_USER_SETTINGS };
    try {
      const stored = JSON.parse(raw);
      return this.deepMerge({ ...DEFAULT_USER_SETTINGS }, stored);
    } catch { return { ...DEFAULT_USER_SETTINGS }; }
  }

  async saveUserSettings(userId: number, settings: unknown): Promise<void> {
    const json = JSON.stringify(settings);
    const exists = await this.db.queryWithParams(
      `SELECT id FROM dbo.lic_user_settings WHERE user_id = @uid`, { uid: userId }
    );
    if (exists?.recordset?.length > 0) {
      await this.db.queryWithParams(
        `UPDATE dbo.lic_user_settings SET settings_json = @json, updated_at = GETDATE() WHERE user_id = @uid`,
        { json, uid: userId }
      );
    } else {
      await this.db.queryWithParams(
        `INSERT INTO dbo.lic_user_settings (user_id, settings_json) VALUES (@uid, @json)`,
        { uid: userId, json }
      );
    }
  }

  /**
   * Personal settings for a signed-in user. Local users (numeric id) use
   * lic_user_settings; Windows sign-ins ('ntlm:DOMAIN\user') have no
   * lic_users row and use sch_NamedUserSettings (migration 010).
   */
  async getUserSettingsFor(sub: number | string): Promise<UserSettings> {
    if (isLocalUserId(sub)) return this.getUserSettings(Number(sub));
    const res = await this.db.queryWithParams(
      `SELECT SettingsJson FROM dbo.sch_NamedUserSettings WHERE UserKey = @key`, { key: String(sub) });
    const raw = res?.recordset?.[0]?.SettingsJson;
    if (!raw) return { ...DEFAULT_USER_SETTINGS };
    try { return this.deepMerge({ ...DEFAULT_USER_SETTINGS }, JSON.parse(raw)); } catch { return { ...DEFAULT_USER_SETTINGS }; }
  }

  async saveUserSettingsFor(sub: number | string, settings: unknown): Promise<void> {
    if (isLocalUserId(sub)) return this.saveUserSettings(Number(sub), settings);
    await saveNamed(this.db, String(sub), 'SettingsJson', JSON.stringify(settings));
  }

  /** `source` (stored JSON) merged over `target` (defaults), object by object. */
  private deepMerge<T>(target: T, source: unknown): T {
    const out: Loose = { ...(target as Loose) };
    for (const [key, value] of Object.entries(asObj(source))) {
      const base = out[key];
      out[key] = value && typeof value === 'object' && !Array.isArray(value) && base && typeof base === 'object'
        ? this.deepMerge(base, value)
        : value;
    }
    return out as T;
  }
}

export default SettingsService;
