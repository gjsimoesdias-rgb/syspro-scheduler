/**
 * Left-hand jobs panel: Production / Master jobs grid with filters, column
 * picker and paging, plus the Manage views (resources, work centres,
 * shifts, alternatives, intervals, bulk import). Moved verbatim from App.tsx
 * (App.tsx split, slice 5); App owns the state and passes it in.
 */
import React, { Suspense, lazy } from 'react';
import toast from 'react-hot-toast';
import type { Job } from '../types';
import type { JobColumnDef } from '../hooks/useColumnManager';
import type { AlternativeGroup, DbStatus, NewAlternativeGroup } from '../hooks/useJobsData';
import type { JobPaneMode, ManageTab, WorkflowJobFilter } from '../stores/uiStore';
import type { Lateness, ScheduleShortfall } from '../utils/scheduleDiagnostics';
import CrewsPanel from './CrewsPanel';
import MarkersPanel from './MarkersPanel';
import { useMarkerStore } from '../stores/markerStore';
import { AlertTriangle } from 'lucide-react';

const ResourceDefinitionTab = lazy(() => import('./ResourceDefinitionTab'));
const ShiftManagementTab = lazy(() => import('./ShiftManagementTab'));

const JOB_PAGE_SIZE = 120;

const MANAGE_TITLES: Partial<Record<ManageTab, string>> = {
  workcenters: 'Work centres', machines: 'Machines', shifts: 'Shifts', crews: 'Crews', markers: 'Markers', alternatives: 'Alternatives',
  constraints: 'Constraints', import: 'Bulk import', mapping: 'Field mapping', interval: 'Planning interval',
};

export interface JobsPanelProps {
  WORKCENTRE_PAGE_SIZE: number;
  allJobColumns: JobColumnDef[];
  allWorkcentreIds: string[];
  alternativeGroups: AlternativeGroup[];
  boardIntervalEnd: string;
  boardIntervalStart: string;
  columnProfileName: string;
  dbStatus: DbStatus;
  draftIntervalEnd: string;
  draftIntervalStart: string;
  expandedJobs: Record<string, boolean>;
  exportJobsGrid: () => void;
  filteredJobs: Job[];
  formatJobColumnValue: (job: Job, key: string) => string;
  handleBulkImport: (event: React.ChangeEvent<HTMLInputElement>, importType: "operations" | "jobs") => Promise<void>;
  handleColDragStart: (key: string) => void;
  handleColDrop: (targetKey: string) => void;
  handleJobRowClick: (jobId: string) => void;
  highlightJobId: string | null;
  importing: boolean;
  jobImportRef: React.MutableRefObject<HTMLInputElement | null>;
  jobLatenessMap: Map<string, Lateness>;
  jobPage: number;
  jobPaneMode: JobPaneMode;
  /** MRP Jobs tab: whether suggested jobs are planned, how many, and the toggle. */
  mrpIncluded: boolean;
  mrpJobCount: number;
  mrpBusy: boolean;
  onToggleMrpPlanning: () => void;
  jobSearch: string;
  jobStatusFilter: string;
  jobWcFilter: string;
  loadJobsAndResources: () => Promise<void>;
  loadWorkcentreDetails: () => Promise<void>;
  loading: boolean;
  machineOptionsByWorkcentre: Record<string, string[]>;
  manageTab: ManageTab;
  setManageTab: (v: ManageTab) => void;
  masterJobGroups: { master: Job; subJobs: Job[]; }[];
  masterJobPage: number;
  materialStatusByJob: Record<string, "Materials" | "Partial" | "No Materials">;
  newAlternativeGroup: NewAlternativeGroup;
  openJobContextMenu: (e: React.MouseEvent<Element, MouseEvent>, jobId: string) => void;
  openScheduleSetup: (preselect?: string[] | undefined) => void;
  opsImportRef: React.MutableRefObject<HTMLInputElement | null>;
  orderedVisibleColumns: JobColumnDef[];
  profileSaving: boolean;
  removeAlternativeGroup: (groupId: string) => Promise<void>;
  renderJobCellContent: (job: Job, column: JobColumnDef) => React.ReactNode;
  renderOperationsTable: (job: Job) => React.ReactElement;
  saveAlternativeGroup: () => Promise<void>;
  saveColumnProfile: () => Promise<void>;
  scheduleFilter: string;
  scheduleShortfall: ScheduleShortfall | null;
  selectedWorkcentre: string[];
  setBoardIntervalEnd: (v: string) => void;
  setBoardIntervalStart: (v: string) => void;
  setColumnProfileName: React.Dispatch<React.SetStateAction<string>>;
  setDebouncedJobSearch: React.Dispatch<React.SetStateAction<string>>;
  setDraftIntervalEnd: (v: string) => void;
  setDraftIntervalStart: (v: string) => void;
  setHighlightJobId: (id: string | null) => void;
  setJobPage: React.Dispatch<React.SetStateAction<number>>;
  setJobPaneMode: (v: JobPaneMode) => void;
  setJobSearch: (v: string) => void;
  setJobStatusFilter: (v: string) => void;
  setJobWcFilter: (v: string) => void;
  setMasterJobPage: React.Dispatch<React.SetStateAction<number>>;
  setNewAlternativeGroup: React.Dispatch<React.SetStateAction<NewAlternativeGroup>>;
  setScheduleFilter: (v: string) => void;
  setSelectedWorkcentre: React.Dispatch<React.SetStateAction<string[]>>;
  setShowColumnPicker: React.Dispatch<React.SetStateAction<boolean>>;
  setWorkcentrePage: React.Dispatch<React.SetStateAction<number>>;
  setWorkflowJobFilter: (v: WorkflowJobFilter) => void;
  showColumnPicker: boolean;
  toggleJobColumn: (key: string) => void;
  toggleJobExpanded: (jobId: string) => void;
  visibleJobColumns: string[];
  visibleJobSource: Job[];
  workcentreColumns: string[];
  workcentrePage: number;
  workcentreRows: Record<string, unknown>[];
  workflowJobFilter: WorkflowJobFilter;
}

