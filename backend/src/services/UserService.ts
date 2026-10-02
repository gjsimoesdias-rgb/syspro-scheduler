import bcrypt from 'bcryptjs';
import { isLocalUserId, saveNamed } from './SettingsService';
import { DatabaseConnection, type DbParams, type DbRow } from '../database/connection';

export interface UserRecord {
  id: number;
  companyId: number | null;
  companyName: string | null;
  username: string;
  email: string;
  role: string;
  fullName: string | null;
  isActive: boolean;
  lastLogin: Date | null;
  createdAt: Date;
}

export class UserService {
  private db: DatabaseConnection;
  constructor(db: DatabaseConnection) { this.db = db; }

  async listUsers(companyId: number | null, role: string): Promise<UserRecord[]> {
    let sql = `
      SELECT u.id, u.company_id, c.name AS company_name, u.username, u.email,
             u.role, u.full_name, u.is_active, u.last_login, u.created_at
      FROM   dbo.lic_users u
      LEFT JOIN dbo.lic_companies c ON c.id = u.company_id
    `;
    const params: DbParams = {};
    if (role !== 'super_admin') {
      sql += ` WHERE u.company_id = @cid`;
      params.cid = companyId;
    }
    sql += ` ORDER BY u.created_at DESC`;
    const res = await this.db.queryWithParams(sql, params);
    return (res?.recordset || []).map(this.mapRow);
  }

  async getUserById(id: number): Promise<UserRecord | null> {
    const res = await this.db.queryWithParams(
      `SELECT u.id, u.company_id, c.name AS company_name, u.username, u.email,
              u.role, u.full_name, u.is_active, u.last_login, u.created_at
       FROM   dbo.lic_users u
       LEFT JOIN dbo.lic_companies c ON c.id = u.company_id
       WHERE  u.id = @id`,
      { id }
    );
    const row = res?.recordset?.[0];
    return row ? this.mapRow(row) : null;
  }

  async createUser(data: {
    companyId: number;
    username: string;
    email: string;
    password: string;
    role: string;
    fullName?: string;
  }): Promise<UserRecord> {
    // Check license user limit
    const licRes = await this.db.queryWithParams(
      `SELECT l.max_users,
              (SELECT COUNT(*) FROM dbo.lic_users WHERE company_id = @cid AND is_active = 1) AS current_users
       FROM   dbo.lic_companies c
       JOIN   dbo.lic_licenses l ON l.id = c.license_id
       WHERE  c.id = @cid`,
      { cid: data.companyId }
    );
    const lic = licRes?.recordset?.[0];
    if (lic && lic.current_users >= lic.max_users) {
      throw new Error(`License user limit reached (${lic.max_users} users)`);
    }

    const hash = await bcrypt.hash(data.password, 10);
    const res = await this.db.queryWithParams(
      `INSERT INTO dbo.lic_users (company_id, username, email, password_hash, role, full_name)
       OUTPUT INSERTED.id
       VALUES (@cid, @username, @email, @hash, @role, @fullName)`,
      {
        cid: data.companyId,
        username: data.username,
        email: data.email,
        hash,
        role: data.role || 'planner',
        fullName: data.fullName || null,
      }
    );
    const newId = res?.recordset?.[0]?.id;
    return this.mustGet(newId);
  }

  async updateUser(id: number, data: {
    username?: string;
    email?: string;
    password?: string;
    role?: string;
    fullName?: string;
    isActive?: boolean;
  }): Promise<UserRecord> {
    const sets: string[] = [];
    const params: DbParams = { id };
    if (data.username !== undefined) { sets.push('username = @username'); params.username = data.username; }
    if (data.email !== undefined) { sets.push('email = @email'); params.email = data.email; }
    if (data.password) { sets.push('password_hash = @hash'); params.hash = await bcrypt.hash(data.password, 10); }
    if (data.role !== undefined) { sets.push('role = @role'); params.role = data.role; }
    if (data.fullName !== undefined) { sets.push('full_name = @fullName'); params.fullName = data.fullName; }
    if (data.isActive !== undefined) { sets.push('is_active = @isActive'); params.isActive = data.isActive ? 1 : 0; }
    sets.push('updated_at = GETDATE()');

    await this.db.queryWithParams(
      `UPDATE dbo.lic_users SET ${sets.join(', ')} WHERE id = @id`,
      params
    );
    return this.mustGet(id);
  }

  async deleteUser(id: number): Promise<void> {
    await this.db.queryWithParams(`DELETE FROM dbo.lic_users WHERE id = @id`, { id });
  }

  /** Re-read a user just written; a missing row means the write failed. */
  private async mustGet(id: number): Promise<UserRecord> {
    const user = await this.getUserById(id);
    if (!user) throw new Error(`User ${id} not found after saving`);
    return user;
  }

  async getColumnProfile(userId: number): Promise<{ visibleJobColumns: string[]; profileName?: string } | null> {
    const res = await this.db.queryWithParams(
      `SELECT column_profile FROM dbo.lic_users WHERE id = @id`, { id: userId }
    );
    const row = res?.recordset?.[0];
    if (!row || !row.column_profile) return null;
    try { return JSON.parse(row.column_profile); } catch { return null; }
  }

  /** Column profile for any signed-in user (Windows sign-ins are stored by name). */
  async getColumnProfileFor(sub: number | string): Promise<{ visibleJobColumns: string[]; profileName?: string } | null> {
    if (isLocalUserId(sub)) return this.getColumnProfile(Number(sub));
    const res = await this.db.queryWithParams(
      `SELECT ColumnProfile FROM dbo.sch_NamedUserSettings WHERE UserKey = @key`, { key: String(sub) });
    const raw = res?.recordset?.[0]?.ColumnProfile;
    if (!raw) return null;
    try { return JSON.parse(raw); } catch { return null; }
  }

  async saveColumnProfileFor(sub: number | string, profile: { visibleJobColumns: string[]; profileName?: string }): Promise<void> {
    if (isLocalUserId(sub)) return this.saveColumnProfile(Number(sub), profile);
    await saveNamed(this.db, String(sub), 'ColumnProfile', JSON.stringify(profile));
  }

  async saveColumnProfile(userId: number, profile: { visibleJobColumns: string[]; profileName?: string }): Promise<void> {
    await this.db.queryWithParams(
      `UPDATE dbo.lic_users SET column_profile = @profile, updated_at = GETDATE() WHERE id = @id`,
      { id: userId, profile: JSON.stringify(profile) }
    );
  }

  async changePassword(id: number, currentPassword: string, newPassword: string): Promise<void> {
    const res = await this.db.queryWithParams(
      `SELECT password_hash FROM dbo.lic_users WHERE id = @id`, { id }
    );
    const row = res?.recordset?.[0];
    if (!row) throw new Error('User not found');
    const valid = await bcrypt.compare(currentPassword, row.password_hash);
    if (!valid) throw new Error('Current password is incorrect');
    const hash = await bcrypt.hash(newPassword, 10);
    await this.db.queryWithParams(
      `UPDATE dbo.lic_users SET password_hash = @hash, updated_at = GETDATE() WHERE id = @id`,
      { hash, id }
    );
  }

  private mapRow(row: DbRow): UserRecord {
    return {
      id: row.id,
      companyId: row.company_id,
      companyName: row.company_name,
      username: row.username,
      email: row.email,
      role: row.role,
      fullName: row.full_name,
      isActive: !!row.is_active,
      lastLogin: row.last_login ? new Date(row.last_login) : null,
      createdAt: new Date(row.created_at),
    };
  }
}

export default UserService;
