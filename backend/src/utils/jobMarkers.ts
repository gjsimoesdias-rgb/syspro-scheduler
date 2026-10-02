/**
 * Job markers (LYNQ "Markers (Global)" / "Order marker"): planner-defined
 * coloured tags such as "Priority – High" or "Customer rush". One marker per
 * job. Stored in sch_AppState under 'jobMarkers'.
 */
export interface MarkerDef { id: string; name: string; color: string }
export interface JobMarkers { definitions: MarkerDef[]; assignments: Record<string, string> }

import { asObj, asArr } from './loose';

export const EMPTY_MARKERS: JobMarkers = { definitions: [], assignments: {} };

const HEX = /^#[0-9a-fA-F]{6}$/;

/** Validate and clean a markers payload; throws with a readable message. */
export function normaliseMarkers(input: unknown): JobMarkers {
  const raw = asObj(input);
  const defsIn = asArr(raw.definitions);
  if (defsIn.length > 50) throw new Error('At most 50 markers');
  const definitions: MarkerDef[] = [];
  const ids = new Set<string>();
  for (const item of defsIn) {
    const d = asObj(item);
    const id = String(d.id ?? '').trim().slice(0, 40);
    const name = String(d.name ?? '').trim().slice(0, 40);
    const color = String(d.color ?? '').trim();
    if (!id || !name) throw new Error('Every marker needs an id and a name');
    if (!HEX.test(color)) throw new Error(`Marker "${name}" needs a colour like #FF5722`);
    if (ids.has(id)) throw new Error(`Duplicate marker id ${id}`);
    ids.add(id);
    definitions.push({ id, name, color: color.toUpperCase() });
  }
  const assignments: Record<string, string> = {};
  const asg = asObj(raw.assignments);
  for (const [jobId, markerId] of Object.entries(asg)) {
    const j = String(jobId).trim().slice(0, 40);
    const m = String(markerId ?? '').trim();
    if (j && ids.has(m)) assignments[j] = m; // drop assignments to deleted markers
  }
  return { definitions, assignments };
}
