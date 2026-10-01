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

const pick = (row: Record<string, any>, keys: string[]): string => {
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
export function mapEmployeeRow(row: Record<string, any>): SysproEmployee | null {
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

/** What the engine needs: per line, its pool and operators; per pool, the headcount and name. */
export interface CrewLookup {
  lineNeeds: Map<string, CrewLine>;
  headcount: Map<string, number>;
  poolName: Map<string, string>;
}

export const EMPTY_CREW_SETUP: CrewSetup = { enabled: false, pools: [], lines: {} };

const slug = (s: string) => s.trim().toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-|-$/g, '') || 'pool';

/** Validate and clean a crew setup from the client. Returns an error message on bad input. */
export function normaliseCrewSetup(input: any): CrewSetup | string {
  if (!input || typeof input !== 'object') return 'Body must be a crew setup';
  const pools: CrewPool[] = [];
  const seen = new Set<string>();
  const employeeCrew = new Map<string, string>();
  for (const raw of Array.isArray(input.pools) ? input.pools : []) {
    const name = String(raw?.name ?? '').trim();
    if (!name) return 'Every crew needs a name';
    const headcount = Number(raw?.headcount);
    if (!Number.isFinite(headcount) || headcount < 0 || headcount > 10000 || Math.floor(headcount) !== headcount) {
      return `Crew "${name}": headcount must be a whole number of operators`;
    }
    let id = String(raw?.id ?? '').trim() || slug(name);
    while (seen.has(id)) id = `${id}-2`;
    seen.add(id);
    const employees = Array.from(new Set((Array.isArray(raw?.employees) ? raw.employees : [])
      .map((e: unknown) => String(e ?? '').trim()).filter(Boolean))) as string[];
    for (const e of employees) {
      if (employeeCrew.has(e)) return `Employee ${e} is in two crews (${employeeCrew.get(e)} and ${name})`;
      employeeCrew.set(e, name);
    }
    pools.push({ id, name: name.slice(0, 80), headcount, employees });
  }
  const lines: Record<string, CrewLine> = {};
  const lineInput = input.lines && typeof input.lines === 'object' ? input.lines : {};
  for (const [wc, raw] of Object.entries<any>(lineInput)) {
    const poolId = String(raw?.poolId ?? '').trim();
    if (!poolId) continue; // line not crew-constrained
    if (!seen.has(poolId)) return `Line ${wc} uses an unknown crew`;
    const operators = Number(raw?.operators);
    if (!Number.isFinite(operators) || operators <= 0 || operators > 1000) {
      return `Line ${wc}: operators must be a positive number`;
    }
    lines[String(wc).trim()] = { poolId, operators };
  }
  return { enabled: input.enabled === true, pools, lines };
}

/** Engine lookup, or undefined when crews are off or nothing is assigned. */
export function crewLookupFrom(setup: CrewSetup | undefined | null): CrewLookup | undefined {
  if (!setup?.enabled) return undefined;
  const headcount = new Map(setup.pools.map((p) => [p.id, effectiveHeadcount(p)] as const));
  const poolName = new Map(setup.pools.map((p) => [p.id, p.name] as const));
  const lineNeeds = new Map<string, CrewLine>();
  for (const [wc, line] of Object.entries(setup.lines || {})) {
    if (headcount.has(line.poolId) && line.operators > 0) lineNeeds.set(wc, line);
  }
  return lineNeeds.size ? { lineNeeds, headcount, poolName } : undefined;
}
