import { describe, it, expect } from 'vitest';
import { opStates } from '../ShopFloorView';

const op = (s: string, e: string) => ({ jobId: 'J', opId: 'J-OP1', resourceId: '', plannedStartDate: s, plannedEndDate: e });

describe('opStates', () => {
  it('marks done, now, the first upcoming as next, the rest later', () => {
    const now = new Date('2026-10-02T10:00:00').getTime();
    expect(opStates([
      op('2026-10-02T06:00:00', '2026-10-02T08:00:00'),
      op('2026-10-02T08:00:00', '2026-10-02T11:00:00'),
      op('2026-10-02T11:00:00', '2026-10-02T12:00:00'),
      op('2026-10-02T12:00:00', '2026-10-02T14:00:00'),
    ], now)).toEqual(['done', 'now', 'next', 'later']);
  });
});
