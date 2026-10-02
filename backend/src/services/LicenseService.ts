import crypto from 'crypto';
import { DatabaseConnection } from '../database/connection';

export interface LicenseRecord {
  id: number;
  licenseKey: string;
  companyName: string;
  contactEmail: string | null;
  maxUsers: number;
  currentUsers: number;
  isActive: boolean;
  expiryDate: string | null;
  plan: string;
  notes: string | null;
  /** SYSPRO company database this licence's company plans (lic_companies.syspro_company_id). */
  sysproCompanyDb: string | null;
  createdAt: Date;
  updatedAt: Date;
}

const cleanDb = (v: unknown): string | null => {
  const s = String(v ?? '').trim();
  return s ? s.slice(0, 50) : null;
};

export class LicenseService {
  private db: DatabaseConnection;
  constructor(db: DatabaseConnection) { this.db = db; }

  private generateKey(): string {
    const seg = () => crypto.randomBytes(4).toString('hex').toUpperCase();
    return `SCHED-${seg()}-${seg()}-${seg()}`;
  }

  async listLicenses(): Promise<LicenseRecord[]> {
    const res = await this.db.query(
      `SELECT l.*,
              (SELECT TOP 1 c.syspro_company_id FROM dbo.lic_companies c WHERE c.license_id = l.id) AS syspro_company_db,
              (SELECT COUNT(*) FROM dbo.lic_users u
               JOIN dbo.lic_companies c2 ON c2.id = u.company_id
               WHERE c2.license_id = l.id AND u.is_active = 1) AS current_users
       FROM   dbo.lic_licenses l
       ORDER BY l.created_at DESC`
    );
    return (res?.recordset || []).map(this.mapRow);
  }

  async getLicenseById(id: number): Promise<LicenseRecord | null> {
    const res = await this.db.queryWithParams(
      `SELECT l.*,
              (SELECT TOP 1 c.syspro_company_id FROM dbo.lic_companies c WHERE c.license_id = l.id) AS syspro_company_db,
              (SELECT COUNT(*) FROM dbo.lic_users u
               JOIN dbo.lic_companies c2 ON c2.id = u.company_id
               WHERE c2.license_id = l.id AND u.is_active = 1) AS current_users
       FROM   dbo.lic_licenses l WHERE l.id = @id`,
      { id }
    );
    const row = res?.recordset?.[0];
    return row ? this.mapRow(row) : null;
  }

  async createLicense(data: {
    companyName: string;
    contactEmail?: string;
    maxUsers?: number;
    expiryDate?: string;
    plan?: string;
    notes?: string;
    sysproCompanyDb?: string;
  }): Promise<LicenseRecord> {
    const key = this.generateKey();
    const res = await this.db.queryWithParams(
      `INSERT INTO dbo.lic_licenses (license_key, company_name, contact_email, max_users, expiry_date, plan, notes)
       OUTPUT INSERTED.id
       VALUES (@key, @name, @email, @maxUsers, @expiry, @plan, @notes)`,
      {
        key,
        name: data.companyName,
        email: data.contactEmail || null,
        maxUsers: data.maxUsers || 5,
        expiry: data.expiryDate || null,
        plan: data.plan || 'standard',
        notes: data.notes || null,
      }
    );
    const newId = res?.recordset?.[0]?.id;

    // Create linked company record
    await this.db.queryWithParams(
      `INSERT INTO dbo.lic_companies (license_id, name, syspro_company_id) VALUES (@lid, @name, @db)`,
      { lid: newId, name: data.companyName, db: cleanDb(data.sysproCompanyDb) }
    );

    return (await this.getLicenseById(newId))!;
  }

  async updateLicense(id: number, data: {
    companyName?: string;
    contactEmail?: string;
    maxUsers?: number;
    isActive?: boolean;
    expiryDate?: string | null;
    plan?: string;
    notes?: string;
    sysproCompanyDb?: string | null;
  }): Promise<LicenseRecord> {
    const sets: string[] = ['updated_at = GETDATE()'];
    const params: Record<string, any> = { id };
    if (data.companyName !== undefined) { sets.push('company_name = @name'); params.name = data.companyName; }
    if (data.contactEmail !== undefined) { sets.push('contact_email = @email'); params.email = data.contactEmail; }
    if (data.maxUsers !== undefined) { sets.push('max_users = @maxUsers'); params.maxUsers = data.maxUsers; }
    if (data.isActive !== undefined) { sets.push('is_active = @isActive'); params.isActive = data.isActive ? 1 : 0; }
    if (data.expiryDate !== undefined) { sets.push('expiry_date = @expiry'); params.expiry = data.expiryDate || null; }
    if (data.plan !== undefined) { sets.push('plan = @plan'); params.plan = data.plan; }
    if (data.notes !== undefined) { sets.push('notes = @notes'); params.notes = data.notes; }

    await this.db.queryWithParams(
      `UPDATE dbo.lic_licenses SET ${sets.join(', ')} WHERE id = @id`, params
    );
    if (data.sysproCompanyDb !== undefined) {
      await this.db.queryWithParams(
        `UPDATE dbo.lic_companies SET syspro_company_id = @db WHERE license_id = @id`,
        { id, db: cleanDb(data.sysproCompanyDb) });
    }
    return (await this.getLicenseById(id))!;
  }

  async deleteLicense(id: number): Promise<void> {
    await this.db.queryWithParams(`DELETE FROM dbo.lic_licenses WHERE id = @id`, { id });
  }

  /** Get the company_id linked to this license */
  async getCompanyByLicenseId(licenseId: number): Promise<{ id: number; name: string } | null> {
    const res = await this.db.queryWithParams(
      `SELECT id, name FROM dbo.lic_companies WHERE license_id = @lid`,
      { lid: licenseId }
    );
    return res?.recordset?.[0] || null;
  }

  private mapRow(row: any): LicenseRecord {
    return {
      id: row.id,
      licenseKey: row.license_key,
      companyName: row.company_name,
      contactEmail: row.contact_email,
      maxUsers: row.max_users,
      currentUsers: row.current_users || 0,
      isActive: !!row.is_active,
      expiryDate: row.expiry_date ? new Date(row.expiry_date).toISOString().split('T')[0] : null,
      plan: row.plan,
      notes: row.notes,
      sysproCompanyDb: row.syspro_company_db ?? null,
      createdAt: new Date(row.created_at),
      updatedAt: new Date(row.updated_at),
    };
  }
}

export default LicenseService;
