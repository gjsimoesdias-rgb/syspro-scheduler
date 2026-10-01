import { describe, it, expect } from 'vitest';
import { passesMarkerFilter } from './markerStore';

describe('passesMarkerFilter', () => {
  const asg = { J1: 'rush', J2: 'trial' };
  it('passes everything with no filter', () => expect(passesMarkerFilter('', asg, 'J9')).toBe(true));
  it('matches one marker', () => {
    expect(passesMarkerFilter('rush', asg, 'J1')).toBe(true);
    expect(passesMarkerFilter('rush', asg, 'J2')).toBe(false);
  });
  it('__none keeps only unmarked jobs', () => {
    expect(passesMarkerFilter('__none', asg, 'J3')).toBe(true);
    expect(passesMarkerFilter('__none', asg, 'J1')).toBe(false);
  });
});
