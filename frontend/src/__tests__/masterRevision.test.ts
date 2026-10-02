import { describe, it, expect, vi, beforeEach } from 'vitest';
import { apiClient, scheduleService, masterRevision } from '../services/api';

const sched = { scheduleId: 'S1', jobSchedules: [] } as any;

describe('master save concurrency', () => {
  beforeEach(() => { vi.restoreAllMocks(); masterRevision.set(4); });

  it('saves one at a time; the second save is based on the first one\'s new revision', async () => {
    const sent: unknown[] = [];
    let rev = 4;
    vi.spyOn(apiClient, 'post').mockImplementation(async (_url: string, body: any) => {
      sent.push(body.baseRevision);
      await new Promise((r) => setTimeout(r, 5));
      return { data: { saved: true, revision: ++rev } } as any;
    });
    await Promise.all([scheduleService.save(sched), scheduleService.save(sched)]);
    expect(sent).toEqual([4, 5]);
    expect(masterRevision.get()).toBe(6);
  });

  it('a 409 MASTER_CHANGED marks a conflict until the master is reopened', async () => {
    vi.spyOn(apiClient, 'post').mockRejectedValue({ response: { status: 409, data: { code: 'MASTER_CHANGED', error: 'changed' } } });
    await expect(scheduleService.save(sched)).rejects.toBeTruthy();
    expect(masterRevision.inConflict()).toBe(true);
    vi.spyOn(apiClient, 'get').mockResolvedValue({ data: { schedule: sched, meta: { revision: 9 } } } as any);
    await scheduleService.openLatest();
    expect(masterRevision.inConflict()).toBe(false);
    expect(masterRevision.get()).toBe(9);
  });

  it('a failed save does not block the next one', async () => {
    const post = vi.spyOn(apiClient, 'post')
      .mockRejectedValueOnce(new Error('network'))
      .mockResolvedValueOnce({ data: { revision: 5 } } as any);
    await expect(scheduleService.save(sched)).rejects.toThrow('network');
    await scheduleService.save(sched);
    expect(post).toHaveBeenCalledTimes(2);
    expect(masterRevision.get()).toBe(5);
  });
});
