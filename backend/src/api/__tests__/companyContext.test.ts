import { pickCompany, companyFor, __resetCompanyCache } from '../companyContext';
import { isLocalUserId } from '../../services/SettingsService';

describe('pickCompany', () => {
  const rows = [{ id: 1, syspro_company_id: 'SysproCompanyA' }, { id: 2, syspro_company_id: 'syspROcompanyH' }];
  it('matches the connected SYSPRO DB case-insensitively', () => {
    expect(pickCompany(rows, 'SysproCompanyH')).toBe(2);
  });
  it('uses the only company on a single-company install', () => {
    expect(pickCompany([{ id: 7, syspro_company_id: null }], 'Anything')).toBe(7);
  });
  it('returns null when several companies exist and none matches', () => {
    expect(pickCompany(rows, 'Other')).toBeNull();
  });
});

describe('companyFor', () => {
  beforeEach(() => __resetCompanyCache());
  const app = (rows: any[]) => ({
    locals: {
      sysproDb: { config: { database: 'SysproCompanyH' } },
      schedulerDb: { query: jest.fn(async () => ({ recordset: rows })) },
    },
  });

  it('prefers the user\'s own company', async () => {
    const req: any = { user: { companyId: 3 }, app: app([{ id: 9 }]) };
    expect(await companyFor(req)).toBe(3);
  });

  it('super_admin / Windows users / Auto plan get the connected company', async () => {
    const req: any = { user: { companyId: null, role: 'super_admin' }, app: app([{ id: 1, syspro_company_id: 'X' }, { id: 2, syspro_company_id: 'SysproCompanyH' }]) };
    expect(await companyFor(req)).toBe(2);
  });
});

describe('isLocalUserId', () => {
  it('tells lic_users ids from Windows sign-ins', () => {
    expect(isLocalUserId(5)).toBe(true);
    expect(isLocalUserId('12')).toBe(true);
    expect(isLocalUserId('ntlm:CORP\\jo')).toBe(false);
    expect(isLocalUserId(0)).toBe(false);
  });
});
