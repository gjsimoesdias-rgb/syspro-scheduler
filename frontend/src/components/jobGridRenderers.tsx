/**
 * Jobs-grid cell renderers (status flags, schedule/material badges, the
 * operations sub-table). Moved verbatim from App.tsx (App.tsx split, slice 3).
 */
import React from 'react';
import { Lock, Unlock } from 'lucide-react';
import type { Job, Operation } from '../types';
import type { JobColumnDef } from '../hooks/useColumnManager';
import { useMarkerStore } from '../stores/markerStore';
import type { JobFmad } from '../services/api';
import { fmadText } from '../utils/fmad';
import type { JobScheduleStatus, Lateness, ScheduleShortfall } from '../utils/scheduleDiagnostics';

export interface JobGridRenderContext {
  allOperationColumns: JobColumnDef[];
  formatJobColumnValue: (job: Job, key: string) => string;
  formatOperationColumnValue: (op: Operation, key: string) => string;
  getJobMaterialStatus: (job: Job) => 'Materials' | 'Partial' | 'No Materials';
  getJobScheduleStatus: (job: Job) => JobScheduleStatus;
  handleTogglePin: (jobId: string, opId: string) => Promise<void>;
  jobLatenessMap: Map<string, Lateness>;
  lateWhyByJob: Map<string, string>;
  pinnedOps: Set<string>;
  /** Jobs pinned / excluded as a whole (right-click → Pin job / Exclude from planning). */
  pinnedJobIds?: Set<string>;
  excludedJobIds?: Set<string>;
  publishByJob: Map<string, string>;
  /** First material availability per job (FMAD column); undefined while loading. */
  fmadByJob?: Record<string, JobFmad>;
  /** Sub-jobs (all levels) under each master job. */
  dependentsByJob: Map<string, number>;
  scheduleOpRef: React.MutableRefObject<((job: Job, opId: string) => Promise<void>) | null>;
  scheduleShortfall: ScheduleShortfall | null;
  setBomJobId: React.Dispatch<React.SetStateAction<string | null>>;
  setShowOperationColumnPicker: React.Dispatch<React.SetStateAction<boolean>>;
  showOperationColumnPicker: boolean;
  toggleOperationColumn: (key: string) => void;
  visibleOperationColumns: string[];
}

