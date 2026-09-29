/**
 * stripCompletedOperations — jobManagement.includeCompletedOps = false policy.
 */

import { stripCompletedOperations } from './jobFilters';
import { Job, Operation } from '../types';

function op(opId: string, jobId: string, status: Operation['status']): Operation {
  return {
    opId,
    jobId,
    sequence: 10,
    workcentreId: 'WC-A',
    workcentreName: 'WC-A',
    duration: 60,
    setupTime: 0,
    queueTime: 0,
    moveTime: 0,
    batchSize: 1,
    qualifiedResourceIds: [],
    status,
  };
}

function job(jobId: string, ops: Operation[]): Job {
  return {
    jobId,
    itemCode: `ITEM-${jobId}`,
    description: jobId,
    quantity: 1,
    dueDate: new Date(),
    releaseDate: new Date(),
    priority: 5,
    status: 'Released',
    operations: ops,
    estimatedMaterialCost: 0,
    estimatedLaborCost: 0,
  } as Job;
}

describe('stripCompletedOperations', () => {
  it('removes completed operations but keeps the rest of the job', () => {
    const input = [
      job('J1', [op('OP10', 'J1', 'Complete'), op('OP20', 'J1', 'NotStarted')]),
    ];
    const result = stripCompletedOperations(input);
    expect(result.jobs).toHaveLength(1);
    expect(result.jobs[0].operations.map((o) => o.opId)).toEqual(['OP20']);
    expect(result.completedOpsExcluded).toBe(1);
    expect(result.jobsExcluded).toBe(0);
  });

  it('drops jobs whose operations are ALL complete', () => {
    const input = [
      job('DONE', [op('OP10', 'DONE', 'Complete'), op('OP20', 'DONE', 'Complete')]),
      job('OPEN', [op('OP10', 'OPEN', 'InProgress')]),
    ];
    const result = stripCompletedOperations(input);
    expect(result.jobs.map((j) => j.jobId)).toEqual(['OPEN']);
    expect(result.jobsExcluded).toBe(1);
    expect(result.completedOpsExcluded).toBe(2);
  });

  it('keeps InProgress and NotStarted operations untouched', () => {
    const input = [job('J1', [op('OP10', 'J1', 'InProgress'), op('OP20', 'J1', 'NotStarted')])];
    const result = stripCompletedOperations(input);
    expect(result.jobs[0].operations).toHaveLength(2);
    expect(result.completedOpsExcluded).toBe(0);
  });

  it('does not mutate the input jobs', () => {
    const original = job('J1', [op('OP10', 'J1', 'Complete'), op('OP20', 'J1', 'NotStarted')]);
    stripCompletedOperations([original]);
    expect(original.operations).toHaveLength(2);
  });
});
