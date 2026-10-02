import { Router, Response } from 'express';
import UserService, { UserRecord } from '../../services/UserService';
import { requireAuth, requireCompanyAdmin, AuthRequest, authUser } from '../middleware/requireAuth';
import { validateBody } from '../middleware/validateBody';
import { createUserSchema, updateUserSchema, changePasswordSchema } from '../validators/userValidators';
import { errorMessage } from '../../utils/errors';

const router = Router();

const getUsers = (req: AuthRequest): UserService => {
  const db = req.app.locals.schedulerDb;
  if (!db) throw new Error('Scheduler database not connected');
  return new UserService(db);
};

const isSuperAdmin = (req: AuthRequest): boolean => req.user?.role === 'super_admin';

/**
 * Which roles the caller may hand out. Only a super_admin can create or promote
 * admins; a company_admin can manage planners and viewers in their own company.
 */
const assignableRoles = (req: AuthRequest): string[] =>
  isSuperAdmin(req)
    ? ['super_admin', 'company_admin', 'planner', 'viewer']
    : ['planner', 'viewer'];

/**
 * A super_admin can manage anyone. A company_admin can manage themselves and the
 * users in their own company, but never a super_admin or another company_admin.
 */
const canManage = (req: AuthRequest, target: UserRecord): boolean => {
  if (isSuperAdmin(req)) return true;
  if (target.id === Number(req.user?.sub)) return true; // own profile (role changes still checked)
  return (
    target.companyId != null &&
    target.companyId === req.user?.companyId &&
    !['super_admin', 'company_admin'].includes(target.role)
  );
};

/** Load a user the caller is allowed to manage; null (→ 404) otherwise, so ids from other companies aren't revealed. */
const loadManageable = async (req: AuthRequest): Promise<UserRecord | null> => {
  const id = Number(req.params.id);
  if (!Number.isInteger(id) || id <= 0) return null;
  const user = await getUsers(req).getUserById(id);
  return user && canManage(req, user) ? user : null;
};

// GET /api/users — list users for current company (or all for super_admin)
router.get('/', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const users = await getUsers(req).listUsers(authUser(req).companyId, authUser(req).role);
    res.json(users);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// GET /api/users/:id
router.get('/:id', requireAuth, requireCompanyAdmin, async (req: AuthRequest, res: Response) => {
  try {
    const user = await loadManageable(req);
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    res.json(user);
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// POST /api/users — create user (company_admin or super_admin)
router.post('/', requireAuth, requireCompanyAdmin, validateBody(createUserSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { username, email, password, role, fullName, companyId } = req.body;
    const newRole = String(role || 'planner');
    if (!assignableRoles(req).includes(newRole)) {
      res.status(403).json({ error: `You can't create a user with role '${newRole}'` }); return;
    }
    // company admins can only add to their own company
    const targetCompanyId = authUser(req).role === 'super_admin' ? (companyId || authUser(req).companyId) : authUser(req).companyId;
    if (!targetCompanyId) { res.status(400).json({ error: 'companyId required' }); return; }

    const user = await getUsers(req).createUser({
      companyId: targetCompanyId,
      username: String(username),
      email: String(email),
      password: String(password),
      role: newRole,
      fullName: fullName ? String(fullName) : undefined,
    });
    res.status(201).json(user);
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

// PUT /api/users/:id
router.put('/:id', requireAuth, requireCompanyAdmin, validateBody(updateUserSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { username, email, password, role, fullName, isActive } = req.body;
    const target = await loadManageable(req);
    if (!target) { res.status(404).json({ error: 'User not found' }); return; }
    if (role !== undefined && role !== target.role && !assignableRoles(req).includes(String(role))) {
      res.status(403).json({ error: `You can't assign role '${role}'` }); return;
    }
    const user = await getUsers(req).updateUser(target.id, {
      username, email, password, role, fullName, isActive
    });
    res.json(user);
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

// DELETE /api/users/:id
router.delete('/:id', requireAuth, requireCompanyAdmin, async (req: AuthRequest, res: Response) => {
  try {
    if (Number(req.params.id) === Number(authUser(req).sub)) {
      res.status(400).json({ error: 'Cannot delete your own account' }); return;
    }
    const target = await loadManageable(req);
    if (!target) { res.status(404).json({ error: 'User not found' }); return; }
    await getUsers(req).deleteUser(target.id);
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// POST /api/users/me/change-password — authenticated user changes own password
router.post('/me/change-password', requireAuth, validateBody(changePasswordSchema), async (req: AuthRequest, res: Response) => {
  try {
    const { currentPassword, newPassword } = req.body;
    await getUsers(req).changePassword(Number(authUser(req).sub), String(currentPassword), String(newPassword));
    res.json({ ok: true });
  } catch (err) {
    res.status(400).json({ error: errorMessage(err) });
  }
});

// GET /api/users/me/column-profile — load the calling user's saved column profile
router.get('/me/column-profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const profile = await getUsers(req).getColumnProfileFor(authUser(req).sub);
    res.json(profile || { visibleJobColumns: [], profileName: '' });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

// PUT /api/users/me/column-profile — save the calling user's column profile
router.put('/me/column-profile', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const { visibleJobColumns, profileName } = req.body;
    if (!Array.isArray(visibleJobColumns)) {
      res.status(400).json({ error: 'visibleJobColumns must be an array' }); return;
    }
    await getUsers(req).saveColumnProfileFor(authUser(req).sub, {
      visibleJobColumns: visibleJobColumns.map(String),
      profileName: profileName ? String(profileName).slice(0, 80) : undefined,
    });
    res.json({ ok: true });
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

export default router;
