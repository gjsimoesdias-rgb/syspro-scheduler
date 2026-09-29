/**
 * completeJobFamilies — master/sub family completion (WipMasterSub).
 */

import { completeJobFamilies } from './jobFamilies';
import { Job } from '../types';

function j(jobId: string, masterJobId?: string): Job {
  return {
    jobId,
    itemCode: `ITEM-${jobId}`,
    description: jobId,
    quantity: 1,
    dueDate: new Date(),
    releaseDate: new Date(),
    priority: 5,
    status: 'Released',
    operations: [],
    estimatedMaterialCost: 0,
    estimatedLaborCost: 0,
    ...(masterJobId ? { masterJobId, isSubJob: true } : {}),
  } as Job;
}

describe('completeJobFamilies', () => {
  const jobs = [
    j('MST-1'),
    j('SUB-1A', 'MST-1'),
    j('SUB-1B', 'MST-1'),
    j('SOLO'),
    // Nested: SUB-1A is itself the master of a deeper sub-job
    j('SUB-1A-CHILD', 'SUB-1A'),
  ];

  it('selecting the master pulls in every sub-job (transitively)', () => {
    const { idSet, familyAdded } = completeJobFamilies(jobs, ['MST-1']);
    expect(idSet.has('SUB-1A')).toBe(true);
    expect(idSet.has('SUB-1B')).toBe(true);
    expect(idSet.has('SUB-1A-CHILD')).toBe(true); // nested level
    expect(idSet.has('SOLO')).toBe(false);
    expect(familyAdded).toEqual(expect.arrayContaining(['SUB-1A', 'SUB-1B', 'SUB-1A-CHILD']));
  });

  it('selecting a sub-job pulls in its master (and then the rest of the family)', () => {
    const { idSet } = completeJobFamilies(jobs, ['SUB-1B']);
    expect(idSet.has('MST-1')).toBe(true);
    expect(idSet.has('SUB-1A')).toBe(true);
    expect(idSet.has('SUB-1A-CHILD')).toBe(true);
    expect(idSet.has('SOLO')).toBe(false);
  });

  it('standalone selections are untouched', () => {
    const { idSet, familyAdded } = completeJobFamilies(jobs, ['SOLO']);
    expect(Array.from(idSet)).toEqual(['SOLO']);
    expect(familyAdded).toEqual([]);
  });

  it('a self-referencing masterJobId does not loop or add anything', () => {
    const weird = [j('LOOP', 'LOOP')];
    const { idSet, familyAdded } = completeJobFamilies(weird, ['LOOP']);
    expect(Array.from(idSet)).toEqual(['LOOP']);
    expect(familyAdded).toEqual([]);
  });

  it('a masterJobId pointing at a job not in the list still adds the id (server-side data may lag)', () => {
    const orphan = [j('ORPH', 'GHOST-MASTER')];
    const { idSet } = completeJobFamilies(orphan, ['ORPH']);
    // GHOST-MASTER is added to the selection; the later jobs.filter() simply
    // won't find it, which is harmless.
    expect(idSet.has('GHOST-MASTER')).toBe(true);
  });
});
