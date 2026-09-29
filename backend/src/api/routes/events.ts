/**
 * SSE route — real-time replan signals (#63).
 *
 * GET /api/schedule/events
 *
 * Sends a Server-Sent Events stream. Each connected client receives:
 *   - `ping`   every 30 s (keepalive)
 *   - `replan` when WipMaster rows have changed since last poll
 *
 * Poll interval is controlled by the REPLAN_POLL_MS env var (default 15 000).
 * The endpoint is public (no auth) so the browser EventSource can connect
 * without an Authorization header — the stream carries no sensitive data.
 *
 * One polling interval runs per client; the interval is cleared when the
 * connection closes (normal browser nav-away, tab close, network drop).
 */

import { Router, Request, Response } from 'express';

const router = Router();

const POLL_MS = Math.max(5_000, parseInt(process.env.REPLAN_POLL_MS || '15000', 10));
const PING_MS = 30_000;

/**
 * Lightweight snapshot of WipMaster used to detect changes.
 * We compare the last-modified timestamp (or rowcount as a proxy when the
 * DB doesn't expose a timestamp column directly from WipMaster).
 */
async function getWipSnapshot(sysproDb: any): Promise<{ hash: string }> {
  try {
    const result = await sysproDb.query(
      `SELECT COUNT(*) AS cnt,
              MAX(COALESCE(TRY_CONVERT(BIGINT, CONVERT(VARCHAR, CHECKSUM_AGG(CHECKSUM(Job, Status, JobDeliveryDate)), 0)), 0)) AS chk
       FROM WipMaster
       WHERE Complete = 'N'`
    );
    const row = result.recordset?.[0];
    return { hash: `${row?.cnt ?? 0}-${row?.chk ?? 0}` };
  } catch {
    return { hash: String(Date.now()) }; // If query fails, always signal change
  }
}

/**
 * GET /api/schedule/events
 */
router.get('/events', (req: Request, res: Response) => {
  const sysproDb = req.app.locals.sysproDb;

  // Set SSE headers
  res.setHeader('Content-Type', 'text/event-stream');
  res.setHeader('Cache-Control', 'no-cache');
  res.setHeader('Connection', 'keep-alive');
  res.setHeader('X-Accel-Buffering', 'no'); // Disable nginx buffering
  res.flushHeaders();

  const send = (event: string, data: unknown) => {
    try {
      res.write(`event: ${event}\ndata: ${JSON.stringify(data)}\n\n`);
    } catch {
      // Client disconnected mid-write; clean up is handled by close handler
    }
  };

  // Initial ping so the client knows the connection is live
  send('ping', { ts: new Date().toISOString() });

  let lastHash = '';

  const pollInterval = setInterval(async () => {
    if (!sysproDb) return;
    try {
      const { hash } = await getWipSnapshot(sysproDb);
      if (hash !== lastHash) {
        if (lastHash !== '') {
          // Something changed — tell connected clients to consider a replan
          send('replan', { reason: 'job_state_changed', ts: new Date().toISOString() });
        }
        lastHash = hash;
      }
    } catch {
      // Non-fatal; next poll will retry
    }
  }, POLL_MS);

  const pingInterval = setInterval(() => {
    send('ping', { ts: new Date().toISOString() });
  }, PING_MS);

  // Clean up when the client disconnects
  req.on('close', () => {
    clearInterval(pollInterval);
    clearInterval(pingInterval);
  });
});

export default router;
