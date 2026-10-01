/**
 * ResourceTree — LYNQ-style left panel: production lines → machines.
 *  - Tick a line to show its Gantt lane (untick hides it).
 *  - Click a line name to filter the jobs grid to that line (click again to clear).
 *  - Machines show how many planned operations they carry.
 * Collapsible (toolbar "Lanes" button / ribbon VIEW → Resource tree); choices persist.
 */
import React, { useMemo, useState } from 'react';
import { ChevronDown, ChevronRight, X } from 'lucide-react';
import type { Resource, Schedule } from '../types';
import { useUiStore } from '../stores/uiStore';

interface Props {
  resources: Resource[];
  schedule: Schedule | null;
  selectedWorkcentre: string[];
  onSelectLine: (lines: string[]) => void;
}

export default function ResourceTree({ resources, schedule, selectedWorkcentre, onSelectLine }: Props) {
  const hiddenLanes = useUiStore((s) => s.hiddenLanes);
  const setHiddenLanes = useUiStore((s) => s.setHiddenLanes);
  const setShowResourceTree = useUiStore((s) => s.setShowResourceTree);
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});

  const lines = useMemo(() => {
    const byLine = new Map<string, Resource[]>();
    for (const r of resources) {
      const wc = String((r as any).worcentreId ?? (r as any).workcentreId ?? '').trim();
      if (!wc) continue;
      (byLine.get(wc) ?? byLine.set(wc, []).get(wc)!).push(r);
    }
    return Array.from(byLine.entries()).sort(([a], [b]) => a.localeCompare(b));
  }, [resources]);

  const opCounts = useMemo(() => {
    const line = new Map<string, number>();
    const machine = new Map<string, number>();
    for (const js of schedule?.jobSchedules ?? []) {
      for (const os of js.operationSchedules ?? []) {
        line.set(os.workcentreId, (line.get(os.workcentreId) ?? 0) + 1);
        if (os.resourceId) machine.set(os.resourceId, (machine.get(os.resourceId) ?? 0) + 1);
      }
    }
    return { line, machine };
  }, [schedule]);

  const toggleLane = (wc: string) =>
    setHiddenLanes(hiddenLanes.includes(wc) ? hiddenLanes.filter((x) => x !== wc) : [...hiddenLanes, wc]);
  const selectLine = (wc: string) =>
    onSelectLine(selectedWorkcentre.length === 1 && selectedWorkcentre[0] === wc ? [] : [wc]);

  return (
    <aside className="aps-tree-panel resource-tree" aria-label="Resources">
      <div className="rt-head">
        <strong>Resources</strong>
        <span className="rt-actions">
          <button className="rt-link" onClick={() => setHiddenLanes([])} disabled={!hiddenLanes.length}>All</button>
          <button className="rt-link" onClick={() => setHiddenLanes(lines.map(([wc]) => wc))}>None</button>
          <button className="rt-icon" onClick={() => setShowResourceTree(false)} aria-label="Close resource tree" title="Close">
            <X size={14} aria-hidden="true" />
          </button>
        </span>
      </div>
      <div className="rt-hint">Tick a line to show its lane · click a name to filter the jobs</div>
      <ul className="rt-list" role="tree">
        {lines.map(([wc, machines]) => {
          const shown = !hiddenLanes.includes(wc);
          const open = !collapsed[wc];
          const selected = selectedWorkcentre.includes(wc);
          return (
            <li key={wc} role="treeitem" aria-expanded={open} aria-selected={selected}>
              <div className={`rt-row rt-line ${selected ? 'is-selected' : ''}`}>
                <button className="rt-caret" onClick={() => setCollapsed((c) => ({ ...c, [wc]: open }))}
                  aria-label={open ? `Collapse ${wc}` : `Expand ${wc}`}>
                  {open ? <ChevronDown size={14} aria-hidden="true" /> : <ChevronRight size={14} aria-hidden="true" />}
                </button>
                <input type="checkbox" checked={shown} onChange={() => toggleLane(wc)} aria-label={`Show ${wc} lane`} />
                <button className="rt-name" onClick={() => selectLine(wc)} title={selected ? 'Clear the job filter' : `Show only jobs on ${wc}`}>
                  {wc}
                </button>
                <span className="rt-count" title="Planned operations">{opCounts.line.get(wc) ?? 0}</span>
              </div>
              {open && (
                <ul role="group" className="rt-children">
                  {machines.map((m) => (
                    <li key={m.resourceId} role="treeitem" className="rt-row rt-machine">
                      <span className="rt-machine-name" title={(m as any).resourceName || m.resourceId}>{m.resourceId}</span>
                      <span className="rt-count" title="Planned operations">{opCounts.machine.get(m.resourceId) ?? 0}</span>
                    </li>
                  ))}
                </ul>
              )}
            </li>
          );
        })}
      </ul>
      {selectedWorkcentre.length > 0 && (
        <button className="rt-clear" onClick={() => onSelectLine([])}>Clear job filter ({selectedWorkcentre.join(', ')})</button>
      )}
    </aside>
  );
}
