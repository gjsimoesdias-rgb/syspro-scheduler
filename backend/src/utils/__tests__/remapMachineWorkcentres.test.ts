import { remapMachineWorkcentres } from '../remapMachineWorkcentres';

describe('remapMachineWorkcentres', () => {
  it('moves machine-coded ops onto their line, leaves known and unknown ones', () => {
    const jobs = [{ operations: [
      { opId: 'a', workcentreId: 'NMILL', qualifiedResourceIds: [] },
      { opId: 'b', workcentreId: 'LINE2', qualifiedResourceIds: ['NPCK-J'] },
      { opId: 'c', workcentreId: 'NROAST', qualifiedResourceIds: [] },
    ] }];
    const moved = remapMachineWorkcentres(jobs, ['LINE1', 'LINE2'], [
      { resourceId: 'NMILL', worcentreId: 'LINE1' }, { resourceId: 'NPCK-J', worcentreId: 'LINE2' },
    ]);
    expect(moved).toBe(1);
    expect(jobs[0].operations[0]).toMatchObject({ workcentreId: 'LINE1', qualifiedResourceIds: ['NMILL'], routedWorkcentreId: 'NMILL', IMachine: 'NMILL' });
    expect(jobs[0].operations[1].workcentreId).toBe('LINE2');
    expect(jobs[0].operations[2].workcentreId).toBe('NROAST');
  });
});
