import { normaliseMarkers } from '../jobMarkers';

describe('normaliseMarkers', () => {
  it('keeps valid definitions and drops assignments to unknown markers', () => {
    const m = normaliseMarkers({
      definitions: [{ id: 'hi', name: 'High', color: '#ff0000' }],
      assignments: { J1: 'hi', J2: 'gone' },
    });
    expect(m.definitions).toEqual([{ id: 'hi', name: 'High', color: '#FF0000' }]);
    expect(m.assignments).toEqual({ J1: 'hi' });
  });
  it('rejects bad colours and duplicate ids', () => {
    expect(() => normaliseMarkers({ definitions: [{ id: 'a', name: 'A', color: 'red' }] })).toThrow(/colour/);
    expect(() => normaliseMarkers({ definitions: [
      { id: 'a', name: 'A', color: '#000000' }, { id: 'a', name: 'B', color: '#000000' }] })).toThrow(/Duplicate/);
  });
  it('treats an empty body as no markers', () => {
    expect(normaliseMarkers(undefined)).toEqual({ definitions: [], assignments: {} });
  });
});
