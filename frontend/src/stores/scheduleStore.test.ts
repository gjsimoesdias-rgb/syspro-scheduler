/**
 * scheduleStore — schedule-source invariants.
 *
 * Regression guard for the lost-edits bug (PLAN_2026-07-07 §3.1):
 * the autosave effect only persists schedules whose source is 'session',
 * and the SYSPRO-rebuild effect overwrites any schedule whose source is
 * NOT 'session'. Manual mutations must therefore flip the source to
 * 'session' via setScheduleSource.
 */

import { useScheduleStore } from './scheduleStore';

describe('scheduleStore — scheduleSource', () => {
  beforeEach(() => {
    useScheduleStore.getState().setScheduleSource('');
  });

  it('starts empty and updates via setScheduleSource', () => {
    expect(useScheduleStore.getState().scheduleSource).toBe('');
    useScheduleStore.getState().setScheduleSource('syspro');
    expect(useScheduleStore.getState().scheduleSource).toBe('syspro');
  });

  it("flipping to 'session' persists until explicitly changed", () => {
    const store = useScheduleStore.getState();
    store.setScheduleSource('syspro');
    store.setScheduleSource('session');
    expect(useScheduleStore.getState().scheduleSource).toBe('session');

    // Unrelated store updates must not reset the source.
    useScheduleStore.getState().setHighlightJobId('J-01');
    useScheduleStore.getState().setGenerationProgress(50);
    expect(useScheduleStore.getState().scheduleSource).toBe('session');
  });

  it('setSchedule alone does not change the source (callers must flip it)', () => {
    const store = useScheduleStore.getState();
    store.setScheduleSource('syspro');
    store.setSchedule({
      scheduleId: 's-1',
      scheduledDate: new Date(),
      version: 1,
      status: 'Draft',
      planningHorizon: { startDate: new Date(), endDate: new Date() },
      jobSchedules: [],
      resourceLoads: [],
      constraintViolations: [],
      metrics: {
        totalJobsScheduled: 0,
        jobsOnTime: 0,
        jobsTardy: 0,
        averageTardiness: 0,
        resourceUtilization: 0,
        overtimeHours: 0,
        criticalPathLength: 0,
        totalSetupTime: 0,
        totalQueueTime: 0,
        totalMoveTime: 0,
      },
    } as any);
    // Documents WHY App.tsx's markScheduleEdited() must be called on every
    // manual mutation — the store itself will not do it.
    expect(useScheduleStore.getState().scheduleSource).toBe('syspro');
  });
});
