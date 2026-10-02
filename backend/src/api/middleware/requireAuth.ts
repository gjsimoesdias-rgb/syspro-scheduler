import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import crypto from 'crypto';
import { JWT_SECRET, SHOPFLOOR_KEY } from '../../config/secrets';

/** The signed-in user, from the JWT (requireAuth sets req.user). */
export interface AuthUser {
  /** Numeric DB id for local users; "ntlm:domain\user" for Windows users */
  sub: number | string;
  username: string;
  role: string;
  companyId: number | null;
}

// Every Express request can carry these (declared here, in a module every
// route imports, so ts-node and ts-jest pick it up without a .d.ts).
declare module 'express-serve-static-core' {
  interface Request {
    user?: AuthUser;
    /** True on the background Auto plan's synthetic request. */
    autoSchedule?: boolean;
  }
}

/** Kept for existing imports: any Express request (user is optional). */
export type AuthRequest = Request;

/**
 * The signed-in user of a request that went through requireAuth. Throws a
 * 401 error if there is none (a route mounted without requireAuth).
 */
export function authUser(req: Request): AuthUser {
  if (!req.user) throw Object.assign(new Error('Authentication required'), { status: 401 });
  return req.user;
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as jwt.JwtPayload & Partial<AuthUser>;
    req.user = {
      sub: payload.sub ?? '',
      username: String(payload.username ?? ''),
      role: String(payload.role ?? ''),
      companyId: payload.companyId ?? null,
    };
    next();
  } catch {
    res.status(401).json({ error: 'Invalid or expired token' });
  }
}

export function requireRole(...roles: string[]) {
  return (req: AuthRequest, res: Response, next: NextFunction): void => {
    if (!req.user) { res.status(401).json({ error: 'Authentication required' }); return; }
    if (!roles.includes(req.user.role)) { res.status(403).json({ error: 'Insufficient permissions' }); return; }
    next();
  };
}

/**
 * Roles allowed to change plans: generate/save schedules, move/pin operations,
 * edit changeovers, shifts and machines, approve and send to SYSPRO.
 * 'Approver' is the Windows (NTLM) planning role from dbo.sch_ADUsers.
 * 'viewer' and 'Reviewer' are read-only.
 */
export const PLANNING_ROLES = ['super_admin', 'company_admin', 'planner', 'Approver'];

export const requirePlanner = requireRole(...PLANNING_ROLES);

export function requireSuperAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user || req.user.role !== 'super_admin') {
    res.status(403).json({ error: 'Super admin access required' });
    return;
  }
  next();
}

export function requireCompanyAdmin(req: AuthRequest, res: Response, next: NextFunction): void {
  if (!req.user || !['super_admin', 'company_admin'].includes(req.user.role)) {
    res.status(403).json({ error: 'Company admin access required' });
    return;
  }
  next();
}

/** Constant-time string compare. */
const sameSecret = (a: string, b: string): boolean => {
  const x = Buffer.from(a), y = Buffer.from(b);
  return x.length === y.length && crypto.timingSafeEqual(x, y);
};

/**
 * Shop-floor screens: accept the X-Shopfloor-Key header (from the screen link)
 * or a normal signed-in user. Anyone else on the LAN gets 401.
 */
export function requireShopfloorAccess(req: AuthRequest, res: Response, next: NextFunction): void {
  const key = req.headers['x-shopfloor-key'];
  if (typeof key === 'string' && key && sameSecret(key, SHOPFLOOR_KEY)) { next(); return; }
  if (req.headers.authorization) { requireAuth(req, res, next); return; }
  res.status(401).json({ error: 'This screen needs the shop-floor link — ask an admin for it (Settings → Shop-floor screen).' });
}
