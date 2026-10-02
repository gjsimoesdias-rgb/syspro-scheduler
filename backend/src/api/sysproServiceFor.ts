import type { Request } from 'express';
import { SysproDatabaseService } from '../services/SysproDatabaseService';
import { SettingsService } from '../services/SettingsService';
import { companyFor } from './companyContext';

/**
 * Whether the signed-in company plans MRP suggested jobs
 * (Settings → Scheduling rules → fcs.schedulingRules.includeMrpSuggestedJobs).
 */
export async function includeSuggestedJobsFor(req: Request): Promise<boolean> {
  try {
    const schedulerDb = req.app.locals.schedulerDb;
    const companyId = await companyFor(req);
    if (!schedulerDb || !companyId) return false;
    const cs = await new SettingsService(schedulerDb).getCompanySettings(companyId);
    return (cs as any)?.fcs?.schedulingRules?.includeMrpSuggestedJobs === true;
  } catch {
    return false;
  }
}

/** SYSPRO service configured with the company's suggested-jobs setting. */
export async function sysproServiceFor(req: Request, db: any = req.app.locals.sysproDb): Promise<SysproDatabaseService> {
  return new SysproDatabaseService(db, { includeSuggestedJobs: await includeSuggestedJobsFor(req) });
}
