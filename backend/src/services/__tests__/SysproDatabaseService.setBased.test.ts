/**
 * Phase 4 — set-based loaders: open jobs load with a fixed number of queries,
 * whatever the job count (was 1 + N).
 */
import SysproDatabaseService from '../SysproDatabaseService';
import { SYSPRO_QUERIES } from '../../database/queries/sysproDashboard';

const jobRow = (jobId: string) => ({
  jobId, itemCode: `ITEM-${jobId.trim()}`, quantity: 10, dueDate: '2026-11-01', releaseDate: '2026-10-01', status: 'Released',
});
const opRow = (jobId: string, seq: number) => ({
  opId: `${jobId.trim()}-OP${seq}`, jobId, sequence: seq, workcentreId: 'WC1', duration: 60, setupTime: 0,
  queueTime: 0, moveTime: 0, batchSize: 1, status: 'NotStarted',
});

describe('SysproDatabaseService.getOpenJobs (set-based)', () => {
  it('loads N jobs and their operations in two queries and groups ops by trimmed job id', async () => {
    const calls: string[] = [];
    const db = {
      query: jest.fn(async (sql: string) => {
        calls.push(sql);
        if (sql === SYSPRO_QUERIES.getOpenJobs) {
          return { recordset: [jobRow('000000000000101'), jobRow('000000000000102'), jobRow('000000000000103')] };
        }
        if (sql === SYSPRO_QUERIES.getOperationsForOpenJobs) {
          // char(20) keys come back space-padded on the ops side
          return { recordset: [opRow('000000000000101   ', 10), opRow('000000000000101   ', 20), opRow('000000000000103   ', 10)] };
        }
        throw new Error('unexpected query');
      }),
      queryWithParams: jest.fn(async () => { throw new Error('no per-job queries expected'); }),
    };
    const jobs = await new SysproDatabaseService(db as any).getOpenJobs();

    expect(calls).toHaveLength(2);
    expect(db.queryWithParams).not.toHaveBeenCalled();
    const ops = Object.fromEntries(jobs.map((j) => [String(j.jobId).trim(), j.operations.map((o) => o.sequence)]));
    expect(ops).toEqual({ '000000000000101': [10, 20], '000000000000102': [], '000000000000103': [10] });
  });

  it('the set-based ops query covers open jobs only and has no per-job parameter', () => {
    const sql = SYSPRO_QUERIES.getOperationsForOpenJobs;
    expect(sql).not.toContain('@jobId');
    expect(sql).toContain("ISNULL(wm.Complete, 'N') <> 'Y'");
  });
});
