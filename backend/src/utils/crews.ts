/**
 * Crew (labour) setup — pools of operators shared by an area's lines.
 *
 *   pools: { id, name, headcount }        e.g. "Packing crew", 6 operators
 *   lines: { [workcentreId]: { poolId, operators } }   NPCK-J needs 3 from Packing
 *
 * Stored in sch_AppState under 'crewSetup' (Manage → Crews). When enabled,
 * the scheduler never runs more operations at once in a pool than its
 * headcount can staff.
 */
export interface CrewPool { id: string; name: string; headcount: number }
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
    pools.push({ id, name: name.slice(0, 80), headcount });
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
  const headcount = new Map(setup.pools.map((p) => [p.id, p.headcount] as const));
  const poolName = new Map(setup.pools.map((p) => [p.id, p.name] as const));
  const lineNeeds = new Map<string, CrewLine>();
  for (const [wc, line] of Object.entries(setup.lines || {})) {
    if (headcount.has(line.poolId) && line.operators > 0) lineNeeds.set(wc, line);
  }
  return lineNeeds.size ? { lineNeeds, headcount, poolName } : undefined;
}
