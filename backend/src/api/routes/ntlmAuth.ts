/**
 * Windows-integrated (NTLM) authentication endpoint.
 *
 * The express-ntlm middleware handles the multi-step NTLM challenge/response
 * at the HTTP level.  Once the handshake succeeds, `req.ntlm` is populated
 * with the authenticated Windows identity.  We issue a short-lived JWT so
 * all subsequent API calls can use standard Bearer auth.
 *
 * Role resolution order:
 *   1. sch_ADUsers table  → explicit role for this username+domain
 *   2. Default            → 'Reviewer'
 *
 * AD_DOMAIN and AD_DC_URL must both be set in .env for NTLM to be enabled.
 * If they are absent this router returns 503 on every request.
 */

import { Router, Request, Response } from 'express';
import jwt from 'jsonwebtoken';
import { logger } from '../../utils/logger';
import environment from '../../config/environment';

const router = Router();

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const JWT_EXPIRES_IN = '8h';

// ── Conditionally mount express-ntlm ─────────────────────────────────────────
if (environment.adDomain && environment.adDcUrl) {
  // eslint-disable-next-line @typescript-eslint/no-var-requires
  const ntlm = require('express-ntlm');
  router.use(
    ntlm({
      domain: environment.adDomain,
      domaincontroller: environment.adDcUrl,
      debug: (...args: unknown[]) => logger.debug({ ntlm: args }, 'NTLM debug'),
    })
  );
  logger.info(
    { domain: environment.adDomain, dc: environment.adDcUrl },
    'Windows NTLM authentication enabled'
  );
} else {
  // NTLM not configured — return a clear 503 on all routes
  router.use((_req: Request, res: Response) => {
    res.status(503).json({
      error: 'Windows authentication is not configured on this server.',
      hint: 'Set AD_DOMAIN and AD_DC_URL in .env to enable NTLM.',
    });
  });
}

/**
 * GET /api/auth/ntlm
 *
 * After a successful NTLM handshake (handled by the middleware above)
 * this handler issues a JWT and returns the user profile.
 */
router.get('/', async (req: Request, res: Response) => {
  if (!req.ntlm) {
    res.status(401).json({ error: 'NTLM authentication required' });
    return;
  }

  // req.ntlm is guaranteed non-null here (early return above)
  const ntlmInfo = req.ntlm as { UserName: string; DomainName: string; Workstation: string };
  const username = ntlmInfo.UserName.toLowerCase();
  const domain = ntlmInfo.DomainName.toLowerCase();
  const schedulerDb = req.app.locals.schedulerDb;

  let role = 'Reviewer';
  let fullName: string | null = null;

  if (schedulerDb) {
    try {
      // Look up explicit role assignment
      const existing = await schedulerDb.queryWithParams(
        `SELECT role, full_name
         FROM   dbo.sch_ADUsers
         WHERE  username = @u AND domain = @d`,
        { u: username, d: domain }
      );

      if (existing?.recordset?.[0]) {
        role = existing.recordset[0].role;
        fullName = existing.recordset[0].full_name ?? null;
      }

      // Upsert last_seen (auto-provisions the row with default Reviewer role)
      await schedulerDb.queryWithParams(
        `MERGE dbo.sch_ADUsers WITH (HOLDLOCK) AS target
         USING (SELECT @u AS username, @d AS domain) AS src
           ON  target.username = src.username AND target.domain = src.domain
         WHEN MATCHED     THEN UPDATE SET last_seen = GETDATE()
         WHEN NOT MATCHED THEN INSERT (username, domain, role, last_seen, created_at)
                               VALUES (@u, @d, 'Reviewer', GETDATE(), GETDATE());`,
        { u: username, d: domain }
      );
    } catch (err) {
      logger.warn({ err }, 'NTLM: could not resolve role from sch_ADUsers — defaulting to Reviewer');
    }
  }

  const accessToken = jwt.sign(
    {
      sub: `ntlm:${domain}\\${username}`,
      username,
      domain,
      role,
      fullName,
      companyId: null,
      authMethod: 'ntlm',
    },
    JWT_SECRET,
    { expiresIn: JWT_EXPIRES_IN } as any
  );

  logger.info({ username, domain, role }, 'NTLM auth successful');

  res.json({
    accessToken,
    user: {
      id: 0,
      username,
      email: `${username}@${domain}`,
      role,
      fullName,
      companyId: null,
      companyName: null,
      authMethod: 'ntlm',
    },
  });
});

export default router;
