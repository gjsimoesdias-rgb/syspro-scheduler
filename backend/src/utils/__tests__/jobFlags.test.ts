import { normaliseJobFlags, setJobFlag, effectiveJobFlags, pinsForJobs, EMPTY_JOB_FLAGS } from '../jobFlags';

describe('jobFlags', () => {
  it('normalises ids (trim, dedupe, drop blanks) and tolerates junk', () => {
    expect(normaliseJobFlags({ excluded: [' J1', 'J1', '', null], pinned: 'x' })).toEqual({ excluded: ['J1'], pinned: [] });
    expect(normaliseJobFlags(undefined)).toEqual(EMPTY_JOB_FLAGS);
  });

  it('sets and clears one flag without touching the other', () => {
    let f = setJobFlag(EMPTY_JOB_FLAGS, 'J1', 'excluded', true);
    f = setJobFlag(f, 'J2', 'pinned', true);
    expect(f).toEqual({ excluded: ['J1'], pinned: ['J2'] });
    expect(setJobFlag(f, 'J1', 'excluded', false)).toEqual({ excluded: [], pinned: ['J2'] });
  });

  it('merges stored flags with ids sent in the generate body', () => {
    const e = effectiveJobFlags({ excluded: ['A'], pinned: ['P'] }, { excludedJobIds: ['B'], pinnedJobIds: undefined });
    expect([...e.excluded].sort()).toEqual(['A', 'B']);
    expect([...e.pinned]).toEqual(['P']);
  });

  it('pins every open op of a pinned job where the master has it', () => {
    const master = {
      jobSchedules: [
        { jobId: 'J1', operationSchedules: [
          { opId: 'J1-OP10', workcentreId: 'WC', resourceId: 'M1', plannedStartDate: '2026-10-05T08:00:00Z', plannedEndDate: '2026-10-05T10:00:00Z' },
          { opId: 'J1-OP20', workcentreId: 'WC', resourceId: 'M1', plannedStartDate: '2026-10-05T10:00:00Z', plannedEndDate: '2026-10-05T12:00:00Z', opStatus: 'Complete' },
          { opId: 'J1-OP30', workcentreId: 'WC', resourceId: '', plannedStartDate: '2026-10-05T12:00:00Z', plannedEndDate: '2026-10-05T13:00:00Z' },
        ] },
        { jobId: 'J2', operationSchedules: [
          { opId: 'J2-OP10', workcentreId: 'WC', resourceId: 'M2', plannedStartDate: '2026-10-06T08:00:00Z', plannedEndDate: '2026-10-06T09:00:00Z' },
        ] },
      ],
    };
    const { pins, notInPlan } = pinsForJobs(master, new Set(['J1', 'J9']));
    expect([...pins.keys()]).toEqual(['J1::J1-OP10']);
    expect(pins.get('J1::J1-OP10')).toMatchObject({ resourceId: 'M1', plannedStartDate: '2026-10-05T08:00:00.000Z', pinnedBy: 'job-pin' });
    expect(notInPlan).toEqual(['J9']);
  });
});
