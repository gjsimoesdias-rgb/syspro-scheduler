import { describe, it, expect } from 'vitest';
import { fmadText } from './fmad';

describe('fmadText', () => {
  it('in stock is OK', () => expect(fmadText({ fmad: '2026-10-01T00:00:00Z', status: 'in-stock', components: 2 }).cls).toBe('grid-flag-ok'));
  it('a PO date after the due date is flagged', () => {
    const r = fmadText({ fmad: '2026-10-09T00:00:00Z', status: 'on-order', limiting: 'RM1', components: 1 }, '2026-10-05');
    expect(r.cls).toBe('grid-flag-bad');
    expect(r.tip).toMatch(/RM1.*after the due date/);
  });
  it('no supply', () => expect(fmadText({ fmad: null, status: 'no-supply', components: 1 }).label).toBe('No supply'));
});
