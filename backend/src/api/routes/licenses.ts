import { Router, Response } from 'express';
import LicenseService from '../../services/LicenseService';
import UserService from '../../services/UserService';
import { requireAuth, requireSuperAdmin, AuthRequest } from '../middleware/requireAuth';

const router = Router();

const getLicenses = (req: AuthRequest): LicenseService => {
  const db = req.app.locals.schedulerDb;
  if (!db) throw new Error('Scheduler database not connected');
  return new LicenseService(db);
};

const getUsers = (req: AuthRequest): UserService => {
  const db = req.app.locals.schedulerDb;
  if (!db) throw new Error('Scheduler database not connected');
  return new UserService(db);
};

// GET /api/licenses
router.get('/', requireAuth, requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    res.json(await getLicenses(req).listLicenses());
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/licenses/:id
router.get('/:id', requireAuth, requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const lic = await getLicenses(req).getLicenseById(Number(req.params.id));
    if (!lic) { res.status(404).json({ error: 'License not found' }); return; }
    res.json(lic);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/licenses — create new license + company
router.post('/', requireAuth, requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { companyName, contactEmail, maxUsers, expiryDate, plan, notes, sysproCompanyDb } = req.body;
    if (!companyName) { res.status(400).json({ error: 'companyName is required' }); return; }
    const lic = await getLicenses(req).createLicense({ companyName, contactEmail, maxUsers, expiryDate, plan, notes, sysproCompanyDb });
    res.status(201).json(lic);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/licenses/:id — update license
router.put('/:id', requireAuth, requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const { companyName, contactEmail, maxUsers, isActive, expiryDate, plan, notes, sysproCompanyDb } = req.body;
    const lic = await getLicenses(req).updateLicense(Number(req.params.id), {
      companyName, contactEmail, maxUsers, isActive, expiryDate, plan, notes, sysproCompanyDb
    });
    res.json(lic);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/licenses/:id
router.delete('/:id', requireAuth, requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    await getLicenses(req).deleteLicense(Number(req.params.id));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/licenses/:id/users — users belonging to this license's company
router.get('/:id/users', requireAuth, requireSuperAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const company = await getLicenses(req).getCompanyByLicenseId(Number(req.params.id));
    if (!company) { res.status(404).json({ error: 'Company not found' }); return; }
    const users = await getUsers(req).listUsers(company.id, 'super_admin');
    res.json(users.filter(u => u.companyId === company.id));
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
