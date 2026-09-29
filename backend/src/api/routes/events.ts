/**
 * SSE route — real-time replan signals (#63).
 *
 * GET /api/schedule/events
 *
 * Each connected client receives:
 *   - `ping`   every 30 s (keepalive)
 *   - `replan` when open SYSPRO jobs or their operations have changed
 *
 * ONE shared poller serves every client (the old version ran a separate
 * WipMaster query per open browser tab). It only runs while at least one
 * client is connected. Poll interval: REPLAN_POLL_MS (default 15 000, min 5 000).
 *
 * The endpoint is public (EventSource can't send an Authorization header);
 * the stream carries no data beyond "something changed".
 */

import { Router, Request, Response } from 'express';
import { logger } from '../../utils/logger';

const router = Router();

const POLL_MS = Math.max(5_000, parseInt(process.env.REPLAN_POLL_MS || '15000', 10));
const PING_MS = 30_000;

/**
 * Fingerprint of open jobs + their operations. The previous query nested
 * aggregates (MAX(CHECKSUM_AGG(...))), which SQL Server rejects — every poll
 * failed and the fallback reported a change every 15 s.
 */
export const WIP_SNAPSHOT_SQL = `
  SELECT
    (SELECT COUNT(*) FROM WipMaster WHERE ISNULL(Complete, 'N') <> 'Y') AS jobCount,
    (SELECT CHECKSUM_AGG(CHECKSUM(Job, HoldFlag, ConfirmedFlag, JobDeliveryDate, QtyToMake))
       FROM WipMaster WHERE ISNULL(Complete, 'N') <> 'Y') AS jobChk,
    (SELECT CHECKSUM_AGG(CHECKSUM(l.Job, l.Operation, l.OperationStatus, l.IExpUnitRunTim))
       FROM WipJobAllLab l
       JOIN WipMaster wm ON wm.Job = l.Job
       WHERE ISNULL(wm.Complete, 'N') <> 'Y') AS opChk`;

/** Returns a fingerprint string, or null when the query failed (null never counts as a change). */
export async function getWipSnapshot(sysproDb: any): Promise<string | null> {
  try {
    const result = await sysproDb.query(WIP_SNAPSHOT_SQL);
    const row = result.recordset?.[0];
    return `${row?.jobCount ?? 0}|${row?.jobChk ?? 0}|${row?.opChk ?? 0}`;
  } catch (err) {
    logger.warn({ err }, 'SSE: WIP snapshot query failed; skipping this poll');
    return null;
  }
}

type Client = { res: Response };
const clients = new Set<Client>();
let pollTimer: NodeJS.Timeout | null = null;
let pingTimer: NodeJS.Timeout | null = null;
let lastHash: string | null = null;
let polling = false;
let getDb: () => any = () => null;

const send = (client: Client, event: string, data: unknown) => {
  try {
    client.res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
  } catch {
    clients.delete(client);
  }
};
const broadcast = (event: string, data: unknown) => {
  for (const c of clients) send(c, event, data);
};

async function pollOnce(): Promise<void> {
  if (polling) return; // never overlap slow queries
  polling = true;
  try {
    const db = getDb();
    if (!db) return;
    const hash = await getWipSnapshot(db);
    if (hash === null) return;
    if (lastHash !== null && hash !== lastHash) {
      broadcast('replan', { reason: 'job_state_changed', ts: new Date().toISOString() });
    }
    lastHash = hash;
  } finally {
    polling = false;
  }
}

function startTimers(): void {
  if (!pollTimer) pollTimer = setInterval(() => { void pollOnce(); }, POLL_MS);
  if (!pingTimer) pingTimer = setInterval(() => broadcast('ping', { ts: new Date().toISOString() }), PING_MS);
}

function stopTimersIfIdle(): void {
  if (clients.size > 0) return;
  if (pollTimer) clearInterval(pollTimer);
  if (pingTimer) clearInterval(pingTimer);
  pollTimer = pingTimer = null;
  lastHash = null; // re-baseline when someone reconnects
}

/** Test hooks. */
export const __sse = {
  clientCount: () => clients.size,
  pollOnce,
  reset: () => { for (const c of clients) clients.delete(c); stopTimersIfIdle(); lastHash = null; },
};

router.get('/events', (req: Request, res: Response) => {
  getDb = () => req.app.locals.sysproDb;

  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // disable proxy buffering
  res.flushHeaders();

  const client: Client = { res };
  clients.add(client);
  send(client, 'ping', { ts: new Date().toISOString() });
  startTimers();
  if (lastHash === null) void pollOnce(); // take the baseline straight away

  req.on('close', () => {
    clients.delete(client);
    stopTimersIfIdle();
  });
});

export default router;
