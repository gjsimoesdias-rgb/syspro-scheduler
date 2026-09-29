/**
 * Advanced filter + sort engine for the Production Jobs grid (Workflow tab).
 *
 * Pure, dependency-free logic so it can be unit-tested and reused. The UI
 * (AdvancedFilterBuilder) edits the FilterGroup tree; the grid applies it via
 * `jobMatchesFilter` + `applyAdvancedSort`.
 */

export type FieldType = 'text' | 'number' | 'date' | 'enum';

export type TextOp =
  | 'contains' | 'notContains' | 'equals' | 'notEquals'
  | 'startsWith' | 'endsWith' | 'isEmpty' | 'isNotEmpty';
export type NumberOp = 'eq' | 'neq' | 'gt' | 'gte' | 'lt' | 'lte' | 'between' | 'isEmpty';
export type DateOp = 'before' | 'after' | 'on' | 'between' | 'isEmpty';
export type EnumOp = 'is' | 'isNot' | 'isAnyOf' | 'isNoneOf';
export type AnyOp = TextOp | NumberOp | DateOp | EnumOp;

export interface FieldDef {
  key: string;
  label: string;
  type: FieldType;
  /** For enum fields: the allowed option values. */
  options?: string[];
}

export interface FilterRule {
  id: string;
  kind: 'rule';
  field: string;              // FieldDef.key ('' = incomplete, ignored)
  operator: AnyOp;
  value: string;             // primary value
  value2?: string;           // second value for 'between'
  values?: string[];         // for isAnyOf / isNoneOf
}

export interface FilterGroup {
  id: string;
  kind: 'group';
  combinator: 'AND' | 'OR';
  children: Array<FilterRule | FilterGroup>;
}

export interface SortSpec {
  id: string;
  field: string;
  direction: 'asc' | 'desc';
}

/** Fields available to filter/sort on the Production Jobs grid. */
export const JOB_FILTER_FIELDS: FieldDef[] = [
  { key: 'jobId',        label: 'Job',            type: 'text' },
  { key: 'itemCode',     label: 'Item',           type: 'text' },
  { key: 'description',  label: 'Description',     type: 'text' },
  { key: 'quantity',     label: 'Qty',            type: 'number' },
  { key: 'priority',     label: 'Priority',       type: 'number' },
  { key: 'dueDate',      label: 'Due Date',       type: 'date' },
  { key: 'releaseDate',  label: 'Release Date',   type: 'date' },
  { key: 'status',       label: 'Status',         type: 'enum',
    options: ['Released', 'Firm', 'Planned', 'InProgress', 'Complete', 'OnHold'] },
  { key: 'scheduleStatus', label: 'Schedule',     type: 'enum',
    options: ['Scheduled', 'Partial', 'Not Scheduled'] },
  { key: 'materialStatus', label: 'Materials',    type: 'enum',
    options: ['Materials', 'Partial', 'No Materials'] },
  { key: 'estimatedMaterialCost', label: 'Est. Material Cost', type: 'number' },
  { key: 'estimatedLaborCost',    label: 'Est. Labor Cost',    type: 'number' },
];

export const OPERATORS_BY_TYPE: Record<FieldType, Array<{ value: AnyOp; label: string }>> = {
  text: [
    { value: 'contains', label: 'contains' },
    { value: 'notContains', label: 'does not contain' },
    { value: 'equals', label: 'equals' },
    { value: 'notEquals', label: 'not equal' },
    { value: 'startsWith', label: 'starts with' },
    { value: 'endsWith', label: 'ends with' },
    { value: 'isEmpty', label: 'is empty' },
    { value: 'isNotEmpty', label: 'is not empty' },
  ],
  number: [
    { value: 'eq', label: '=' },
    { value: 'neq', label: '≠' },
    { value: 'gt', label: '>' },
    { value: 'gte', label: '≥' },
    { value: 'lt', label: '<' },
    { value: 'lte', label: '≤' },
    { value: 'between', label: 'between' },
    { value: 'isEmpty', label: 'is empty' },
  ],
  date: [
    { value: 'before', label: 'before' },
    { value: 'after', label: 'after' },
    { value: 'on', label: 'on' },
    { value: 'between', label: 'between' },
    { value: 'isEmpty', label: 'is empty' },
  ],
  enum: [
    { value: 'is', label: 'is' },
    { value: 'isNot', label: 'is not' },
    { value: 'isAnyOf', label: 'is any of' },
    { value: 'isNoneOf', label: 'is none of' },
  ],
};

