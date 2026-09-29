import { getWipSnapshot, WIP_SNAPSHOT_SQL } from '../events';

describe('SSE WIP snapshot', () => {
  it('does not nest aggregate functions (SQL Server rejects MAX(CHECKSUM_AGG(...)))', () => {
    expect(WIP_SNAPSHOT_SQL).not.toMatch(/MAX\s*\(\s*[^)]*CHECKSUM_AGG/i);
    expect(WIP_SNAPSHOT_SQL).toMatch(/CHECKSUM_AGG/);
  });

  it('returns a stable fingerprint from the query row', async () => {
    const db = { query: jest.fn().mockResolvedValue({ recordset: [{ jobCount: 5, jobChk: 11, opChk: -7 }] }) };
    expect(await getWipSnapshot(db)).toBe('5|11|-7');
  });

  it('returns null (not a fake "change") when the query fails', async () => {
    const db = { query: jest.fn().mockRejectedValue(new Error('boom')) };
    expect(await getWipSnapshot(db)).toBeNull();
  });
});
