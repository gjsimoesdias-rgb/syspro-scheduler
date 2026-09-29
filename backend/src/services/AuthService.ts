import bcrypt from 'bcryptjs';
import crypto from 'crypto';
import jwt from 'jsonwebtoken';
import { DatabaseConnection } from '../database/connection';
import { logger } from '../utils/logger';
import { JWT_SECRET, JWT_EXPIRES_IN } from '../config/secrets';

/** The password older builds seeded for 'superadmin'. Only used to warn if it is still in place. */
const LEGACY_DEFAULT_ADMIN_PASSWORD = 'Admin@2026!';

/**
 * Refresh tokens are stored as a SHA-256 hash, so a leaked lic_sessions table
 * can't be replayed. The raw token only ever exists in the browser.
 */
const hashToken = (token: string): string =>
  crypto.createHash('sha256').update(token).digest('hex');

const newRefreshToken = (): string => crypto.randomBytes(64).toString('hex');
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
    const refreshToken = newRefreshToken();
    const expiresAt = new Date(Date.now() + REFRESH_EXPIRES_IN);

    await this.db.queryWithParams(
      `DELETE FROM dbo.lic_sessions WHERE user_id = @uid AND expires_at < GETDATE()`,
      { uid: user.id }
    );
    await this.db.queryWithParams(
      `INSERT INTO dbo.lic_sessions (user_id, refresh_token, expires_at) VALUES (@uid, @token, @exp)`,
      { uid: user.id, token: hashToken(refreshToken), exp: expiresAt }
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
      { token: hashToken(refreshToken) }
    );
    const row = res?.recordset?.[0];
    if (!row) throw new Error('Invalid refresh token');
    if (new Date(row.expires_at) < new Date()) {
      await this.db.queryWithParams(`DELETE FROM dbo.lic_sessions WHERE refresh_token = @token`, { token: hashToken(refreshToken) });
      throw new Error('Refresh token expired');
    }
    if (!row.is_active) throw new Error('Account is disabled');

    const user: AuthUser = {
      id: row.user_id, username: row.username, email: row.email,
      role: row.role, fullName: row.full_name,
      companyId: row.company_id, companyName: row.company_name,
    };
    const newAccess = this.signToken(user);
    const newRefresh = newRefreshToken();
    const exp = new Date(Date.now() + REFRESH_EXPIRES_IN);

    await this.db.queryWithParams(
      `UPDATE dbo.lic_sessions SET refresh_token = @newTok, expires_at = @exp WHERE refresh_token = @oldTok`,
      { newTok: hashToken(newRefresh), exp, oldTok: hashToken(refreshToken) }
    );
    return { accessToken: newAccess, refreshToken: newRefresh, user };
  }

  async logout(refreshToken: string): Promise<void> {
    await this.db.queryWithParams(
      `DELETE FROM dbo.lic_sessions WHERE refresh_token = @token`,
      { token: hashToken(refreshToken) }
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

  /**
   * Seed the first super admin on a brand-new scheduler DB.
   *
   * The password is random (or INITIAL_ADMIN_PASSWORD from .env if set) and is
   * printed once to the server console. Returns the credentials when a user was
   * created so a local first-run setup screen can show them; null otherwise.
   *
   * On an existing install it instead warns loudly if 'superadmin' still has the
   * well-known password older builds used.
   */
  async seedDefaultAdmin(): Promise<{ username: string; password: string } | null> {
    const res = await this.db.query(`SELECT COUNT(*) AS cnt FROM dbo.lic_users`);
    const count = res?.recordset?.[0]?.cnt ?? 0;

    if (count > 0) {
      await this.warnIfLegacyDefaultPassword();
      return null;
    }

    const envPassword = (process.env.INITIAL_ADMIN_PASSWORD || '').trim();
    const password = envPassword.length >= 12
      ? envPassword
      : crypto.randomBytes(12).toString('base64url');
    const hash = await bcrypt.hash(password, 10);
    await this.db.queryWithParams(
      `INSERT INTO dbo.lic_users (username, email, password_hash, role, full_name, company_id)
       VALUES ('superadmin', 'admin@scheduler.com', @hash, 'super_admin', 'Super Admin', NULL)`,
      { hash }
    );
    logger.info('Initial super admin created (username: superadmin)');
    // Printed straight to the console (not the structured log) so it shows in the
    // START_SCHEDULER window but is not shipped to any log file/collector.
    // eslint-disable-next-line no-console
    console.log(
      `\n  ==> Initial admin login:  superadmin / ${password}\n` +
      '      Sign in and change it now (Settings > Users). It will not be shown again.\n'
    );
    return { username: 'superadmin', password };
  }

  private async warnIfLegacyDefaultPassword(): Promise<void> {
    try {
      const r = await this.db.query(
        `SELECT password_hash FROM dbo.lic_users WHERE username = 'superadmin' AND is_active = 1`
      );
      const hash = r?.recordset?.[0]?.password_hash;
      if (hash && (await bcrypt.compare(LEGACY_DEFAULT_ADMIN_PASSWORD, hash))) {
        logger.warn('SECURITY: user "superadmin" still has the default password. Change it now (Settings > Users).');
        // eslint-disable-next-line no-console
        console.warn('\n  !!  SECURITY: "superadmin" still uses the default password — change it now.\n');
      }
    } catch {
      // Non-fatal: this is only a warning.
    }
  }
}

export default AuthService;
