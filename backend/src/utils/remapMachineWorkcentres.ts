/**
 * Older SYSPRO routings (e.g. 2019 MRP suggestions) carry the MACHINE code in
 * WorkCentre (NMILL) with no IMachine, while live jobs route to the line
 * (LINE1) with the machine in IMachine. When an operation's work centre is not
 * a known work centre but is a machine on one, move it to that line and keep
 * the machine — otherwise it can never be placed on the board.
 */
export function remapMachineWorkcentres(
  jobs: Array<{ operations?: Array<{
    workcentreId?: string; routedWorkcentreId?: string; qualifiedResourceIds?: string[];
    assignedResourceId?: string; IMachine?: string;
  }> }>,
  workcentreIds: Iterable<string>,
  resources: Array<{ resourceId: string; worcentreId?: string; workcentreId?: string }>,
): number {
  const known = new Set(Array.from(workcentreIds, (w) => String(w).trim()));
  const lineOf = new Map<string, string>();
  for (const r of resources) {
    const line = String(r.worcentreId ?? r.workcentreId ?? '').trim();
    if (line && known.has(line)) lineOf.set(String(r.resourceId).trim(), line);
  }
  let moved = 0;
  for (const job of jobs) {
    for (const op of job.operations || []) {
      const wc = String(op.workcentreId ?? '').trim();
      if (!wc || known.has(wc)) continue;
      const line = lineOf.get(wc);
      if (!line) continue;
      op.routedWorkcentreId = wc;
      op.workcentreId = line;
      op.qualifiedResourceIds = [wc];
      op.assignedResourceId = wc;
      op.IMachine = op.IMachine || wc;
      moved++;
    }
  }
  return moved;
}