export function useJobGridRenderers(ctx: JobGridRenderContext) {
  const {
    allOperationColumns,
    formatJobColumnValue,
    formatOperationColumnValue,
    getJobMaterialStatus,
    getJobScheduleStatus,
    handleTogglePin,
    jobLatenessMap,
    lateWhyByJob,
    pinnedOps,
    pinnedJobIds,
    excludedJobIds,
    publishByJob,
    fmadByJob,
    dependentsByJob,
    scheduleOpRef,
    scheduleShortfall,
    setBomJobId,
    setShowOperationColumnPicker,
    showOperationColumnPicker,
    toggleOperationColumn,
    visibleOperationColumns,
  } = ctx;
  const markerDefs = useMarkerStore((s) => s.definitions);
  const markerAssignments = useMarkerStore((s) => s.assignments);

  const renderJobCellContent = (job: Job, column: JobColumnDef): React.ReactNode => {
    if (column.key === 'validForScheduling') {
      const reason = !job.operations?.length
        ? 'No operations in SYSPRO'
        : String((job as any).HoldFlag ?? '').toUpperCase() === 'Y' || job.status === 'OnHold'
        ? 'Job is on hold'
        : job.operations.every((o) => o.status === 'Complete')
        ? 'All operations complete'
        : null;
      if (!reason && (job as any).isSuggested) {
        return <span className="grid-flag grid-flag-info" title="SYSPRO MRP suggested job — scheduled as planned work">✓ MRP</span>;
      }
      return reason
        ? <span className="grid-flag grid-flag-bad" title={reason}>✕ {reason}</span>
        : <span className="grid-flag grid-flag-ok" title="Can be scheduled">✓</span>;
    }

    if (column.key === 'lateness') {
      const state = jobLatenessMap.get(job.jobId);
      const due = job.dueDate ? new Date(job.dueDate) : null;
      const pastDue = due && !Number.isNaN(due.getTime()) && due.getTime() < Date.now();
      if (state === 'late') {
        const why = lateWhyByJob.get(job.jobId);
        return <span className="grid-flag grid-flag-bad" title={why || 'Planned to finish after the due date'}>Late{why ? ' ⓘ' : ''}</span>;
      }
      if (state === 'at-risk') return <span className="grid-flag grid-flag-warn" title="Finishes less than 8 h before the due date">At risk</span>;
      if (!state && pastDue) return <span className="grid-flag grid-flag-bad" title="Due date has passed and the job is not scheduled">Past due</span>;
      return state ? <span className="grid-flag grid-flag-ok">On time</span> : <span className="grid-flag">—</span>;
    }

    if (column.key === 'marker') {
      const id = markerAssignments[job.jobId];
      const def = id ? markerDefs.find((d) => d.id === id) : undefined;
      return def
        ? <span className="marker-chip" style={{ ['--mk' as any]: def.color }} title={`Marker: ${def.name} (right-click the job to change)`}>{def.name}</span>
        : <span className="grid-flag">—</span>;
    }

    if (column.key === 'fmad') {
      const f = fmadByJob?.[job.jobId];
      if (!fmadByJob) return <span className="grid-flag" title="Loading material availability…">…</span>;
      if (!f) return <span className="grid-flag">—</span>;
      const { label, tip, cls } = fmadText(f, job.dueDate);
      return <span className={`grid-flag ${cls}`} title={tip}>{label}</span>;
    }

    if (column.key === 'dependents') {
      const n = dependentsByJob.get(job.jobId) || 0;
      return n ? <span className="grid-flag" title={`${n} sub-job(s) must finish before this master job`}>{n}</span> : <span className="grid-flag">—</span>;
    }

    if (column.key === 'lockedOps') {
      if (excludedJobIds?.has(job.jobId)) {
        return <span className="grid-flag grid-flag-warn" title="Excluded from planning — right-click → Include in planning">Excluded</span>;
      }
      if (pinnedJobIds?.has(job.jobId)) {
        return <span className="grid-flag" title="Whole job pinned — keeps its master-plan machine and times on Generate"><Lock size={13} className="ui-icon" aria-hidden="true" /> Job</span>;
      }
      const n = (job.operations || []).filter((o) => pinnedOps.has(`${job.jobId}::${o.opId}`)).length;
      return n ? <span className="grid-flag" title={`${n} operation(s) locked in place`}><Lock size={13} className="ui-icon" aria-hidden="true" /> {n}</span> : <span className="grid-flag">—</span>;
    }

    if (column.key === 'publishState') {
      if ((job as any).isSuggested) {
        return <span className="grid-flag grid-flag-info" title={`SYSPRO MRP suggested job ${(job as any).suggestedJob || ''} — planned only; create the job in SYSPRO to send dates`}>MRP suggestion</span>;
      }
      const st = publishByJob.get(String(job.jobId).trim());
      const cls = st === 'Published' ? 'grid-flag-ok' : st === 'Error' ? 'grid-flag-bad' : st === 'Pending' ? 'grid-flag-warn' : '';
      const tip = st === 'Published' ? 'SYSPRO has these dates' : st === 'Pending' ? 'Changed since the last Send to SYSPRO' : st === 'Error' ? 'Last send failed on this job' : 'Not in the master plan';
      return <span className={`grid-flag ${cls}`} title={tip}>{st ?? '—'}</span>;
    }

    if (column.key === 'scheduleStatus') {
      const sts = getJobScheduleStatus(job);
      const labelMap: Record<string, string> = {
        scheduled: 'Scheduled',
        partial: 'Partially Scheduled',
        'not-scheduled': 'Not Scheduled'
      };
      const classMap: Record<string, string> = {
        scheduled: 'scheduled',
        partial: 'partial-scheduled',
        'not-scheduled': 'not-scheduled'
      };
      // A job with no operations in SYSPRO (no WipJobAllLab lines) can never be
      // scheduled; say so rather than a bare "Not Scheduled".
      if ((job.operations?.length ?? 0) === 0) {
        return (
          <span className="schedule-status not-scheduled" title="This job has no operations in SYSPRO (WipJobAllLab), so there is nothing to schedule. Add a routing to the job in SYSPRO.">
            No routing ⓘ
          </span>
        );
      }
      const reasonTip = sts !== 'scheduled' ? scheduleShortfall?.tipByJob.get(job.jobId) : undefined;
      return (
        <span className={`schedule-status ${classMap[sts]}`} title={reasonTip}>
          {labelMap[sts]}{reasonTip ? ' ⓘ' : ''}
        </span>
      );
    }

    if (column.key === 'materialStatus') {
      const status = getJobMaterialStatus(job);
      const classMap: Record<string, string> = {
        'Materials': 'materials-ok',
        'Partial': 'materials-partial',
        'No Materials': 'materials-none'
      };
      return (
        <span
          className={`schedule-status ${classMap[status]} materials-cell-clickable`}
          role="button"
          tabIndex={0}
          title="View material breakdown"
          onClick={(e) => { e.stopPropagation(); setBomJobId(job.jobId); }}
          onKeyDown={(e) => { if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setBomJobId(job.jobId); } }}
        >{status}</span>
      );
    }

    if (column.key === 'status') {
      return (
        <span className={`job-status ${String(job.status).toLowerCase() === 'n' ? 'open' : 'closed'}`}>
          {String(job.status)}
        </span>
      );
    }

    return formatJobColumnValue(job, column.key);
  };

  const renderOperationsTable = (job: Job) => (
    <div className="ops-wrap">
      <div className="ops-header">
        <strong>Operations</strong>
        <button className="job-filter-select" onClick={() => setShowOperationColumnPicker((s) => !s)}>
          Columns ({visibleOperationColumns.length}/{allOperationColumns.length})
        </button>
      </div>
      {showOperationColumnPicker && (
        <div className="column-picker-panel ops-column-picker-panel">
          {allOperationColumns.map((column) => (
            <label key={column.key} className="column-picker-item">
              <input
                type="checkbox"
                checked={visibleOperationColumns.includes(column.key)}
                onChange={() => toggleOperationColumn(column.key)}
              />
              <span>{column.label}</span>
            </label>
          ))}
        </div>
      )}
      {job.operations.length === 0 ? (
        <div className="ops-empty">No operations available</div>
      ) : (
        <table className="ops-table">
          <thead>
            <tr>
              <th title="Pin/lock operation on Gantt">Pin</th>
              {allOperationColumns
                .filter((column) => visibleOperationColumns.includes(column.key))
                .map((column) => (
                  <th key={column.key}>{column.label}</th>
                ))}
            </tr>
          </thead>
          <tbody>
            {job.operations
              .slice()
              .sort((a, b) => a.sequence - b.sequence)
              .map((op) => {
                const opKey = `${job.jobId}::${op.opId}`;
                const isPinned = pinnedOps.has(opKey);
                return (
                  <tr key={`${job.jobId}-${op.opId}`}>
                    <td style={{ whiteSpace: 'nowrap' }}>
                      <button
                        className={`op-lock-btn${isPinned ? ' active' : ''}`}
                        onClick={() => handleTogglePin(job.jobId, op.opId)}
                        title={isPinned ? 'Unpin operation' : 'Pin operation (locks on Gantt)'}
                        aria-pressed={isPinned}
                        style={{ fontSize: 14, lineHeight: 1 }}
                      >
                        {isPinned ? <Lock size={13} aria-hidden="true" /> : <Unlock size={13} aria-hidden="true" />}
                      </button>
                      {' '}
                      <button
                        className="btn btn-sm"
                        style={{ padding: '1px 6px', fontSize: 11 }}
                        title={`Schedule operation ${op.opId} on the board`}
                        onClick={() => scheduleOpRef.current?.(job, String(op.opId))}
                      >▶</button>
                    </td>
                    {allOperationColumns
                      .filter((column) => visibleOperationColumns.includes(column.key))
                      .map((column) => (
                        <td key={`${job.jobId}-${op.opId}-${column.key}`}>
                          {formatOperationColumnValue(op, column.key)}
                        </td>
                      ))}
                  </tr>
                );
              })}
          </tbody>
        </table>
      )}
    </div>
  );

  return { renderJobCellContent, renderOperationsTable };
}
