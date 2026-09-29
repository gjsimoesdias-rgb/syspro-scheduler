import bcrypt from 'bcryptjs';
import jwt from 'jsonwebtoken';
import { DatabaseConnection } from '../database/connection';
import { logger } from '../utils/logger';

const JWT_SECRET = process.env.JWT_SECRET || 'change_this_secret_in_production';
const JWT_EXPIRES_IN = '8h';
const REFRESH_EXPIRES_IN = 7 * 24 * 60 * 60 * 1000; // 7 days ms

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: 'super_admin' | 'company_admin' | 'planner' | 'viewer';
  fullName: string | null;
  companyId: number | null;
  companyName: string | null;
}

export interface TokenPair {
  accessToken: string;
  refreshToken: string;
  user: AuthUser;
}

export class AuthService {
  private db: DatabaseConnection;

  constructor(db: DatabaseConnection) {
    this.db = db;
  }

  signToken(user: AuthUser): string {
    return jwt.sign(
      {
        sub: user.id,
        username: user.username,
        role: user.role,
        companyId: user.companyId,
      },
      JWT_SECRET,
      { expiresIn: JWT_EXPIRES_IN } as any
    );
  }

  verifyToken(token: string): any {
    return jwt.verify(token, JWT_SECRET);
  }

  async login(username: string, password: string): Promise<TokenPair> {
    const result = await this.db.queryWithParams(
      `SELECT u.id, u.username, u.email, u.password_hash, u.role, u.full_name,
              u.is_active, u.company_id, c.name AS company_name
       FROM   dbo.lic_users u
       LEFT JOIN dbo.lic_companies c ON c.id = u.company_id
       WHERE  u.username = @username OR u.email = @username`,
      { username }
    );

    const row = result?.recordset?.[0];
    if (!row) throw new Error('Invalid credentials');
    if (!row.is_active) throw new Error('Account is disabled');

    const valid = await bcrypt.compare(password, row.password_hash);
    if (!valid) throw new Error('Invalid credentials');

    // Check license if company user
    if (row.company_id) {
      const licRes = await this.db.queryWithParams(
        `SELECT l.is_active, l.expiry_date
         FROM   dbo.lic_companies c
         JOIN   dbo.lic_licenses  l ON l.id = c.license_id
         WHERE  c.id = @cid`,
        { cid: row.company_id }
      );
      const lic = licRes?.recordset?.[0];
      if (!lic || !lic.is_active) throw new Error('Company license is disabled');
      if (lic.expiry_date && new Date(lic.expiry_date) < new Date())
        throw new Error('Company license has expired');
    }

    const user: AuthUser = {
      id: row.id,
      username: row.username,
      email: row.email,
      role: row.role,
      fullName: row.full_name,
      companyId: row.company_id,
      companyName: row.company_name,
    };

    const accessToken = this.signToken(user);
    const refreshToken = require('crypto').randomBytes(64).toString('hex');
    const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_IN);

    await this.db.queryWithParams(
      `DELETE FROM dbo.lic_sessions WHERE user_id = @uid AND expires_at < GETDATE()`,
      { uid: user.id }
    );
    await this.db.queryWithParams(
      `INSERT INTO dbo.lic_sessions (user_id, refresh_token, expires_at) VALUES (@uid, @token, @exp)`,
      { uid: user.id, token: refreshToken, exp: expiresAt }
    );

    await this.db.queryWithParams(
      `UPDATE dbo.lic_users SET last_login = GETDATE() WHERE id = @uid`,
      { uid: user.id }
    );

    return { accessToken, refreshToken, user };
  }

  async refresh(refreshToken: string): Promise<TokenPair> {
    const res = await this.db.queryWithParams(
      `SELECT s.user_id, s.expires_at,
              u.username, u.email, u.role, u.full_name, u.is_active, u.company_id,
              c.name AS company_name
       FROM   dbo.lic_sessions s
       JOIN   dbo.lic_users u ON u.id = s.user_id
       LEFT JOIN dbo.lic_companies c ON c.id = u.company_id
       WHERE  s.refresh_token = @token`,
      { token: refreshToken }
    );
    const row = res?.recordset?.[0];
    if (!row) throw new Error('Invalid refresh token');
    if (new Date(row.expires_at) < new Date()) {
      await this.db.queryWithParams(`DELETE FROM dbo.lic_sessions WHERE refresh_token = @token`, { token: refreshToken });
      throw new Error('Refresh token expired');
    }
    if (!row.is_active) throw new Error('Account is disabled');

    const user: AuthUser = {
      id: row.user_id, username: row.username, email: row.email,
      role: row.role, fullName: row.full_name,
      companyId: row.company_id, companyName: row.company_name,
    };
    const newAccess = this.signToken(user);
    const newRefresh = require('crypto').randomBytes(64).toString('hex');
    const exp = new Date(Date.now() + REFRESH_EXPIRES_IN);

    await this.db.queryWithParams(
      `UPDATE dbo.lic_sessions SET refresh_token = @newTok, expires_at = @exp WHERE refresh_token = @oldTok`,
      { newTok: newRefresh, exp, oldTok: refreshToken }
    );
    return { accessToken: newAccess, refreshToken: newRefresh, user };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db.queryWithParams(
      `DELETE FROM dbo.lic_sessions WHERE refresh_token = @token`,
      { token: refreshToken }
    );
  }

  async getUserById(id: number): Promise<AuthUser | null> {
    const res = await this.db.queryWithParams(
      `SELECT u.id, u.username, u.email, u.role, u.full_name, u.company_id, c.name AS company_name
       FROM   dbo.lic_users u
       LEFT JOIN dbo.lic_companies c ON c.id = u.company_id
       WHERE  u.id = @id AND u.is_active = 1`,
      { id }
    );
    const row = res?.recordset?.[0];
    if (!row) return null;
    return {
      id: row.id, username: row.username, email: row.email,
      role: row.role, fullName: row.full_name,
      companyId: row.company_id, companyName: row.company_name,
    };
  }

  /** Seed default super admin on first run */
  async seedDefaultAdmin(): Promise<void> {
    const res = await this.db.query(`SELECT COUNT(*) AS cnt FROM dbo.lic_users`);
    const count = res?.recordset?.[0]?.cnt ?? 0;
    if (count > 0) return;

    const hash = await bcrypt.hash('Admin@2026!', 10);
    await this.db.queryWithParams(
      `INSERT INTO dbo.lic_users (username, email, password_hash, role, full_name, company_id)
       VALUES ('superadmin', 'admin@scheduler.com', @hash, 'super_admin', 'Super Admin', NULL)`,
      { hash }
    );
    logger.info('Default super admin created (username: superadmin)');
  }
}

export default AuthService;
