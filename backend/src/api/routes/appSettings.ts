import { Router, Response } from 'express';
import SettingsService from '../../services/SettingsService';
import { requireAuth, requireCompanyAdmin, AuthRequest } from '../middleware/requireAuth';
import { companyFor } from '../companyContext';

const router = Router();

const getSvc = (req: AuthRequest): SettingsService => {
  const db = req.app.locals.schedulerDb;
  if (!db) throw new Error('Scheduler database not connected');
  return new SettingsService(db);
};

// GET /api/settings/user — current user's settings
router.get('/user', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const settings = await getSvc(req).getUserSettingsFor(req.user!.sub);
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/user — save user settings
router.put('/user', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await getSvc(req).saveUserSettingsFor(req.user!.sub, req.body);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/company — company settings (all roles can read)
router.get('/company', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    // Users without a company (super_admin, Windows sign-ins) see the company
    // of the connected SYSPRO database — the one Generate will use.
    const companyId = await companyFor(req);
    if (!companyId) {
      const { DEFAULT_COMPANY_SETTINGS } = await import('../../services/SettingsService');
      res.json(DEFAULT_COMPANY_SETTINGS);
      return;
    }
    const settings = await getSvc(req).getCompanySettings(companyId);
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/company — only company_admin or super_admin
router.put('/company', requireAuth, requireCompanyAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const companyId = await companyFor(req);
    if (!companyId) {
      res.status(400).json({ error: 'No licensed company matches the connected SYSPRO database — set its SYSPRO company id under Licences' });
      return;
    }
    const uid = Number(req.user!.sub);
    await getSvc(req).saveCompanySettings(companyId, req.body, Number.isFinite(uid) && uid > 0 ? uid : undefined);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
