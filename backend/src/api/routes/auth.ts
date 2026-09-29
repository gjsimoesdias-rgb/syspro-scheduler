import { Router, Request, Response } from 'express';
import AuthService from '../../services/AuthService';
import { requireAuth, AuthRequest } from '../middleware/requireAuth';
import { validateBody } from '../middleware/validateBody';
import { loginSchema, refreshSchema, logoutSchema } from '../validators/authValidators';

const router = Router();

const getAuth = (req: Request): AuthService => {
  const db = req.app.locals.schedulerDb;
  if (!db) throw new Error('Scheduler database not connected');
  return new AuthService(db);
};

// POST /api/auth/login
router.post('/login', validateBody(loginSchema), async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    const result = await getAuth(req).login(String(username), String(password));
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message || 'Login failed' });
  }
});

// POST /api/auth/refresh
router.post('/refresh', validateBody(refreshSchema), async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    const result = await getAuth(req).refresh(String(refreshToken));
    res.json(result);
  } catch (err: any) {
    res.status(401).json({ error: err.message || 'Token refresh failed' });
  }
});

// POST /api/auth/logout
router.post('/logout', validateBody(logoutSchema), async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    if (refreshToken) await getAuth(req).logout(String(refreshToken));
    res.json({ ok: true });
  } catch {
    res.json({ ok: true });
  }
});

// GET /api/auth/me
router.get('/me', requireAuth, async (req: AuthRequest, res: Response) => {
  try {
    const user = await getAuth(req).getUserById(Number(req.user!.sub));
    if (!user) { res.status(404).json({ error: 'User not found' }); return; }
    res.json(user);
  } catch (err: any) {
    res.status(500).json({ error: err.message });
  }
});

export default router;
