import { overlapIndex, OperationSlot } from '../SchedulingEngine';

const slot = (startMin: number, lenMin: number): OperationSlot =>
  ({ capacityStart: new Date(startMin * 60000), capacityEnd: new Date((startMin + lenMin) * 60000) } as OperationSlot);

describe('overlapIndex', () => {
  it('returns exactly the slots a full scan would, for random layouts', () => {
    let seed = 42;
    const rnd = () => ((seed = (seed * 1103515245 + 12345) % 2 ** 31) / 2 ** 31);
    for (let round = 0; round < 200; round++) {
      const slots = Array.from({ length: 1 + Math.floor(rnd() * 40) }, () => slot(Math.floor(rnd() * 5000), 1 + Math.floor(rnd() * 600)));
      const find = overlapIndex(slots);
      for (let q = 0; q < 20; q++) {
        const s = new Date(Math.floor(rnd() * 6000) * 60000);
        const e = new Date(s.getTime() + (1 + Math.floor(rnd() * 400)) * 60000);
        const brute = slots.filter((x) => x.capacityStart < e && x.capacityEnd > s);
        expect(new Set(find(s, e))).toEqual(new Set(brute));
      }
    }
  });

  it('touching slots do not overlap', () => {
    const find = overlapIndex([slot(0, 60), slot(120, 60)]);
    expect(find(new Date(60 * 60000), new Date(120 * 60000))).toEqual([]);
  });
});
