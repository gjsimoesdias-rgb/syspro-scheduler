/**
 * Plan versions (phase 5) — one model for what used to be Scenarios and the
 * in-browser Version History.
 *
 *   GET    /api/versions                 master + what-ifs + recent history (no schedule payloads)
 *   GET    /api/versions/:id             one version with its schedule
 *   POST   /api/versions/whatif          { name, fromId? } copy master (or fromId) into a what-if
 *   PUT    /api/versions/:id/schedule    { schedule } save into a what-if
 *   POST   /api/versions/:id/commit      what-if → master (old master → history)
 *   POST   /api/versions/:id/revert      history → master
 *   PATCH  /api/versions/:id             { name } rename
 *   DELETE /api/versions/:id             delete a what-if or history version
 *   POST   /api/versions/purge           { olderThanDays, keepAtLeast } history retention (company admin)
 *
 * Commit and revert leave the new master as Draft: it must be approved again
 * before it can be sent to SYSPRO.
 */
import { Router, Response } from 'express';
import { v4 as uuidv4 } from 'uuid';
import { AuthRequest, requirePlanner, requireCompanyAdmin } from '../middleware/requireAuth';
import {
  listVersions, getVersion, createWhatIf, saveIntoWhatIf, commitWhatIf, revertToVersion,
  renameVersion, deleteVersion, purgeHistory, VersionError,
} from '../../services/ScheduleStore';
import { AuditLogService } from '../../services/AuditLogService';
import { planDbFor } from '../../services/planStore';

const router = Router();

/** Plan versions live in the SCHEDULER DB, per SYSPRO company (services/planStore.ts). */
const dbOf = async (req: AuthRequest, res: Response) => {
  try {
    return await planDbFor(req.app);
  } catch (err: any) {
    res.status(err?.status || 503).json({ error: err?.message || 'Database not connected' });
    return null;
  }
};

const fail = (req: AuthRequest, res: Response, err: unknown) => {
  if (err instanceof VersionError) return res.status(err.status).json({ error: err.message });
  (req as any).log?.error?.({ err }, 'versions route failed');
  return res.status(500).json({ error: (err as any)?.message || 'Version operation failed' });
};

const audit = (req: AuthRequest, action: string, details: Record<string, unknown>) => {
  (req as any).log?.info?.({ action, user: req.user?.username, ...details }, `version_${action}`);
  const schedulerDb = req.app.locals.schedulerDb;
  if (schedulerDb) {
    new AuditLogService(schedulerDb).log({
      actorId: req.user?.username || 'unknown',
      action: `version_${action}`,
      entityType: 'plan_version',
      entityId: String(details.versionId ?? 'all'),
      after: details,
      traceId: (req as any).id,
    }).catch(() => { /* best effort */ });
  }
};

router.get('/', async (req: AuthRequest, res: Response) => {
  const db = await dbOf(req, res); if (!db) return;
  try {
    const limit = Number(req.query.historyLimit) || 30;
    res.json(await listVersions(db, limit));
  } catch (err) { fail(req, res, err); }
});

router.post('/purge', requireCompanyAdmin, async (req: AuthRequest, res: Response) => {
  const db = await dbOf(req, res); if (!db) return;
  const olderThanDays = Number(req.body?.olderThanDays);
  const keepAtLeast = Number(req.body?.keepAtLeast ?? 20);
  if (!Number.isFinite(olderThanDays) || olderThanDays < 1) {
    return res.status(400).json({ error: 'olderThanDays must be a number of days (1 or more)' });
  }
  try {
    const deleted = await purgeHistory(db, { olderThanDays, keepAtLeast });
    audit(req, 'purge', { olderThanDays, keepAtLeast, deleted });
    res.json({ deleted });
  } catch (err) { fail(req, res, err); }
});

router.post('/whatif', requirePlanner, async (req: AuthRequest, res: Response) => {
  const db = await dbOf(req, res); if (!db) return;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'A name is required' });
  try {
    const version = await createWhatIf(db, {
      name, fromId: req.body?.fromId ? String(req.body.fromId) : undefined,
      createdBy: req.user?.username, newId: `whatif-${uuidv4()}`,
    });
    audit(req, 'create_whatif', { versionId: version.versionId, basedOnId: version.basedOnId });
    res.status(201).json({ version });
  } catch (err) { fail(req, res, err); }
});

router.get('/:id', async (req: AuthRequest, res: Response) => {
  const db = await dbOf(req, res); if (!db) return;
  try {
    const found = await getVersion(db, req.params.id);
    if (!found) return res.status(404).json({ error: 'Version not found' });
    res.json({ version: found.summary, schedule: found.schedule });
  } catch (err) { fail(req, res, err); }
});

router.put('/:id/schedule', requirePlanner, async (req: AuthRequest, res: Response) => {
  const db = await dbOf(req, res); if (!db) return;
  const schedule = req.body?.schedule;
  if (!schedule || !Array.isArray(schedule.jobSchedules)) {
    return res.status(400).json({ error: 'Body must be { schedule } with jobSchedules' });
  }
  try {
    await saveIntoWhatIf(db, req.params.id, schedule);
    audit(req, 'save_whatif', { versionId: req.params.id });
    res.json({ saved: true });
  } catch (err) { fail(req, res, err); }
});

router.post('/:id/commit', requirePlanner, async (req: AuthRequest, res: Response) => {
  const db = await dbOf(req, res); if (!db) return;
  try {
    await commitWhatIf(db, req.params.id);
    audit(req, 'commit', { versionId: req.params.id });
    res.json({ committed: true, status: 'Draft' });
  } catch (err) { fail(req, res, err); }
});

router.post('/:id/revert', requirePlanner, async (req: AuthRequest, res: Response) => {
  const db = await dbOf(req, res); if (!db) return;
  try {
    await revertToVersion(db, req.params.id);
    audit(req, 'revert', { versionId: req.params.id });
    res.json({ reverted: true, status: 'Draft' });
  } catch (err) { fail(req, res, err); }
});

router.patch('/:id', requirePlanner, async (req: AuthRequest, res: Response) => {
  const db = await dbOf(req, res); if (!db) return;
  const name = String(req.body?.name || '').trim();
  if (!name) return res.status(400).json({ error: 'A name is required' });
  try {
    if (!(await renameVersion(db, req.params.id, name))) return res.status(404).json({ error: 'Version not found' });
    res.json({ renamed: true });
  } catch (err) { fail(req, res, err); }
});

router.delete('/:id', requirePlanner, async (req: AuthRequest, res: Response) => {
  const db = await dbOf(req, res); if (!db) return;
  try {
    await deleteVersion(db, req.params.id);
    audit(req, 'delete', { versionId: req.params.id });
    res.json({ deleted: true });
  } catch (err) { fail(req, res, err); }
});

export default router;