export function fieldDef(key: string): FieldDef | undefined {
  return JOB_FILTER_FIELDS.find((f) => f.key === key);
}

let _seq = 0;
export function uid(prefix = 'n'): string {
  _seq += 1;
  return `${prefix}_${Date.now().toString(36)}_${_seq}`;
}

export function newRule(): FilterRule {
  return { id: uid('r'), kind: 'rule', field: '', operator: 'contains', value: '' };
}
export function newGroup(combinator: 'AND' | 'OR' = 'AND'): FilterGroup {
  return { id: uid('g'), kind: 'group', combinator, children: [newRule()] };
}

/**
 * Resolves a comparable value for a field from a job. `ctx` supplies computed
 * statuses that aren't raw job properties.
 */
export interface FilterContext {
  scheduleStatus?: (job: any) => string;   // -> 'Scheduled' | 'Partial' | 'Not Scheduled'
  materialStatus?: (job: any) => string;    // -> 'Materials' | 'Partial' | 'No Materials'
}

export function getFieldValue(job: any, key: string, ctx: FilterContext = {}): unknown {
  if (key === 'scheduleStatus') return ctx.scheduleStatus ? ctx.scheduleStatus(job) : job.scheduleStatus;
  if (key === 'materialStatus') return ctx.materialStatus ? ctx.materialStatus(job) : job.materialStatus;
  return job ? job[key] : undefined;
}

function toNum(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const n = typeof v === 'number' ? v : Number(String(v).replace(/,/g, ''));
  return Number.isFinite(n) ? n : null;
}
function toTime(v: unknown): number | null {
  if (v === null || v === undefined || v === '') return null;
  const d = v instanceof Date ? v : new Date(String(v));
  const t = d.getTime();
  return Number.isNaN(t) ? null : t;
}
function isBlank(v: unknown): boolean {
  return v === null || v === undefined || String(v).trim() === '';
}

