/**
 * Crew (labour) setup — pools of operators shared by an area's lines.
 *
 *   pools: { id, name, employees, headcount }   e.g. "Packing crew" with 6 employees
 *   lines: { [workcentreId]: { poolId, operators } }   NPCK-J needs 3 from Packing
 *
 * A crew's operators = the SYSPRO employees (BomEmployee) mapped to it. The
 * manual headcount is only used for a crew with no employees mapped (e.g. a
 * company that doesn't maintain BomEmployee).
 *
 * Stored in sch_AppState under 'crewSetup' (Manage → Crews). When enabled,
 * the scheduler never runs more operations at once in a pool than its
 * headcount can staff.
 */
import type { DbRow } from '../database/connection';
import { asObj, asArr } from './loose';

export interface CrewPool {
  id: string;
  name: string;
  /** Manual headcount — used only when no employees are mapped. */
  headcount: number;
  /** SYSPRO employee codes (BomEmployee) in this crew. */
  employees?: string[];
}

/** Operators the crew can field: mapped employees, else the manual headcount. */
export const effectiveHeadcount = (p: CrewPool): number =>
  p.employees && p.employees.length ? p.employees.length : p.headcount;

/** A SYSPRO employee as CRUX shows it (from BomEmployee). */
export interface SysproEmployee { code: string; name: string; workCentre?: string; shiftId?: string; active: boolean }

const pick = (row: DbRow, keys: string[]): string => {
  for (const k of keys) {
    const v = row[k];
    if (v !== undefined && v !== null && String(v).trim() !== '') return String(v).trim();
  }
  return '';
};

/**
 * Map a BomEmployee row (SYSPRO: Employee, Name, WorkCentre, ShiftId, …),
 * tolerating column-name differences between SYSPRO versions.
 */
export function mapEmployeeRow(row: DbRow): SysproEmployee | null {
  const code = pick(row, ['Employee', 'EmployeeCode', 'EmpNumber', 'Code']);
  if (!code) return null;
  const name = pick(row, ['Name', 'EmployeeName', 'Description'])
    || [pick(row, ['FirstName', 'Forename']), pick(row, ['Surname', 'LastName'])].filter(Boolean).join(' ')
    || code;
  const workCentre = pick(row, ['WorkCentre', 'DefaultWorkCentre', 'WorkCenter']) || undefined;
  const shiftId = pick(row, ['ShiftId', 'Shift']) || undefined;
  const terminated = row.DateTerminated ?? row.TerminationDate ?? row.DateLeft;
  const terminatedPast = terminated ? new Date(terminated).getTime() <= Date.now() : false;
  const onHold = String(row.OnHold ?? row.Inactive ?? '').trim().toUpperCase() === 'Y';
  return { code, name, workCentre, ...(shiftId ? { shiftId } : {}), active: !terminatedPast && !onHold };
}
export interface CrewLine { poolId: string; operators: number }
export interface CrewSetup { enabled: boolean; pools: CrewPool[]; lines: Record<string, CrewLine> }

/** A shift's working time: weekdays (0 = Sun) and windows in minutes from midnight (end < start = overnight). */
export interface ShiftWindowDef { workingDays: number[]; windows: Array<[number, number]> }

/**
 * Operators a crew can field over time: `constant` always, plus each
 * `shifts[i].count` employees while their shift is working.
 */
export interface CrewCapacity { constant: number; shifts: Array<{ count: number; def: ShiftWindowDef; name: string }> }

/** What the engine needs: per line, its pool and operators; per pool, its capacity and name. */
export interface CrewLookup {
  lineNeeds: Map<string, CrewLine>;
  /** Most operators the crew can ever field (for "crew too small" and messages). */
  headcount: Map<string, number>;
  poolName: Map<string, string>;
  /** Time-varying capacity; absent = constant `headcount`. */
  capacity?: Map<string, CrewCapacity>;
}

/** A CRUX shift template (Manage → Shifts), as far as crews need it. */
export interface ShiftTemplateLike {
  shiftId: string;
  name: string;
  startTime?: string;
  endTime?: string;
  workingDays?: number[];
  diversions?: Array<{ startTime: string; endTime: string; schedulable?: boolean; type?: string }>;
}

const toMin = (v?: string): number => {
  const [h, m] = String(v || '00:00').split(':').map((x) => Number(x) || 0);
  return Math.max(0, Math.min(1440, h * 60 + m));
};

/** Working windows of a shift: its schedulable diversions, else start–end. */
export function shiftDefFromTemplate(t: ShiftTemplateLike): ShiftWindowDef {
  const prod = (t.diversions || []).filter((d) =>
    typeof d.schedulable === 'boolean' ? d.schedulable : /production|overtime/i.test(String(d.type || '')));
  const windows: Array<[number, number]> = prod.length
    ? prod.map((d) => [toMin(d.startTime), toMin(d.endTime)])
    : [[toMin(t.startTime || '00:00'), toMin(t.endTime || '23:59')]];
  return { workingDays: t.workingDays?.length ? t.workingDays : [1, 2, 3, 4, 5], windows };
}

/** Is the shift working at this instant (local time)? Overnight windows belong to the day they start. */
export function shiftWorkingAt(def: ShiftWindowDef, t: Date): boolean {
  const minute = t.getHours() * 60 + t.getMinutes() + t.getSeconds() / 60;
  const day = t.getDay();
  const prevDay = (day + 6) % 7;
  for (const [a, b] of def.windows) {
    if (b > a) {
      if (def.workingDays.includes(day) && minute >= a && minute < b) return true;
    } else if (b < a) { // overnight
      if (def.workingDays.includes(day) && minute >= a) return true;
      if (def.workingDays.includes(prevDay) && minute < b) return true;
    }
  }
  return false;
}

