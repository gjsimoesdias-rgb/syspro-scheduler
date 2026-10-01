import { CrewLoad, peakUsage } from '../crewLoad';
import { normaliseCrewSetup, crewLookupFrom } from '../../utils/crews';

const t = (h: number) => new Date(2026, 9, 5, h);

describe('crew load', () => {
  const setup = normaliseCrewSetup({
    enabled: true,
    pools: [{ name: 'Packing', headcount: 6 }],
    lines: { L1: { poolId: 'packing', operators: 3 }, L2: { poolId: 'packing', operators: 3 }, L3: { poolId: 'packing', operators: 3 } },
  });

  it('normalises and builds the lookup', () => {
    expect(typeof setup).toBe('object');
    const lookup = crewLookupFrom(setup as any)!;
    expect(lookup.headcount.get('packing')).toBe(6);
    expect(lookup.lineNeeds.get('L2')).toEqual({ poolId: 'packing', operators: 3 });
    expect(crewLookupFrom({ ...(setup as any), enabled: false })).toBeUndefined();
  });

  it('rejects bad input', () => {
    expect(normaliseCrewSetup({ pools: [{ name: '', headcount: 2 }] })).toMatch(/needs a name/);
    expect(normaliseCrewSetup({ pools: [{ name: 'A', headcount: 1.5 }] })).toMatch(/whole number/);
    expect(normaliseCrewSetup({ pools: [{ name: 'A', headcount: 2 }], lines: { L1: { poolId: 'zz', operators: 1 } } })).toMatch(/unknown crew/);
  });

  it('two 3-operator lines fit a crew of 6, a third waits until one of them finishes', () => {
    const load = new CrewLoad(crewLookupFrom(setup as any)!);
    expect(load.nextFreeAt('L1', t(8), t(12))).toBeNull();
    load.book('L1', t(8), t(12), 'A');
    expect(load.nextFreeAt('L2', t(9), t(11))).toBeNull();
    load.book('L2', t(9), t(11), 'B');
    expect(load.nextFreeAt('L3', t(10), t(13))!.getTime()).toBe(t(11).getTime());
    expect(load.nextFreeAt('L3', t(11), t(13))).toBeNull(); // L2 done at 11: 3 + 3 = 6
    load.book('L3', t(11), t(13), 'C');
    expect(load.nextFreeAt('L2', t(11), t(14))!.getTime()).toBe(t(12).getTime());
    expect(load.nextFreeAt('OTHER', t(8), t(12))).toBeNull();
  });

  it('peak usage treats back-to-back bookings as not overlapping', () => {
    const b = [{ start: 0, end: 10, operators: 3, jobId: 'a' }, { start: 10, end: 20, operators: 3, jobId: 'b' }];
    expect(peakUsage(b, 0, 20)).toBe(3);
  });
});
