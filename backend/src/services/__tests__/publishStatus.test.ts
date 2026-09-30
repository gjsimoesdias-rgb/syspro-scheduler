import { jobFingerprint, planPublish, publishStateFor, jobIdFromExportError, PublishRow } from '../publishStatus';

const job = (jobId: string, start: string, machine = 'M1') => ({
  jobId, plannedStartDate: start, plannedEndDate: '2026-10-02T16:00:00Z',
  operationSchedules: [{ opId: `${jobId}-OP10`, resourceId: machine, plannedStartDate: start, plannedEndDate: '2026-10-02T16:00:00Z' }],
});
const published = (j: any): PublishRow => ({ jobId: j.jobId, status: 'Published', fingerprint: jobFingerprint(j), publishedAt: new Date(), lastError: null });

describe('publish status', () => {
  const a = job('A', '2026-10-01T08:00:00Z');
  const b = job('B', '2026-10-01T09:00:00Z');
  const empty = { jobId: 'C', operationSchedules: [] };

  it('fingerprint changes with dates or machine, not with op order or seconds', () => {
    expect(jobFingerprint(a)).toBe(jobFingerprint({ ...a, operationSchedules: [...a.operationSchedules].reverse() }));
    expect(jobFingerprint(a)).toBe(jobFingerprint(job('A', '2026-10-01T08:00:30Z')));
    expect(jobFingerprint(a)).not.toBe(jobFingerprint(job('A', '2026-10-01T10:00:00Z')));
    expect(jobFingerprint(a)).not.toBe(jobFingerprint(job('A', '2026-10-01T08:00:00Z', 'M2')));
  });

  it('sends only changed or never-sent jobs; full re-sends all; jobs without ops are skipped', () => {
    const rows = new Map([['A', published(a)], ['B', published(job('B', '2026-10-05T09:00:00Z'))]]);
    const plan = planPublish({ jobSchedules: [a, b, empty] }, rows);
    expect(plan.toPublish.map((j) => j.jobId)).toEqual(['B']);
    expect(plan.unchanged).toEqual(['A']);
    expect(planPublish({ jobSchedules: [a, b, empty] }, rows, true).toPublish.map((j) => j.jobId)).toEqual(['A', 'B']);
  });

  it('reports Published / Pending / Error per job', () => {
    const rows = new Map<string, PublishRow>([
      ['A', published(a)],
      ['B', { jobId: 'B', status: 'Error', fingerprint: null, publishedAt: null, lastError: 'No WipMaster row updated for job B' }],
    ]);
    const states = publishStateFor({ jobSchedules: [a, b, job('D', '2026-10-01T08:00:00Z'), empty] }, rows);
    expect(states.map((s) => [s.jobId, s.state])).toEqual([['A', 'Published'], ['B', 'Error'], ['D', 'Pending']]);
    expect(states[1].lastError).toContain('WipMaster');
  });

  it('finds the job an export error names', () => {
    expect(jobIdFromExportError('No WipJobAllLab row updated for 000000000000123 operation 10', ['000000000000122', '000000000000123'])).toBe('000000000000123');
    expect(jobIdFromExportError('deadlock', ['A1'])).toBeNull();
  });
});
