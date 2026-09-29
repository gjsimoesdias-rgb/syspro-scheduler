import {
  jobMatchesFilter, applyAdvancedSort, newGroup, countRules,
  type FilterGroup,
} from './advancedFilter';

const jobs: any[] = [
  { jobId: 'J1', itemCode: 'A', description: 'Peanut crunchy', quantity: 1000, priority: 5, dueDate: new Date('2026-07-20'), status: 'Released' },
  { jobId: 'J2', itemCode: 'B', description: 'Peanut smooth',  quantity: 200,  priority: 1, dueDate: new Date('2026-07-30'), status: 'Firm' },
  { jobId: 'J3', itemCode: 'C', description: 'Dark roast',     quantity: 5000, priority: 5, dueDate: new Date('2026-06-01'), status: 'Released' },
];

const g = (combinator: 'AND' | 'OR', children: any[]): FilterGroup => ({ id: 'g', kind: 'group', combinator, children });
const r = (field: string, operator: any, value = '', extra: any = {}) => ({ id: `r_${field}_${operator}`, kind: 'rule', field, operator, value, ...extra });

describe('advancedFilter engine', () => {
  it('AND requires every rule', () => {
    const f = g('AND', [r('status', 'is', 'Released'), r('quantity', 'gt', '500')]);
    expect(jobMatchesFilter(jobs[0], f)).toBe(true);
    expect(jobMatchesFilter(jobs[1], f)).toBe(false);
    expect(jobMatchesFilter(jobs[2], f)).toBe(true);
  });

  it('OR requires any rule', () => {
    const f = g('OR', [r('description', 'contains', 'smooth'), r('priority', 'eq', '5')]);
    expect(jobMatchesFilter(jobs[0], f)).toBe(true);
    expect(jobMatchesFilter(jobs[1], f)).toBe(true);
  });

  it('supports nested groups', () => {
    const f = g('AND', [
      r('status', 'is', 'Released'),
      g('OR', [r('quantity', 'gt', '4000'), r('priority', 'eq', '1')]),
    ]);
    expect(jobs.filter((j) => jobMatchesFilter(j, f)).map((j) => j.jobId)).toEqual(['J3']);
  });

  it('date operators compare by calendar day', () => {
    const f = g('AND', [r('dueDate', 'before', '2026-07-01')]);
    expect(jobMatchesFilter(jobs[2], f)).toBe(true);
    expect(jobMatchesFilter(jobs[0], f)).toBe(false);
  });

  it('between (number) is inclusive & order-independent', () => {
    const f = g('AND', [r('quantity', 'between', '4000', { value2: '6000' })]);
    expect(jobs.filter((j) => jobMatchesFilter(j, f)).map((j) => j.jobId)).toEqual(['J3']);
  });

  it('isAnyOf matches the set', () => {
    const f = g('AND', [r('status', 'isAnyOf', '', { values: ['Firm', 'OnHold'] })]);
    expect(jobs.filter((j) => jobMatchesFilter(j, f)).map((j) => j.jobId)).toEqual(['J2']);
  });

  it('empty / incomplete filter passes everything', () => {
    expect(jobs.every((j) => jobMatchesFilter(j, newGroup('AND')))).toBe(true);
    expect(jobs.every((j) => jobMatchesFilter(j, null))).toBe(true);
    expect(countRules(newGroup('AND'))).toBe(0);
  });

  it('uses context accessors for computed fields', () => {
    const ctx = { materialStatus: (j: any) => (j.jobId === 'J2' ? 'No Materials' : 'Materials') };
    const f = g('AND', [r('materialStatus', 'is', 'No Materials')]);
    expect(jobs.filter((j) => jobMatchesFilter(j, f, ctx)).map((j) => j.jobId)).toEqual(['J2']);
  });

  it('single & multi-level sort', () => {
    expect(applyAdvancedSort(jobs, [{ id: 's', field: 'quantity', direction: 'desc' }]).map((j) => j.jobId)).toEqual(['J3', 'J1', 'J2']);
    expect(applyAdvancedSort(jobs, [
      { id: 's1', field: 'priority', direction: 'asc' },
      { id: 's2', field: 'quantity', direction: 'desc' },
    ]).map((j) => j.jobId)).toEqual(['J2', 'J3', 'J1']);
  });
});
