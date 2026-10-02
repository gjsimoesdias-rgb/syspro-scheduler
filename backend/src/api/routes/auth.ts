import { Router, Request, Response } from 'express';
import AuthService from '../../services/AuthService';
import { requireAuth, AuthRequest } from '../middleware/requireAuth';
import { validateBody } from '../middleware/validateBody';
import { loginSchema, refreshSchema, logoutSchema } from '../validators/authValidators';
import { errorMessage } from '../../utils/errors';

const router = Router();

const getAuth = (req: Request): AuthService => {
  const db = req.app.locals.schedulerDb;
  if (!db) throw new Error('Scheduler database not connected');
  return new AuthService(db);
};

// POST /api/auth/login
/** Messages AuthService throws on purpose — safe and useful to show the user. */
const USER_FACING_AUTH_ERRORS = new Set([
  'Invalid credentials',
  'Account is disabled',
  'Company license is disabled',
  'Company license has expired',
  'Invalid refresh token',
  'Refresh token expired',
]);

/**
 * Credential problems → 401 with the reason. Anything else (SQL login failure,
 * DB down, timeout…) → 503 with a generic message; the detail goes to the
 * server log only. Previously raw SQL errors such as "Login failed for user
 * 'sa'" were shown on the sign-in screen.
 */
const sendAuthError = (req: Request, res: Response, err: unknown) => {
  const msg = errorMessage(err, '');
  if (USER_FACING_AUTH_ERRORS.has(msg)) {
    res.status(401).json({ error: msg });
    return;
  }
  req.log?.error({ err }, 'Authentication backend error');
  res.status(503).json({
    error: "The scheduler can't reach its database right now. Please contact your administrator.",
  });
};

router.post('/login', validateBody(loginSchema), async (req: Request, res: Response) => {
  try {
    const { username, password } = req.body;
    const result = await getAuth(req).login(String(username), String(password));
    res.json(result);
  } catch (err) {
    sendAuthError(req, res, err);
  }
});

// POST /api/auth/refresh
router.post('/refresh', validateBody(refreshSchema), async (req: Request, res: Response) => {
  try {
    const { refreshToken } = req.body;
    const result = await getAuth(req).refresh(String(refreshToken));
    res.json(result);
  } catch (err) {
    sendAuthError(req, res, err);
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
  } catch (err) {
    res.status(500).json({ error: errorMessage(err) });
  }
});

export default router;
