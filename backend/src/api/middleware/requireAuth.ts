import { Request, Response, NextFunction } from 'express';
import jwt from 'jsonwebtoken';
import { JWT_SECRET } from '../../config/secrets';

export interface AuthRequest extends Request {
  user?: {
    /** Numeric DB id for local users; "ntlm:domain\user" for Windows users */
    sub: number | string;
    username: string;
    role: string;
    companyId: number | null;
  };
}

export function requireAuth(req: AuthRequest, res: Response, next: NextFunction): void {
  const header = req.headers.authorization;
  if (!header || !header.startsWith('Bearer ')) {
    res.status(401).json({ error: 'Authentication required' });
    return;
  }
  const token = header.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET) as any;
    req.user = { sub: payload.sub, username: payload.username, role: payload.role, companyId: payload.companyId };
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
