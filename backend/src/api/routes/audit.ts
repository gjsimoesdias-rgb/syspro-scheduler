/**
 * GET /api/audit — returns recent audit log entries.
 * Supports optional ?entityType=&entityId=&limit= query params.
 * Requires planner role or above.
 */
import { Router, Request, Response } from 'express';
import { AuditLogService } from '../../services/AuditLogService';
import { requireAuth } from '../middleware/requireAuth';
import { errorMessage } from '../../utils/errors';

const router = Router();

router.get('/', requireAuth, async (req: Request, res: Response) => {
  const schedulerDb = req.app.locals.schedulerDb;
  if (!schedulerDb) {
    req.log.warn({}, 'Audit log requested but scheduler DB not connected');
    return res.status(503).json({ error: 'Scheduler database not connected' });
  }

  try {
    const entityType = typeof req.query.entityType === 'string' ? req.query.entityType : undefined;
    const entityId   = typeof req.query.entityId   === 'string' ? req.query.entityId   : undefined;
    const limit      = Math.min(parseInt((req.query.limit as string) || '100', 10), 1000);

    const svc = new AuditLogService(schedulerDb);
    const rows = await svc.getHistory(entityType, entityId, limit);

    req.log.info({ count: rows.length, entityType, entityId }, 'Audit log fetched');
    return res.json({ entries: rows, total: rows.length });
  } catch (err) {
    req.log.error({ err: errorMessage(err) }, 'Failed to fetch audit log');
    return res.status(500).json({ error: 'Failed to retrieve audit log' });
  }
});

export default router;