const JobsPanel: React.FC<JobsPanelProps> = ({
  WORKCENTRE_PAGE_SIZE,
  allJobColumns,
  allWorkcentreIds,
  alternativeGroups,
  boardIntervalEnd,
  boardIntervalStart,
  columnProfileName,
  dbStatus,
  draftIntervalEnd,
  draftIntervalStart,
  expandedJobs,
  exportJobsGrid,
  filteredJobs,
  formatJobColumnValue,
  handleBulkImport,
  handleColDragStart,
  handleColDrop,
  handleJobRowClick,
  highlightJobId,
  importing,
  jobImportRef,
  jobLatenessMap,
  jobPage,
  jobPaneMode,
  mrpIncluded,
  mrpJobCount,
  mrpBusy,
  onToggleMrpPlanning,
  jobSearch,
  jobStatusFilter,
  jobWcFilter,
  loadJobsAndResources,
  loadWorkcentreDetails,
  loading,
  machineOptionsByWorkcentre,
  manageTab,
  setManageTab,
  masterJobGroups,
  masterJobPage,
  materialStatusByJob,
  newAlternativeGroup,
  openJobContextMenu,
  openScheduleSetup,
  opsImportRef,
  orderedVisibleColumns,
  profileSaving,
  removeAlternativeGroup,
  renderJobCellContent,
  renderOperationsTable,
  saveAlternativeGroup,
  saveColumnProfile,
  scheduleFilter,
  scheduleShortfall,
  selectedWorkcentre,
  setBoardIntervalEnd,
  setBoardIntervalStart,
  setColumnProfileName,
  setDebouncedJobSearch,
  setDraftIntervalEnd,
  setDraftIntervalStart,
  setHighlightJobId,
  setJobPage,
  setJobPaneMode,
  setJobSearch,
  setJobStatusFilter,
  setJobWcFilter,
  setMasterJobPage,
  setNewAlternativeGroup,
  setScheduleFilter,
  setSelectedWorkcentre,
  setShowColumnPicker,
  setWorkcentrePage,
  setWorkflowJobFilter,
  showColumnPicker,
  toggleJobColumn,
  toggleJobExpanded,
  visibleJobColumns,
  visibleJobSource,
  workcentreColumns,
  workcentrePage,
  workcentreRows,
  workflowJobFilter,
}) => {
  const markerDefs = useMarkerStore((s) => s.definitions);
  const markerFilter = useMarkerStore((s) => s.filter);
  const setMarkerFilter = useMarkerStore((s) => s.setFilter);
  /**
   * Keyboard access for grid rows: Enter/Space = select (as a click),
   * Up/Down = previous/next row, Right/Left = expand/collapse operations,
   * Shift+F10 or the Menu key = the row's context menu.
   */
  const rowKeyDown = (e: React.KeyboardEvent<HTMLTableRowElement>, jobId: string, expanded?: boolean) => {
    const row = e.currentTarget;
    const move = (dir: 1 | -1) => {
      const rows = Array.from(row.closest('tbody')?.querySelectorAll<HTMLTableRowElement>('tr[data-job-row]') ?? []);
      rows[rows.indexOf(row) + dir]?.focus();
    };
    if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); handleJobRowClick(jobId); }
    else if (e.key === 'ArrowDown') { e.preventDefault(); move(1); }
    else if (e.key === 'ArrowUp') { e.preventDefault(); move(-1); }
    else if (e.key === 'ArrowRight' && expanded === false) { e.preventDefault(); toggleJobExpanded(jobId); }
    else if (e.key === 'ArrowLeft' && expanded === true) { e.preventDefault(); toggleJobExpanded(jobId); }
    else if (e.key === 'ContextMenu' || (e.key === 'F10' && e.shiftKey)) {
      const r = row.getBoundingClientRect();
      openJobContextMenu({ preventDefault: () => e.preventDefault(), clientX: r.left + 40, clientY: r.bottom } as any, jobId);
    }
  };
  return (
  <>
    <section className="aps-grid-panel">
      {manageTab !== 'none' && (
        <div className="manage-back-bar">
          <button type="button" className="btn btn-sm" onClick={() => setManageTab('none')}>
            &lsaquo; Back to jobs
          </button>
          <span className="manage-back-title">{MANAGE_TITLES[manageTab] ?? manageTab}</span>
        </div>
      )}
      {manageTab === 'none' ? (
        <>
          <div className="jobs-view-tabs">
            <button className={`feature-tab ${jobPaneMode === 'production' ? 'active' : ''}`} onClick={() => setJobPaneMode('production')}>
              Production Jobs
            </button>
            <button className={`feature-tab ${jobPaneMode === 'master' ? 'active' : ''}`} onClick={() => setJobPaneMode('master')}>
              Master Jobs
            </button>
            <button className={`feature-tab ${jobPaneMode === 'mrp' ? 'active' : ''}`} onClick={() => setJobPaneMode('mrp')}
              title="SYSPRO MRP suggested jobs">
              MRP Jobs{mrpJobCount ? ` (${mrpJobCount})` : ''}
            </button>
            <button
              className="btn btn-primary"
              style={{ marginLeft: 'auto' }}
              onClick={() => openScheduleSetup()}
              disabled={loading || !dbStatus.sysproConnected}
            >
              {loading ? 'Generating...' : '▶ Generate Schedule'}
            </button>
          </div>
          <div className="aps-panel-title aps-panel-title-searchbar">
            <span>
              {jobPaneMode === 'production' ? 'Production Jobs' : jobPaneMode === 'mrp' ? 'MRP Suggested Jobs' : 'Master Jobs'} {selectedWorkcentre.length ? `(Filter: ${selectedWorkcentre.length === 1 ? selectedWorkcentre[0] : `${selectedWorkcentre.length} selected`})` : ''}
            </span>
            <div className="job-filter-bar">
              <input
                className="job-search-input"
                type="text"
                placeholder="Search job / item / desc…"
                value={jobSearch}
                onChange={(e) => setJobSearch(e.target.value)}
              />
              <select className="job-filter-select" value={jobStatusFilter} onChange={(e) => setJobStatusFilter(e.target.value)}>
                <option value="all">All Status</option>
                <option value="released">Released</option>
                <option value="firm">Firm</option>
                <option value="planned">Planned</option>
                <option value="inprogress">In Progress</option>
                <option value="n">Open</option>
              </select>
              <select className="job-filter-select" value={jobWcFilter} onChange={(e) => setJobWcFilter(e.target.value)}>
                <option value="all">All WC</option>
                {allWorkcentreIds.map((wc) => (
                  <option key={wc} value={wc}>{wc}</option>
                ))}
              </select>
              <select className="job-filter-select" value={scheduleFilter} onChange={(e) => setScheduleFilter(e.target.value)}>
                <option value="all">All Schedule</option>
                <option value="scheduled">Scheduled</option>
                <option value="partial">Partially Scheduled</option>
                <option value="not-scheduled">Not Scheduled</option>
              </select>
              {markerDefs.length > 0 && (
                <select className="job-filter-select" value={markerFilter} onChange={(e) => setMarkerFilter(e.target.value)} aria-label="Filter by marker">
                  <option value="">All markers</option>
                  {markerDefs.map((d) => <option key={d.id} value={d.id}>{d.name}</option>)}
                  <option value="__none">No marker</option>
                </select>
              )}
              {(jobSearch || jobStatusFilter !== 'all' || jobWcFilter !== 'all' || scheduleFilter !== 'all' || workflowJobFilter !== 'all' || markerFilter) && (
                <button className="job-filter-clear" onClick={() => { setJobSearch(''); setDebouncedJobSearch(''); setJobStatusFilter('all'); setJobWcFilter('all'); setScheduleFilter('all'); setWorkflowJobFilter('all'); setMarkerFilter(''); }}>✕</button>
              )}
              <button className="job-filter-select" onClick={() => setShowColumnPicker((s) => !s)}>
                Columns ({visibleJobColumns.length}/{allJobColumns.length})
              </button>
              <button className="job-filter-select" onClick={exportJobsGrid} title="Export the visible columns of the filtered jobs to Excel (CSV)">
                Export
              </button>
              <span className="job-count-badge">
                {jobPaneMode !== 'master'
                  ? `${filteredJobs.length} jobs`
                  : `${masterJobGroups.length} master jobs`}
              </span>
            </div>
          </div>
          {jobPaneMode === 'mrp' && (
            <div className={`mrp-banner ${mrpIncluded ? 'on' : ''}`} role="status">
              <span style={{ flex: 1 }}>
                {mrpIncluded
                  ? <>These SYSPRO MRP suggestions are <strong>planned</strong> with the production jobs — they take line capacity and materials, and supply sales orders. They are never sent to SYSPRO; create the job in SYSPRO to release one.</>
                  : <>SYSPRO MRP suggestions, <strong>not planned</strong>. Include them to schedule them with the production jobs (capacity, materials and sales orders). They are never sent to SYSPRO.</>}
              </span>
              {(() => {
                // Every suggestion due over a month ago → MRP has not been run lately.
                const dues = filteredJobs.map((j) => new Date(j.dueDate).getTime()).filter(Number.isFinite);
                const latest = dues.length ? Math.max(...dues) : NaN;
                return Number.isFinite(latest) && latest < Date.now() - 30 * 86400000 ? (
                  <span className="grid-flag grid-flag-warn" title="The newest suggestion is due more than a month ago — run Requirements Calculation in SYSPRO to refresh them">
                    <AlertTriangle size={13} className="ui-icon" aria-hidden="true" /> Stale: newest due {new Date(latest).toLocaleDateString()}
                  </span>
                ) : null;
              })()}
              <button className={`btn btn-sm ${mrpIncluded ? '' : 'btn-primary'}`} onClick={onToggleMrpPlanning} disabled={mrpBusy}>
                {mrpBusy ? 'Saving…' : mrpIncluded ? 'Stop planning them' : 'Include in planning'}
              </button>
            </div>
          )}
          {jobPaneMode === 'production' && scheduleShortfall && scheduleShortfall.jobCount > 0 && (
            <div
              role="status"
              style={{
                display: 'flex',
                alignItems: 'center',
                gap: '8px',
                padding: '6px 12px',
                background: 'rgba(245, 158, 11, 0.12)',
                borderTop: '1px solid rgba(245, 158, 11, 0.35)',
                borderBottom: '1px solid rgba(245, 158, 11, 0.35)',
                fontSize: '12px',
                lineHeight: 1.4,
              }}
            >
              <span aria-hidden="true" style={{ fontSize: '14px' }}><AlertTriangle size={13} className="ui-icon" aria-hidden="true" /> </span>
              <span style={{ flex: 1 }}>
                <strong>{scheduleShortfall.jobCount}</strong> job{scheduleShortfall.jobCount === 1 ? '' : 's'} couldn&apos;t be fully scheduled in this window
                {' '}({scheduleShortfall.opCount} operation{scheduleShortfall.opCount === 1 ? '' : 's'} dropped).
                {scheduleShortfall.topWc.length > 0 && (
                  <>
                    {' '}Bottleneck{scheduleShortfall.topWc.length === 1 ? '' : 's'}:
                    {scheduleShortfall.topWc.slice(0, 3).map(([wc, n], i) => (
                      <span key={wc}>{i > 0 ? ', ' : ' '}<strong>{wc}</strong> ({n})</span>
                    ))}
                    {scheduleShortfall.topWc.length > 3 ? ', …' : ''}
                  </>
                )}
                {' '}Hover a “Not/Partially Scheduled” badge for the per-job reason.
              </span>
              <button
                className="btn btn-sm"
                onClick={() => setScheduleFilter(scheduleFilter === 'not-scheduled' ? 'all' : 'not-scheduled')}
                title="Filter the list to jobs that weren't scheduled"
              >
                {scheduleFilter === 'not-scheduled' ? 'Show all' : 'Show unscheduled'}
              </button>
            </div>
          )}
          {showColumnPicker && (
            <div className="column-picker-panel">
              <div className="column-picker-header">
                <span className="column-picker-hint">Drag rows to reorder · check to show/hide</span>
                <div className="column-picker-profile-row">
                  <input
                    className="column-picker-profile-input"
                    placeholder="Profile name…"
                    value={columnProfileName}
                    onChange={(e) => setColumnProfileName(e.target.value)}
                    maxLength={80}
                  />
                  <button
                    className="btn btn-sm"
                    disabled={profileSaving}
                    onClick={saveColumnProfile}
                    title="Save column order + visibility as your profile"
                  >
                    {profileSaving ? '…' : 'Save Profile'}
                  </button>
                </div>
              </div>
              {/* Visible columns first (in current order), then hidden ones */}
              {[
                ...orderedVisibleColumns,
                ...allJobColumns.filter((c) => !visibleJobColumns.includes(c.key)),
              ].map((column) => {
                const isVisible = visibleJobColumns.includes(column.key);
                return (
                  <label
                    key={column.key}
                    className={`column-picker-item${isVisible ? '' : ' column-picker-hidden'}`}
                    draggable={isVisible}
                    onDragStart={() => handleColDragStart(column.key)}
                    onDragOver={(e) => { if (isVisible) e.preventDefault(); }}
                    onDrop={() => { if (isVisible) handleColDrop(column.key); }}
                  >
                    {isVisible && <span className="column-picker-drag-handle" title="Drag to reorder">⠿</span>}
                    <input
                      type="checkbox"
                      checked={isVisible}
                      onChange={() => toggleJobColumn(column.key)}
                    />
                    <span>{column.label}</span>
                  </label>
                );
              })}
            </div>
          )}
          <div className="aps-grid-wrapper">
            <table className="aps-grid">
              <thead>
                <tr>
                  <th></th>
                  {orderedVisibleColumns.map((column) => (
                    <th
                      key={column.key}
                      draggable
                      onDragStart={() => handleColDragStart(column.key)}
                      onDragOver={(e) => e.preventDefault()}
                      onDrop={() => handleColDrop(column.key)}
                      style={{ cursor: 'grab', userSelect: 'none' }}
                      title="Drag to reorder"
                    >
                      {column.label}
                    </th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {jobPaneMode !== 'master' ? (
                  <>
                    {filteredJobs.length === 0 && (
                      <tr>
                        <td colSpan={visibleJobColumns.length + 1} className="empty-grid-state">
                          {visibleJobSource.length > 0 ? 'No jobs match the current filters.' : 'No jobs loaded.'}
                          <button
                            className="job-filter-clear"
                            onClick={() => {
                              setSelectedWorkcentre([]);
                              setJobSearch('');
                              setDebouncedJobSearch('');
                              setJobStatusFilter('all');
                              setJobWcFilter('all');
                              setScheduleFilter('all');
                              loadJobsAndResources();
                            }}
                            style={{ marginLeft: 12 }}
                          >
                            Show Jobs
                          </button>
                        </td>
                      </tr>
                    )}
                    {filteredJobs.slice(0, (jobPage + 1) * JOB_PAGE_SIZE).map((job) => {
                      const lateness = jobLatenessMap.get(job.jobId) ?? 'unscheduled';
                      const latenessClass = lateness === 'late' ? 'row-late' : lateness === 'at-risk' ? 'row-at-risk' : lateness === 'on-time' ? 'row-on-time' : '';
                      return (
                      <React.Fragment key={job.jobId}>
                        <tr
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/job-id', job.jobId);
                            setHighlightJobId(job.jobId);
                          }}
                          onDragEnd={() => setHighlightJobId(null)}
                          onClick={() => handleJobRowClick(job.jobId)}
                          tabIndex={0}
                          data-job-row
                          aria-selected={highlightJobId === job.jobId}
                          onKeyDown={(e) => rowKeyDown(e, job.jobId, !!expandedJobs[job.jobId])}
                          onContextMenu={(e) => openJobContextMenu(e, job.jobId)}
                          className={`${highlightJobId === job.jobId ? 'job-row-highlighted' : ''} ${latenessClass}`}
                        >
                          <td>
                            <div style={{ display: 'flex', alignItems: 'center', gap: 4 }}>
                              {lateness !== 'unscheduled' && (
                                <span
                                  className={`lateness-dot lateness-dot-${lateness}`}
                                  title={lateness === 'late' ? 'Late' : lateness === 'at-risk' ? 'At Risk' : 'On Time'}
                                />
                              )}
                              {(materialStatusByJob[job.jobId] === 'No Materials' || materialStatusByJob[job.jobId] === 'Partial') && (
                                <span
                                  className={`shortage-dot shortage-dot--${materialStatusByJob[job.jobId] === 'No Materials' ? 'critical' : 'partial'}`}
                                  title={materialStatusByJob[job.jobId] === 'No Materials' ? 'Material shortage' : 'Partial material shortage'}
                                  aria-label={materialStatusByJob[job.jobId] === 'No Materials' ? 'Material shortage' : 'Partial material shortage'}
                                />
                              )}
                              <button className="expand-btn" tabIndex={-1} aria-label={expandedJobs[job.jobId] ? 'Hide operations' : 'Show operations'} onClick={(e) => { e.stopPropagation(); toggleJobExpanded(job.jobId); }}>
                                {expandedJobs[job.jobId] ? '▾' : '▸'}
                              </button>
                            </div>
                          </td>
                          {orderedVisibleColumns.map((column) => (
                              <td key={`${job.jobId}-${column.key}`}>
                                {renderJobCellContent(job, column)}
                              </td>
                            ))}
                        </tr>
                        {expandedJobs[job.jobId] && (
                          <tr className="ops-row">
                            <td colSpan={visibleJobColumns.length + 1}>
                              {renderOperationsTable(job)}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                      );
                    })}
                    {filteredJobs.length > (jobPage + 1) * JOB_PAGE_SIZE && (
                      <tr>
                        <td colSpan={visibleJobColumns.length + 1} style={{ textAlign: 'center', padding: '8px' }}>
                          <button className="btn btn-sm" onClick={() => setJobPage((p) => p + 1)}>
                            Show more ({filteredJobs.length - (jobPage + 1) * JOB_PAGE_SIZE} remaining)
                          </button>
                        </td>
                      </tr>
                    )}
                  </>
                ) : (
                  <>
                    {masterJobGroups.length === 0 && (
                      <tr>
                        <td colSpan={visibleJobColumns.length + 1} className="empty-grid-state">
                          No master jobs match the current filters.
                        </td>
                      </tr>
                    )}
                    {masterJobGroups.slice(0, (masterJobPage + 1) * JOB_PAGE_SIZE).map(({ master, subJobs }) => (
                      <React.Fragment key={`master-${master.jobId}`}>
                        <tr
                          draggable
                          onDragStart={(e) => {
                            e.dataTransfer.setData('text/job-id', master.jobId);
                            e.dataTransfer.effectAllowed = 'move';
                            setHighlightJobId(master.jobId);
                          }}
                          onDragEnd={() => setHighlightJobId(null)}
                          onClick={() => handleJobRowClick(master.jobId)}
                          tabIndex={0}
                          data-job-row
                          aria-selected={highlightJobId === master.jobId}
                          onKeyDown={(e) => rowKeyDown(e, master.jobId)}
                          onContextMenu={(e) => openJobContextMenu(e, master.jobId)}
                          className={`master-job-row ${highlightJobId === master.jobId ? 'job-row-highlighted' : ''}`}
                        >
                          <td style={{ whiteSpace: 'nowrap' }}>
                            <button className="expand-btn" onClick={(e) => { e.stopPropagation(); toggleJobExpanded(master.jobId); }}>
                              {expandedJobs[master.jobId] ? '▾' : '▸'}
                            </button>
                            <button
                              className="btn btn-sm"
                              style={{ padding: '1px 7px', fontSize: 11, marginLeft: 4 }}
                              title="Schedule this master job and all its sub-jobs"
                              onClick={(e) => {
                                e.stopPropagation();
                                const familyIds = [master.jobId, ...subJobs.map((j) => j.jobId)];
                                openScheduleSetup(familyIds);
                              }}
                            >
                              ▶ Schedule
                            </button>
                          </td>
                          {orderedVisibleColumns.map((column) => (
                              <td key={`${master.jobId}-${column.key}`}>
                                {column.key === 'description' ? (
                                  <div className="master-job-meta">
                                    <div>{formatJobColumnValue(master, column.key)}</div>
                                    <small>{subJobs.length} sub job{subJobs.length === 1 ? '' : 's'}</small>
                                  </div>
                                ) : (
                                  renderJobCellContent(master, column)
                                )}
                              </td>
                            ))}
                        </tr>
                        {expandedJobs[master.jobId] && (
                          <tr className="ops-row">
                            <td colSpan={visibleJobColumns.length + 1}>
                              {subJobs.length === 0 ? (
                                renderOperationsTable(master)
                              ) : (
                                <div className="ops-wrap">
                                  {master.operations && master.operations.length > 0 && (
                                    <div style={{ marginBottom: 8 }}>
                                      <div className="ops-header" style={{ marginBottom: 4 }}>
                                        <strong>Master Operations — {master.jobId}</strong>
                                      </div>
                                      {renderOperationsTable(master)}
                                    </div>
                                  )}
                                  <div className="ops-header">
                                    <strong>Sub Jobs for {master.jobId}</strong>
                                    <span className="job-count-badge">{subJobs.length} jobs</span>
                                  </div>
                                  <table className="ops-table">
                                    <thead>
                                      <tr>
                                        <th></th>
                                        {orderedVisibleColumns.map((column) => (
                                            <th key={`${master.jobId}-${column.key}`}>{column.label}</th>
                                          ))}
                                      </tr>
                                    </thead>
                                    <tbody>
                                      {subJobs.map((subJob) => (
                                        <React.Fragment key={`${master.jobId}-${subJob.jobId}`}>
                                          <tr
                                            draggable
                                            onDragStart={(e) => {
                                              e.dataTransfer.setData('text/job-id', subJob.jobId);
                                              e.dataTransfer.effectAllowed = 'move';
                                              setHighlightJobId(subJob.jobId);
                                            }}
                                            onDragEnd={() => setHighlightJobId(null)}
                                            onClick={() => handleJobRowClick(subJob.jobId)}
                          tabIndex={0}
                          data-job-row
                          aria-selected={highlightJobId === subJob.jobId}
                          onKeyDown={(e) => rowKeyDown(e, subJob.jobId, !!expandedJobs[subJob.jobId])}
                                            onContextMenu={(e) => openJobContextMenu(e, subJob.jobId)}
                                            className={highlightJobId === subJob.jobId ? 'job-row-highlighted' : ''}
                                          >
                                            <td style={{ whiteSpace: 'nowrap' }}>
                                              <button className="expand-btn" onClick={(e) => { e.stopPropagation(); toggleJobExpanded(subJob.jobId); }}>
                                                {expandedJobs[subJob.jobId] ? '▾' : '▸'}
                                              </button>
                                              <button
                                                className="btn btn-sm"
                                                style={{ padding: '1px 7px', fontSize: 11, marginLeft: 4 }}
                                                title="Schedule this sub-job"
                                                onClick={(e) => {
                                                  e.stopPropagation();
                                                  openScheduleSetup([subJob.jobId]);
                                                }}
                                              >
                                                ▶
                                              </button>
                                            </td>
                                            {orderedVisibleColumns.map((column) => (
                                                <td key={`${subJob.jobId}-${column.key}`}>
                                                  {renderJobCellContent(subJob, column)}
                                                </td>
                                              ))}
                                          </tr>
                                          {expandedJobs[subJob.jobId] && (
                                            <tr className="ops-row">
                                              <td colSpan={visibleJobColumns.length + 1}>
                                                {renderOperationsTable(subJob)}
                                              </td>
                                            </tr>
                                          )}
                                        </React.Fragment>
                                      ))}
                                    </tbody>
                                  </table>
                                </div>
                              )}
                            </td>
                          </tr>
                        )}
                      </React.Fragment>
                    ))}
                    {masterJobGroups.length > (masterJobPage + 1) * JOB_PAGE_SIZE && (
                      <tr>
                        <td colSpan={visibleJobColumns.length + 1} style={{ textAlign: 'center', padding: '8px' }}>
                          <button className="btn btn-sm" onClick={() => setMasterJobPage((p) => p + 1)}>
                            Show more ({masterJobGroups.length - (masterJobPage + 1) * JOB_PAGE_SIZE} remaining)
                          </button>
                        </td>
                      </tr>
                    )}
                  </>
                )}
              </tbody>
            </table>
          </div>
        </>
      ) : manageTab === 'machines' ? (
        <Suspense fallback={<div className="tab-loading-spinner" role="status">Loading…</div>}>
          <ResourceDefinitionTab onDefinitionsChanged={loadJobsAndResources} />
        </Suspense>
      ) : manageTab === 'workcenters' ? (
        <div className="tab-placeholder guide-panel">
          <div className="ops-header">
            <h3>Work Centers</h3>
            <button className="job-filter-select" onClick={loadWorkcentreDetails}>Refresh BomWorkCentres</button>
          </div>
          <p>All available columns from the BomWorkCentres or BomWorkCentre table are shown below.</p>
          <div className="aps-grid-wrapper">
            <table className="aps-grid">
              <thead>
                <tr>
                  {workcentreColumns.map((column) => (
                    <th key={column}>{column}</th>
                  ))}
                </tr>
              </thead>
              <tbody>
                {workcentreRows.length === 0 ? (
                  <tr>
                    <td colSpan={Math.max(1, workcentreColumns.length)} className="empty-grid-state">
                      No BomWorkCentres data returned for the current company.
                    </td>
                  </tr>
                ) : (
                  workcentreRows
                    .slice(workcentrePage * WORKCENTRE_PAGE_SIZE, (workcentrePage + 1) * WORKCENTRE_PAGE_SIZE)
                    .map((row, index) => (
                    <tr key={`wc-row-${workcentrePage * WORKCENTRE_PAGE_SIZE + index}`}>
                      {workcentreColumns.map((column) => (
                        <td key={`wc-${index}-${column}`}>{String(row[column] ?? '')}</td>
                      ))}
                    </tr>
                  ))
                )}
              </tbody>
            </table>
          </div>
          {workcentreRows.length > WORKCENTRE_PAGE_SIZE && (
            <div className="pagination-bar" style={{ display: 'flex', alignItems: 'center', gap: '0.5rem', marginTop: '0.75rem' }}>
              <button
                className="aps-btn aps-btn--secondary"
                disabled={workcentrePage === 0}
                onClick={() => setWorkcentrePage((p) => p - 1)}
              >
                ← Prev
              </button>
              <span style={{ fontSize: '0.85rem', color: 'var(--text-muted)' }}>
                Page {workcentrePage + 1} / {Math.ceil(workcentreRows.length / WORKCENTRE_PAGE_SIZE)}
                {' '}({workcentreRows.length} rows total)
              </span>
              <button
                className="aps-btn aps-btn--secondary"
                disabled={(workcentrePage + 1) * WORKCENTRE_PAGE_SIZE >= workcentreRows.length}
                onClick={() => setWorkcentrePage((p) => p + 1)}
              >
                Next →
              </button>
            </div>
          )}
        </div>
      ) : manageTab === 'alternatives' ? (
        <div className="tab-placeholder guide-panel">
          <h3>Alternative Machine Groups <span className="sp-na" title="Generate and the Auto plan don't pick alternative machines yet">not used by Generate yet</span></h3>
          <p>Create groups of machines for the same work centre so operations can switch between them when you move or schedule them by hand. Generate and the Auto plan don't use these groups yet.</p>
          <div className="guide-grid">
            <label className="guide-card">
              <strong>Work Centre</strong>
              <select
                className="job-filter-select"
                value={newAlternativeGroup.workcentreId}
                onChange={(e) => setNewAlternativeGroup((prev) => ({ ...prev, workcentreId: e.target.value, machineIds: [] }))}
              >
                <option value="">Select work centre</option>
                {allWorkcentreIds.map((wc) => (
                  <option key={wc} value={wc}>{wc}</option>
                ))}
              </select>
            </label>
            <label className="guide-card">
              <strong>Group Name</strong>
              <input
                className="job-search-input"
                value={newAlternativeGroup.name}
                onChange={(e) => setNewAlternativeGroup((prev) => ({ ...prev, name: e.target.value }))}
                placeholder="Example: CNC Cell A"
              />
            </label>
            <label className="guide-card">
              <strong>Notes</strong>
              <input
                className="job-search-input"
                value={newAlternativeGroup.notes}
                onChange={(e) => setNewAlternativeGroup((prev) => ({ ...prev, notes: e.target.value }))}
                placeholder="Optional notes"
              />
            </label>
          </div>
          <div className="column-picker-panel">
            <strong>Machines in group</strong>
            <div className="guide-grid">
              {(machineOptionsByWorkcentre[newAlternativeGroup.workcentreId] || []).map((machineId) => (
                <label key={machineId} className="column-picker-item">
                  <input
                    type="checkbox"
                    checked={newAlternativeGroup.machineIds.includes(machineId)}
                    onChange={() => setNewAlternativeGroup((prev) => ({
                      ...prev,
                      machineIds: prev.machineIds.includes(machineId)
                        ? prev.machineIds.filter((item) => item !== machineId)
                        : [...prev.machineIds, machineId]
                    }))}
                  />
                  <span>{machineId}</span>
                </label>
              ))}
            </div>
            <button className="btn btn-primary" onClick={saveAlternativeGroup}>Save Group</button>
          </div>
          <div className="column-picker-panel">
            <strong>Saved groups</strong>
            {alternativeGroups.length === 0 ? (
              <div className="ops-empty">No alternative groups created yet.</div>
            ) : (
              alternativeGroups.map((group) => (
                <div key={group.groupId} className="guide-card">
                  <div className="ops-header">
                    <strong>{group.name}</strong>
                    <button className="job-filter-clear" onClick={() => removeAlternativeGroup(group.groupId)}>Remove</button>
                  </div>
                  <div>WC: {group.workcentreId}</div>
                  <div>Machines: {group.machineIds.join(', ')}</div>
                  {group.notes ? <div>Notes: {group.notes}</div> : null}
                </div>
              ))
            )}
          </div>
        </div>
      ) : manageTab === 'constraints' ? (
        <div className="tab-placeholder">
          <h3>Constraints</h3>
          <p>Constraint rule tab created. Hook this into your hard/soft APS constraints workflow.</p>
        </div>
      ) : manageTab === 'import' ? (
        <div className="tab-placeholder guide-panel">
          <h3>Import Jobs &amp; Operations</h3>
          <p>Upload a CSV file to import jobs or operations. The first row must be a header row.</p>
          <div className="guide-grid" style={{ gap: 16, maxWidth: 560 }}>
            <div className="guide-card">
              <strong>Import Jobs</strong>
              <p style={{ fontSize: 12, margin: '6px 0 10px' }}>
                Required columns: <code>Job ID</code>, <code>Due Date</code>, <code>Quantity</code>.
                Optional: <code>Description</code>, <code>Priority</code>.
              </p>
              <input
                ref={jobImportRef}
                type="file"
                accept=".csv"
                style={{ display: 'none' }}
                onChange={(e) => handleBulkImport(e, 'jobs')}
              />
              <button
                className="btn btn-primary"
                disabled={importing}
                onClick={() => jobImportRef.current?.click()}
              >
                {importing ? 'Importing…' : 'Choose Jobs CSV…'}
              </button>
            </div>
            <div className="guide-card">
              <strong>Import Operations</strong>
              <p style={{ fontSize: 12, margin: '6px 0 10px' }}>
                Required columns: <code>Job ID</code>, <code>Op Sequence</code>, <code>Workcentre ID</code>, <code>Duration</code>.
                Optional: <code>Setup Time</code>, <code>Movement Time</code>.
              </p>
              <input
                ref={opsImportRef}
                type="file"
                accept=".csv"
                style={{ display: 'none' }}
                onChange={(e) => handleBulkImport(e, 'operations')}
              />
              <button
                className="btn btn-primary"
                disabled={importing}
                onClick={() => opsImportRef.current?.click()}
              >
                {importing ? 'Importing…' : 'Choose Operations CSV…'}
              </button>
            </div>
          </div>
        </div>
      ) : manageTab === 'shifts' ? (
        <Suspense fallback={<div className="tab-loading-spinner" role="status">Loading…</div>}>
          <ShiftManagementTab onShiftsChanged={loadJobsAndResources} />
        </Suspense>
      ) : manageTab === 'crews' ? (
        <CrewsPanel workcentreIds={allWorkcentreIds} />
      ) : manageTab === 'markers' ? (
        <MarkersPanel />
      ) : manageTab === 'mapping' ? (
        <div className="tab-placeholder">
          <h3>Mapping</h3>
          <p>Mapping tab created. Map Syspro fields to APS entities here.</p>
        </div>
      ) : manageTab === 'interval' ? (
        <div className="tab-placeholder guide-panel" style={{ padding: 16 }}>
          <div className="ops-header">
            <h3>Schedule Board Interval</h3>
          </div>
          <p style={{ fontSize: 12, color: '#4a6785', marginBottom: 12 }}>
            Set the date range the Schedule Board should display. Only operations within this window will be visible.
          </p>
          <div style={{ display: 'flex', flexDirection: 'column', gap: 12, maxWidth: 340 }}>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: '#2b4b73' }}>
              Start Date
              <input
                type="date"
                value={draftIntervalStart}
                onChange={(e) => setDraftIntervalStart(e.target.value)}
                style={{ padding: '6px 8px', fontSize: 13, borderRadius: 4, border: '1px solid #8daacd', background: '#f6f9fe' }}
              />
            </label>
            <label style={{ display: 'flex', flexDirection: 'column', gap: 4, fontSize: 12, fontWeight: 600, color: '#2b4b73' }}>
              End Date
              <input
                type="date"
                value={draftIntervalEnd}
                min={draftIntervalStart}
                onChange={(e) => setDraftIntervalEnd(e.target.value)}
                style={{ padding: '6px 8px', fontSize: 13, borderRadius: 4, border: '1px solid #8daacd', background: '#f6f9fe' }}
              />
            </label>
            <div style={{ display: 'flex', gap: 8, marginTop: 4 }}>
              <button
                className="btn btn-primary"
                onClick={() => {
                  setBoardIntervalStart(draftIntervalStart);
                  setBoardIntervalEnd(draftIntervalEnd);
                  toast.success(`Board interval set: ${draftIntervalStart} to ${draftIntervalEnd}`);
                }}
              >
                Apply
              </button>
              <button
                className="btn btn-sm"
                onClick={() => {
                  const today = new Date().toISOString().split('T')[0];
                  const end28 = new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];
                  setDraftIntervalStart(today);
                  setDraftIntervalEnd(end28);
                  setBoardIntervalStart(today);
                  setBoardIntervalEnd(end28);
                  toast.success('Interval reset to default (28 days)');
                }}
              >
                Reset
              </button>
            </div>
            <div style={{ fontSize: 11, color: '#6b7f99', marginTop: 8, padding: '8px 10px', background: '#eef4fd', borderRadius: 4, border: '1px solid #d0dff2' }}>
              <strong>Current board interval:</strong> {boardIntervalStart} to {boardIntervalEnd}
              <br />
              <span>{Math.max(1, Math.ceil((new Date(boardIntervalEnd).getTime() - new Date(boardIntervalStart).getTime()) / (1000 * 60 * 60 * 24)))} days</span>
            </div>
          </div>
        </div>
      ) : (
        <div className="tab-placeholder">
          <h3>Module</h3>
        </div>
      )}
    </section>
  </>
  );
};

export default JobsPanel;
