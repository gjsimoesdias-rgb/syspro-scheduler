import { Router, Response } from 'express';
import SettingsService from '../../services/SettingsService';
import { requireAuth, requireCompanyAdmin, AuthRequest } from '../middleware/requireAuth';

const router = Router();

const getSvc = (req: AuthRequest): SettingsService => {
  const db = req.app.locals.schedulerDb;
  if (!db) throw new Error('Scheduler database not connected');
  return new SettingsService(db);
};

// GET /api/settings/user — current user's settings
router.get('/user', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const settings = await getSvc(req).getUserSettings(Number(req.user!.sub));
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/user — save user settings
router.put('/user', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    await getSvc(req).saveUserSettings(Number(req.user!.sub), req.body);
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/settings/company — company settings (all roles can read)
router.get('/company', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user!.companyId) {
      // super_admin has no company — return defaults
      const { DEFAULT_COMPANY_SETTINGS } = await import('../../services/SettingsService');
      res.json(DEFAULT_COMPANY_SETTINGS);
      return;
    }
    const settings = await getSvc(req).getCompanySettings(req.user!.companyId);
    res.json(settings);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/settings/company — only company_admin or super_admin
router.put('/company', requireAuth, requireCompanyAdmin, async (req: AuthRequest, res: Response) => {
  try {
    if (!req.user!.companyId) { res.status(400).json({ error: 'No company associated with super admin' }); return; }
    await getSvc(req).saveCompanySettings(req.user!.companyId, req.body, Number(req.user!.sub));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
