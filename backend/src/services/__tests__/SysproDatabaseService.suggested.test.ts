/** MRP suggested jobs join the plan only when the company setting is on. */
import SysproDatabaseService from '../SysproDatabaseService';
import { SYSPRO_QUERIES } from '../../database/queries/sysproDashboard';
import { planPublish, publishStateFor } from '../publishStatus';

const db = () => ({
  query: jest.fn(async (sql: string) => {
    if (sql === SYSPRO_QUERIES.getOpenJobs) return { recordset: [{ jobId: '000000000000101', itemCode: 'FG', quantity: 5, status: 'Released' }] };
    if (sql === SYSPRO_QUERIES.getOperationsForOpenJobs) return { recordset: [] };
    if (sql === SYSPRO_QUERIES.getSuggestedJobs) {
      return { recordset: [{ jobId: 'MRP-000000000000007', suggestedJob: '000000000000007', itemCode: 'FG2', quantity: 40, dueDate: '2026-10-20', releaseDate: '2026-10-10' }] };
    }
    if (sql === SYSPRO_QUERIES.getOperationsForSuggestedJobs) {
      return { recordset: [{ opId: 'MRP-000000000000007-OP10', jobId: 'MRP-000000000000007', sequence: 10, workcentreId: 'LINE1', duration: 2 }] };
    }
    if (sql === SYSPRO_QUERIES.getOpenJobMaterialRequirements) return { recordset: [{ jobId: '000000000000101', componentCode: 'RM', requiredQty: 3, issuedQty: 0, allocCompleted: 0 }] };
    if (sql === SYSPRO_QUERIES.getSuggestedJobMaterialRequirements) return { recordset: [{ jobId: 'MRP-000000000000007', componentCode: 'RM', requiredQty: 8, issuedQty: 0, allocCompleted: 0 }] };
    throw new Error('unexpected query');
  }),
  queryWithParams: jest.fn(),
});

describe('MRP suggested jobs', () => {
  it('are left out by default', async () => {
    const d = db();
    const s = new SysproDatabaseService(d as any);
    expect((await s.getOpenJobs()).map((j) => j.jobId)).toEqual(['000000000000101']);
    expect([...(await s.getOpenJobMaterialRequirements()).keys()]).toEqual(['000000000000101']);
    expect(d.query).not.toHaveBeenCalledWith(SYSPRO_QUERIES.getSuggestedJobs);
  });

  it('join open jobs and material needs as Planned MRP- jobs when on', async () => {
    const s = new SysproDatabaseService(db() as any, { includeSuggestedJobs: true });
    const jobs = await s.getOpenJobs();
    const sug: any = jobs.find((j) => j.jobId === 'MRP-000000000000007');
    expect(sug).toMatchObject({ isSuggested: true, suggestedJob: '000000000000007', status: 'Planned', itemCode: 'FG2', quantity: 40 });
    expect(sug.operations.map((o: any) => [o.sequence, o.workcentreId])).toEqual([[10, 'LINE1']]);
    const reqs = await s.getOpenJobMaterialRequirements();
    expect(reqs.get('MRP-000000000000007')![0]).toMatchObject({ componentCode: 'RM', outstandingQty: 8 });
  });

  it('are never published to SYSPRO', () => {
    const schedule = { jobSchedules: [
      { jobId: '000000000000101', operationSchedules: [{ opId: 'a' }] },
      { jobId: 'MRP-000000000000007', operationSchedules: [{ opId: 'b' }] },
    ] };
    expect(planPublish(schedule, new Map()).toPublish.map((j: any) => j.jobId)).toEqual(['000000000000101']);
    expect(publishStateFor(schedule, new Map()).map((j) => j.jobId)).toEqual(['000000000000101']);
  });
});
