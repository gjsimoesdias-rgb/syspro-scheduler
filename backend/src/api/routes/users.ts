import { Router, Response } from 'express';
import UserService from '../../services/UserService';
import { requireAuth, requireCompanyAdmin, AuthRequest } from '../middleware/requireAuth';
import { validateBody } from '../middleware/validateBody';
import { createUserSchema, updateUserSchema, changePasswordSchema } from '../validators/userValidators';

const router = Router();

const getUsers = (req: AuthRequest): UserService => {
  const db = req.app.locals.schedulerDb;
  if (!db) throw new Error('Scheduler database not connected');
  return new UserService(db);
};

// GET /api/users — list users for current company (or all for super_admin)
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const users = await getUsers(req).listUsers(req.user!.companyId, req.user!.role);
    res.json(users);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// GET /api/users/:id
router.get('/:id', requireAuth, requireCompanyAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const user = await getUsers(req).getUserById(Number(req.params.id));
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users — create user (company_admin or super_admin)
router.post('/', requireAuth, requireCompanyAdmin, validateBody(createUserSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { username, email, password, role, fullName, companyId } = req.body;
    // company admins can only add to their own company
    const targetCompanyId = req.user!.role === 'super_admin' ? (companyId || req.user!.companyId) : req.user!.companyId;
    if (!targetCompanyId) { res.status(400).json({ error: 'companyId required' }); return; }

    const user = await getUsers(req).createUser({
      companyId: targetCompanyId,
      username: String(username),
      email: String(email),
      password: String(password),
      role: String(role || 'planner'),
      fullName: fullName ? String(fullName) : undefined,
    });
    res.status(201).json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// PUT /api/users/:id
router.put('/:id', requireAuth, requireCompanyAdmin, validateBody(updateUserSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { username, email, password, role, fullName, isActive } = req.body;
    // Users can only update themselves (non-admin), admins can update anyone in their company
    const user = await getUsers(req).updateUser(Number(req.params.id), {
      username, email, password, role, fullName, isActive
    });
    res.json(user);
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// DELETE /api/users/:id
router.delete('/:id', requireAuth, requireCompanyAdmin, async (req: AuthRequest, res: Response) => {
  try {
    if (Number(req.params.id) === Number(req.user!.sub)) {
      res.status(400).json({ error: 'Cannot delete your own account' }); return;
    }
    await getUsers(req).deleteUser(Number(req.params.id));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// POST /api/users/me/change-password — authenticated user changes own password
router.post('/me/change-password', requireAuth, validateBody(changePasswordSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    await getUsers(req).changePassword(Number(req.user!.sub), String(currentPassword), String(newPassword));
    res.json({ ok: true });
  } catch (err: any) {
    res.status(400).json({ error: err.message });
  }
});

// GET /api/users/me/column-profile — load the calling user's saved column profile
router.get('/me/column-profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const profile = await getUsers(req).getColumnProfile(Number(req.user!.sub));
    res.json(profile || { visibleJobColumns: [], profileName: '' });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

// PUT /api/users/me/column-profile — save the calling user's column profile
router.put('/me/column-profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { visibleJobColumns, profileName } = req.body;
    if (!Array.isArray(visibleJobColumns)) {
      res.status(400).json({ error: 'visibleJobColumns must be an array' }); return;
    }
    await getUsers(req).saveColumnProfile(Number(req.user!.sub), {
      visibleJobColumns: visibleJobColumns.map(String),
      profileName: profileName ? String(profileName).slice(0, 80) : undefined,
    });
    res.json({ ok: true });
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