export function capacityAt(cap: CrewCapacity, t: Date): number {
  let n = cap.constant;
  for (const s of cap.shifts) if (shiftWorkingAt(s.def, t)) n += s.count;
  return n;
}

/** Instants in (start, end) where a crew's capacity can change (shift window edges). */
export function capacityBreakpoints(cap: CrewCapacity, start: number, end: number): number[] {
  const out: number[] = [];
  if (!cap.shifts.length) return out;
  const day = new Date(start); day.setHours(0, 0, 0, 0);
  day.setDate(day.getDate() - 1); // overnight windows from the previous day
  for (; day.getTime() < end; day.setDate(day.getDate() + 1)) {
    for (const s of cap.shifts) for (const [a, b] of s.def.windows) {
      for (const m of [a, b < a ? b + 1440 : b]) {
        const t = new Date(day); t.setMinutes(m, 0, 0);
        const ms = t.getTime();
        if (ms > start && ms < end) out.push(ms);
      }
    }
  }
  return out;
}

export const EMPTY_CREW_SETUP: CrewSetup = { enabled: false, pools: [], lines: {} };

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pool';

/** Validate and clean a crew setup from the client. Returns an error message on bad input. */
export function normaliseCrewSetup(body: unknown): CrewSetup | string {
  if (!body || typeof body !== 'object') return 'Body must be a crew setup';
  const input = asObj(body);
  const pools: CrewPool[] = [];
  const seen = new Set<string>();
  const employeeCrew = new Map<string, string>();
  for (const item of asArr(input.pools)) {
    const raw = asObj(item);
    const name = String(raw.name ?? '').trim();
    if (!name) return 'Every crew needs a name';
    const headcount = Number(raw.headcount);
    if (!Number.isFinite(headcount) || headcount < 0 || headcount > 10000 || Math.floor(headcount) !== headcount) {
      return `Crew "${name}": headcount must be a whole number of operators`;
    }
    let id = String(raw.id ?? '').trim() || slug(name);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    const employees = Array.from(new Set(asArr(raw.employees)
      .map((e) => String(e ?? '').trim()).filter(Boolean)));
    for (const e of employees) {
      if (employeeCrew.has(e)) return `Employee ${e} is in two crews (${employeeCrew.get(e)} and ${name})`;
      employeeCrew.set(e, name);
    }
    pools.push({ id, name: name.slice(0, 80), headcount, employees });
  }
  const lines: Record<string, CrewLine> = {};
  for (const [wc, value] of Object.entries(asObj(input.lines))) {
    const raw = asObj(value);
    const poolId = String(raw.poolId ?? '').trim();
    if (!poolId) continue; // line not crew-constrained
    if (!seen.has(poolId)) return `Line ${wc} uses an unknown crew`;
    const operators = Number(raw.operators);
    if (!Number.isFinite(operators) || operators <= 0 || operators > 1000) {
      return `Line ${wc}: operators must be a positive number`;
    }
    lines[String(wc).trim()] = { poolId, operators };
  }
  return { enabled: input.enabled === true, pools, lines };
}

/**
 * Engine lookup, or undefined when crews are off or nothing is assigned.
 * With `employees` (SYSPRO codes + ShiftId) and `shifts` (CRUX shift
 * templates), each mapped employee counts only while their shift works;
 * employees without a known shift, and manual headcounts, count always.
 */
export function crewLookupFrom(
  setup: CrewSetup | undefined | null,
  employees?: Array<{ code: string; shiftId?: string }>,
  shifts?: ShiftTemplateLike[],
): CrewLookup | undefined {
  if (!setup?.enabled) return undefined;
  const headcount = new Map(setup.pools.map((p) => [p.id, effectiveHeadcount(p)] as const));
  const capacity = new Map<string, CrewCapacity>();
  if (employees?.length && shifts?.length) {
    const shiftOf = new Map(employees.map((e) => [e.code, (e.shiftId || '').trim().toLowerCase()] as const));
    const findShift = (code: string) => shifts.find((t) =>
      t.shiftId.toLowerCase() === code || t.name.trim().toLowerCase() === code);
    for (const p of setup.pools) {
      if (!p.employees?.length) continue;
      const cap: CrewCapacity = { constant: 0, shifts: [] };
      const byShift = new Map<string, { count: number; def: ShiftWindowDef; name: string }>();
      for (const code of p.employees) {
        const sc = shiftOf.get(code);
        const tpl = sc ? findShift(sc) : undefined;
        if (!tpl) { cap.constant++; continue; }
        const entry = byShift.get(tpl.shiftId) || { count: 0, def: shiftDefFromTemplate(tpl), name: tpl.name };
        entry.count++;
        byShift.set(tpl.shiftId, entry);
      }
      cap.shifts = [...byShift.values()];
      if (cap.shifts.length) capacity.set(p.id, cap);
    }
  }
  const poolName = new Map(setup.pools.map((p) => [p.id, p.name] as const));
  const lineNeeds = new Map<string, CrewLine>();
  for (const [wc, line] of Object.entries(setup.lines || {})) {
    if (headcount.has(line.poolId) && line.operators > 0) lineNeeds.set(wc, line);
  }
  return lineNeeds.size ? { lineNeeds, headcount, poolName, ...(capacity.size ? { capacity } : {}) } : undefined;
}