function evalRule(job: any, rule: FilterRule, ctx: FilterContext): boolean {
  const def = fieldDef(rule.field);
  if (!def) return true; // incomplete rule -> no effect
  const raw = getFieldValue(job, rule.field, ctx);

  if (def.type === 'text' || def.type === 'enum') {
    const s = raw === null || raw === undefined ? '' : String(raw);
    const sl = s.toLowerCase();
    switch (rule.operator) {
      case 'contains': return sl.includes(rule.value.toLowerCase());
      case 'notContains': return !sl.includes(rule.value.toLowerCase());
      case 'equals':
      case 'is': return sl === rule.value.toLowerCase();
      case 'notEquals':
      case 'isNot': return sl !== rule.value.toLowerCase();
      case 'startsWith': return sl.startsWith(rule.value.toLowerCase());
      case 'endsWith': return sl.endsWith(rule.value.toLowerCase());
      case 'isEmpty': return isBlank(raw);
      case 'isNotEmpty': return !isBlank(raw);
      case 'isAnyOf': return (rule.values || []).map((x) => x.toLowerCase()).includes(sl);
      case 'isNoneOf': return !(rule.values || []).map((x) => x.toLowerCase()).includes(sl);
      default: return true;
    }
  }

  if (def.type === 'number') {
    if (rule.operator === 'isEmpty') return toNum(raw) === null;
    const n = toNum(raw);
    const a = toNum(rule.value);
    if (n === null) return false;
    switch (rule.operator) {
      case 'eq': return a !== null && n === a;
      case 'neq': return a !== null && n !== a;
      case 'gt': return a !== null && n > a;
      case 'gte': return a !== null && n >= a;
      case 'lt': return a !== null && n < a;
      case 'lte': return a !== null && n <= a;
      case 'between': {
        const b = toNum(rule.value2 ?? '');
        if (a === null || b === null) return true;
        const lo = Math.min(a, b), hi = Math.max(a, b);
        return n >= lo && n <= hi;
      }
      default: return true;
    }
  }

  if (def.type === 'date') {
    if (rule.operator === 'isEmpty') return toTime(raw) === null;
    const t = toTime(raw);
    const a = toTime(rule.value);
    if (t === null) return false;
    // Compare on calendar-day granularity for on/before/after.
    const day = 86400000;
    const dayOf = (ms: number) => Math.floor(ms / day);
    switch (rule.operator) {
      case 'before': return a !== null && dayOf(t) < dayOf(a);
      case 'after': return a !== null && dayOf(t) > dayOf(a);
      case 'on': return a !== null && dayOf(t) === dayOf(a);
      case 'between': {
        const b = toTime(rule.value2 ?? '');
        if (a === null || b === null) return true;
        const lo = Math.min(a, b), hi = Math.max(a, b);
        return t >= lo && t <= hi + day - 1;
      }
      default: return true;
    }
  }

  return true;
}

/** True if the job satisfies the filter group. Empty tree -> true. */
export function jobMatchesFilter(job: any, group: FilterGroup | null, ctx: FilterContext = {}): boolean {
  if (!group) return true;
  const active = group.children.filter((c) =>
    c.kind === 'group' ? true : !!fieldDef((c as FilterRule).field)
  );
  if (active.length === 0) return true;
  const results = active.map((c) =>
    c.kind === 'group' ? jobMatchesFilter(job, c as FilterGroup, ctx) : evalRule(job, c as FilterRule, ctx)
  );
  return group.combinator === 'AND' ? results.every(Boolean) : results.some(Boolean);
}

/** Count the concrete (complete) rules in the tree — for the "active" badge. */
export function countRules(group: FilterGroup | null): number {
  if (!group) return 0;
  return group.children.reduce((acc, c) =>
    acc + (c.kind === 'group' ? countRules(c as FilterGroup) : (fieldDef((c as FilterRule).field) ? 1 : 0)), 0);
}

function compareValues(a: unknown, b: unknown, type: FieldType): number {
  if (type === 'number') {
    const x = toNum(a), y = toNum(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1; if (y === null) return -1;
    return x - y;
  }
  if (type === 'date') {
    const x = toTime(a), y = toTime(b);
    if (x === null && y === null) return 0;
    if (x === null) return 1; if (y === null) return -1;
    return x - y;
  }
  const x = a === null || a === undefined ? '' : String(a);
  const y = b === null || b === undefined ? '' : String(b);
  return x.localeCompare(y, undefined, { numeric: true, sensitivity: 'base' });
}

/** Stable multi-level sort. Returns a new array; empty sorts -> original order. */
export function applyAdvancedSort<T = any>(jobs: T[], sorts: SortSpec[], ctx: FilterContext = {}): T[] {
  const active = sorts.filter((s) => !!fieldDef(s.field));
  if (active.length === 0) return jobs;
  return jobs
    .map((job, index) => ({ job, index }))
    .sort((p, q) => {
      for (const s of active) {
        const def = fieldDef(s.field)!;
        const cmp = compareValues(
          getFieldValue(p.job, s.field, ctx),
          getFieldValue(q.job, s.field, ctx),
          def.type
        );
        if (cmp !== 0) return s.direction === 'asc' ? cmp : -cmp;
      }
      return p.index - q.index; // stable
    })
    .map((x) => x.job);
}
