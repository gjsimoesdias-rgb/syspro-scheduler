import React, { useState, useEffect, useMemo, useRef, useCallback, Suspense, lazy } from 'react';
import toast, { Toaster } from 'react-hot-toast';
import { format } from 'date-fns';
import { Keyboard, Lock, Unlock } from 'lucide-react';
// Always-eager: modals and always-visible chrome
import ConstraintOverrideModal from './components/ConstraintOverrideModal';
import BomDetailModal from './components/BomDetailModal';
import AdvancedFilterBuilder from './components/AdvancedFilterBuilder';
import { jobMatchesFilter, applyAdvancedSort } from './lib/advancedFilter';
import SettingsPanel from './components/SettingsPanel';
import AppHeader from './components/AppHeader';
import AppFooter from './components/AppFooter';
import MainTabs from './components/MainTabs';
import ShortcutsHelpModal from './components/ShortcutsHelpModal';
import AppRibbon from './components/AppRibbon';
import ConnectionModal from './components/ConnectionModal';
import SchemaExplorer from './components/SchemaExplorer';
import ContentTabPanel from './components/ContentTabPanel';
// Type-only import (no runtime value used)
import type { GanttSettingsState } from './components/GanttSettings';
// Lazy tab panels still used directly in App.tsx (manage tab)
const ResourceDefinitionTab = lazy(() => import('./components/ResourceDefinitionTab'));
const ShiftManagementTab = lazy(() => import('./components/ShiftManagementTab'));
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import { useUiStore, MAIN_TABS, type MainTab, type ContentTab, type WorkflowJobFilter, type JobPaneMode, type ScheduleAroundMode, type ManageTab, type SchedulingRule, type SchedulingDirection, type ScheduleDateMode } from './stores/uiStore';
import { useScheduleStore } from './stores/scheduleStore';
import exportService from './services/exportService';
import { createShortcutManager } from './services/keyboardShortcuts';
import BulkImportService from './services/bulkImportService';
import { Schedule, ConstraintViolation, Job, Resource, Operation, OperationSchedule, JobSchedule } from './types';
import { scheduleService, versionService, apiClient, resourceService, pinService, settingsService, type PinnedOperationDto, apiErrorMessage } from './services/api';
import { getUserGuideHtml } from './userGuideHtml';
import ScheduleSetupModal, { ScheduleConfig } from './components/ScheduleSetupModal';
import { useSseEvents } from './hooks/useSseEvents';
import { useJobsData } from './hooks/useJobsData';
import { useScheduleGeneration } from './hooks/useScheduleGeneration';
import { useColumnManager, DEFAULT_JOB_COLUMNS, DEFAULT_OPERATION_COLUMNS, type JobColumnDef } from './hooks/useColumnManager';
import { convertScheduleDates } from './utils/scheduleDates';
import { findEarliestSlotOrForce, findEarliestSlotWithRetry } from './utils/slotFinder';
import {
  buildParentMap,
  clampMasterDropStart,
  describeDependencyViolation,
  getMasterLinkValue as extractMasterLink,
  getMasterRootJobId as resolveMasterRootJobId,
} from './utils/masterSub';
import {
  alignToProductiveWindow as alignToProductiveWindowUtil,
  calculateProductiveEndMs as calculateProductiveEndMsUtil,
  type CalendarWindowEnv,
} from './utils/calendarWindows';
import './App.css';
// Token-based overrides: MUST come after App.css to win specificity battles.
import './styles/aps-overrides.css';


const App: React.FC = () => {
  const isDarkMode = useUiStore((s) => s.isDarkMode);
  const toggleDarkMode = useUiStore((s) => s.toggleDarkMode);
  const { user, logout } = useAuth();
  const schedule = useScheduleStore((s) => s.schedule);
  const setSchedule = useScheduleStore((s) => s.setSchedule);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const scheduleSource = useScheduleStore((s) => s.scheduleSource);
  const activeVersion = useScheduleStore((s) => s.activeVersion);
  const setScheduleSource = useScheduleStore((s) => s.setScheduleSource);
  // loading is provided by useScheduleGeneration (wired below after addVersion)
  const isGeneratingSchedule = useScheduleStore((s) => s.isGeneratingSchedule);
  const setIsGeneratingSchedule = useScheduleStore((s) => s.setIsGeneratingSchedule);
  const generationProgress = useScheduleStore((s) => s.generationProgress);
  const setGenerationProgress = useScheduleStore((s) => s.setGenerationProgress);
  const generationStatusText = useScheduleStore((s) => s.generationStatusText);
  const setGenerationStatusText = useScheduleStore((s) => s.setGenerationStatusText);
  const schedulingHorizonStart = useUiStore((s) => s.schedulingHorizonStart);
  const schedulingHorizonEnd = useUiStore((s) => s.schedulingHorizonEnd);
  const setSchedulingHorizonStore = useUiStore((s) => s.setSchedulingHorizon);
  const schedulingHorizon = { start: schedulingHorizonStart, end: schedulingHorizonEnd };
  const setSchedulingHorizon = (v: { start: string; end: string }) =>
    setSchedulingHorizonStore(v.start, v.end);
  const boardIntervalStart = useUiStore((s) => s.boardIntervalStart);
  const setBoardIntervalStart = useUiStore((s) => s.setBoardIntervalStart);
  const boardIntervalEnd = useUiStore((s) => s.boardIntervalEnd);
  const setBoardIntervalEnd = useUiStore((s) => s.setBoardIntervalEnd);
  const draftIntervalStart = useUiStore((s) => s.draftIntervalStart);
  const setDraftIntervalStart = useUiStore((s) => s.setDraftIntervalStart);
  const draftIntervalEnd = useUiStore((s) => s.draftIntervalEnd);
  const setDraftIntervalEnd = useUiStore((s) => s.setDraftIntervalEnd);
  const activePlanningInterval = useUiStore((s) => s.activePlanningInterval);
  const setActivePlanningInterval = useUiStore((s) => s.setActivePlanningInterval);

  // Undo/Redo
  const undoRedoManager = useScheduleStore((s) => s.undoRedoManager);

  // Modals — open/close state lives in uiStore (single source of truth,
  // no extra useState hooks needed in App.tsx).
  const showOverrideModal = useUiStore((s) => s.showOverrideModal);
  const setShowOverrideModal = useUiStore((s) => s.setShowOverrideModal);
  const [selectedViolation, setSelectedViolation] = useState<ConstraintViolation | null>(null);
  const showShortcutsHelp = useUiStore((s) => s.showShortcutsHelp);
  const setShowShortcutsHelp = useUiStore((s) => s.setShowShortcutsHelp);
  const showSettingsModal = useUiStore((s) => s.showSettingsModal);
  const setShowSettingsModal = useUiStore((s) => s.setShowSettingsModal);
  // guideFocus state is intentional but unread today — the user-guide modal
  // doesn't yet jump to a specific section. Keep the setter so future code
  // can call setGuideFocus('jobs') etc. before opening the guide.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const [guideFocus, setGuideFocus] = useState<'overview' | 'company' | 'jobs' | 'materials' | 'publish' | 'shortcuts'>('overview');
  const showConnectionModal = useUiStore((s) => s.showConnectionModal);
  const setShowConnectionModal = useUiStore((s) => s.setShowConnectionModal);
  const showSchemaModal = useUiStore((s) => s.showSchemaModal);
  const setShowSchemaModal = useUiStore((s) => s.setShowSchemaModal);
  const contentTab = useUiStore((s) => s.contentTab);
  const setContentTab = useUiStore((s) => s.setContentTab);
  const ganttPrefs = useUiStore((s) => s.ganttPrefs);
  const setGanttPrefs = useUiStore((s) => s.setGanttPrefs);
  const scheduleVersions = useScheduleStore((s) => s.scheduleVersions);
  const setScheduleVersions = useScheduleStore((s) => s.setScheduleVersions);
  // Bulk import state + file input refs
  const [importing, setImporting] = useState(false);
  const jobImportRef = useRef<HTMLInputElement | null>(null);
  const opsImportRef = useRef<HTMLInputElement | null>(null);
  const workspaceRef = useRef<HTMLElement | null>(null);
  const centerPanelRef = useRef<HTMLDivElement | null>(null);

  // Gen3: What-If scenario
  const whatIfSchedule = useScheduleStore((s) => s.whatIfSchedule);
  const setWhatIfSchedule = useScheduleStore((s) => s.setWhatIfSchedule);
  const whatIfLabel = useScheduleStore((s) => s.whatIfLabel);
  const setWhatIfLabel = useScheduleStore((s) => s.setWhatIfLabel);

  // Gen3: Job grid search / filter (jobSearch + jobStatusFilter live in uiStore; debouncedJobSearch is derived)
  const jobSearch = useUiStore((s) => s.jobSearch);
  const setJobSearch = useUiStore((s) => s.setJobSearch);
  const jobStatusFilter = useUiStore((s) => s.jobStatusFilter);
  const setJobStatusFilter = useUiStore((s) => s.setJobStatusFilter);
  const resetJobFilters = useUiStore((s) => s.resetJobFilters);
  const [debouncedJobSearch, setDebouncedJobSearch] = useState(jobSearch);
  const jobWcFilter = useUiStore((s) => s.jobWcFilter);
  const setJobWcFilter = useUiStore((s) => s.setJobWcFilter);
  const scheduleFilter = useUiStore((s) => s.scheduleFilter);
  const setScheduleFilter = useUiStore((s) => s.setScheduleFilter);
  const workflowJobFilter = useUiStore((s) => s.workflowJobFilter) as WorkflowJobFilter;
  const setWorkflowJobFilter = useUiStore((s) => s.setWorkflowJobFilter);
  const advancedFilter = useUiStore((s) => s.advancedFilter);
  const advancedSort = useUiStore((s) => s.advancedSort);
  const [showAdvancedFilter, setShowAdvancedFilter] = useState(false);
  const jobPaneMode = useUiStore((s) => s.jobPaneMode) as JobPaneMode;
  const setJobPaneMode = useUiStore((s) => s.setJobPaneMode);
  const scheduleAroundMode = useUiStore((s) => s.scheduleAroundMode) as ScheduleAroundMode;
  const setScheduleAroundMode = useUiStore((s) => s.setScheduleAroundMode);
  // Column visibility, ordering, and profile persistence → useColumnManager (wired below after openJobs is available)

  // Gen3: Pagination for job grid tables (reset on filter/search change)
  const JOB_PAGE_SIZE = 120;
  const [jobPage, setJobPage] = useState(0);
  const [masterJobPage, setMasterJobPage] = useState(0);

  // Gen3: Scheduling rule
  const schedulingRule = useUiStore((s) => s.schedulingRule);
  const setSchedulingRule = useUiStore((s) => s.setSchedulingRule);
  const schedulingDirection = useUiStore((s) => s.schedulingDirection);
  const setSchedulingDirection = useUiStore((s) => s.setSchedulingDirection);
  const scheduleDateMode = useUiStore((s) => s.scheduleDateMode);
  const setScheduleDateMode = useUiStore((s) => s.setScheduleDateMode);
  const showScheduleSetup = useUiStore((s) => s.showScheduleSetup);
  const scheduleSetupPreselect = useUiStore((s) => s.scheduleSetupPreselect);
  const openScheduleSetup = useUiStore((s) => s.openScheduleSetup);
  const closeScheduleSetup = useUiStore((s) => s.closeScheduleSetup);
  const useAlternatives = useUiStore((s) => s.useAlternatives);
  const setUseAlternatives = useUiStore((s) => s.setUseAlternatives);
  const [excludedJobIds, setExcludedJobIds] = useState<Set<string>>(new Set());
  const [pinnedJobIds, setPinnedJobIds] = useState<Set<string>>(new Set());

  // Gen3: Highlighted job in gantt
  const highlightJobId = useScheduleStore((s) => s.highlightJobId);
  const setHighlightJobId = useScheduleStore((s) => s.setHighlightJobId);
  /** Externally-pinned ops ("jobId::opId" keys) — visible in both jobs table and Gantt */
  const pinnedOps = useScheduleStore((s) => s.pinnedOps);
  const togglePinnedOp = useScheduleStore((s) => s.togglePinnedOp);
  const setPinnedOps = useScheduleStore((s) => s.setPinnedOps);
  const setPinnedOpDetails = useScheduleStore((s) => s.setPinnedOpDetails);

  // Material-availability modal — opened from Gantt right-click → "View materials"
  const [bomJobId, setBomJobId] = useState<string | null>(null);

  // Data loading — jobs, resources, workcentres, materials, alternative groups
  const {
    openJobs,
    setOpenJobs,
    resources,
    dataLoading,
    dataWarning,
    materialPlan,
    materialStatusByJob,
    workcentreRows,
    workcentreColumns,
    workcentrePage,
    setWorkcentrePage,
    WORKCENTRE_PAGE_SIZE,
    alternativeGroups,
    newAlternativeGroup,
    setNewAlternativeGroup,
    dbStatus,
    setDbStatus,
    jobLoadRetryRef,
    loadJobsAndResources,
    loadSystemStatus,
    loadWorkcentreDetails,
    loadAlternativeGroups,
    loadMaterialPlan,
    saveAlternativeGroup,
    removeAlternativeGroup,
  } = useJobsData();
  const [selectedWorkcentre, setSelectedWorkcentre] = useState<string[]>([]);
  /** Drives MachineGanttBoard.focusWorkcentre — set after scheduling or a job click.
   *  A string focuses one lane; an array shows every lane the clicked job uses. */
  const [ganttFocusWorkcentre, setGanttFocusWorkcentre] = useState<string | string[] | null>(null);
  const [expandedWorkcentres, setExpandedWorkcentres] = useState<Record<string, boolean>>({});
  const [expandedJobs, setExpandedJobs] = useState<Record<string, boolean>>({});
  const workcentrePanelCollapsed = useUiStore((s) => s.workcentrePanelCollapsed);
  const setWorkcentrePanelCollapsed = useUiStore((s) => s.setWorkcentrePanelCollapsed);
  const workcentrePanelWidth = useUiStore((s) => s.workcentrePanelWidth);
  const setWorkcentrePanelWidth = useUiStore((s) => s.setWorkcentrePanelWidth);
  const jobsPanelHeight = useUiStore((s) => s.jobsPanelHeight);
  const setJobsPanelHeight = useUiStore((s) => s.setJobsPanelHeight);
  const [resizeMode, setResizeMode] = useState<null | 'left' | 'top'>(null);
  const mainTab = useUiStore((s) => s.mainTab) as MainTab;
  const setMainTab = useUiStore((s) => s.setMainTab);
  const manageTab = useUiStore((s) => s.manageTab);
  const setManageTab = useUiStore((s) => s.setManageTab);
  const [jobContextMenu, setJobContextMenu] = useState<{
    visible: boolean;
    x: number;
    y: number;
    jobId: string | null;
  }>({ visible: false, x: 0, y: 0, jobId: null });
  // SSE real-time replan notification
  const { replanBanner, setReplanBanner, sseConnected } = useSseEvents();

  const addVersion = (newSchedule: Schedule, description: string) => {
    const versionId = `${newSchedule.scheduleId}-${Date.now()}`;
    const next = scheduleVersions.map((item) => ({ ...item, isCurrent: false }));
    setScheduleVersions([
      {
        versionId,
        timestamp: new Date(),
        description,
        metrics: newSchedule.metrics,
        jobsCount: newSchedule.jobSchedules.length,
        isCurrent: true,
        scheduleData: newSchedule
      },
      ...next
    ].slice(0, 50));
  };

  // Schedule generation, export, and Syspro write-back
  const {
    loading,
    generateSchedule,
    exportToSyspro,
    handleExport,
  } = useScheduleGeneration({
    openJobs,
    resources,
    dbStatus,
    excludedJobIds,
    pinnedJobIds,
    loadJobsAndResources,
    addVersion,
  });

  // Column visibility, ordering, and profile persistence
  const {
    visibleJobColumns,
    setVisibleJobColumns,
    visibleOperationColumns,
    allJobColumns,
    allOperationColumns,
    dynamicDbColumns,
    orderedVisibleColumns,
    showColumnPicker,
    setShowColumnPicker,
    showOperationColumnPicker,
    setShowOperationColumnPicker,
    dragColRef,
    columnProfileName,
    setColumnProfileName,
    profileSaving,
    saveColumnProfile,
    toggleJobColumn,
    toggleOperationColumn,
    handleColDragStart,
    handleColDrop,
    formatGridColumnValue,
    formatJobColumnValue,
    formatOperationColumnValue,
  } = useColumnManager({ openJobs, userId: user?.id !== undefined ? String(user.id) : undefined });

  // ─── Cell renderers for the jobs grid (use formatters from useColumnManager) ──

  const renderJobCellContent = (job: Job, column: JobColumnDef): React.ReactNode => {
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

  const buildScheduleFromSyspro = useCallback((jobs: Job[]): Schedule | null => {
    const normalizeMachineValue = (value: unknown): string => {
      if (Array.isArray(value)) {
        for (const entry of value) {
          const normalized = normalizeMachineValue(entry);
          if (normalized) return normalized;
        }
        return '';
      }

      const text = String(value ?? '').trim();
      if (!text) return '';
      return text.split(',').map((part) => part.trim()).filter(Boolean)[0] || '';
    };

    const combineSysproDateTime = (dateValue: unknown, timeValue?: unknown): Date | null => {
      if (!dateValue) return null;

      const combined = new Date(dateValue as any);
      if (Number.isNaN(combined.getTime())) return null;

      if (timeValue === undefined || timeValue === null || String(timeValue).trim() === '') {
        return combined;
      }

      const raw = String(timeValue).trim();
      if (raw.includes(':')) {
        const [hours, minutes, seconds] = raw.split(':').map((value) => Number(value) || 0);
        combined.setHours(Math.max(0, Math.min(23, hours)), Math.max(0, Math.min(59, minutes)), Math.max(0, Math.min(59, seconds || 0)), 0);
        return combined;
      }

      const digits = raw.replace(/\D/g, '').padStart(4, '0').slice(-4);
      const hours = Number(digits.slice(0, 2)) || 0;
      const minutes = Number(digits.slice(2, 4)) || 0;
      combined.setHours(Math.max(0, Math.min(23, hours)), Math.max(0, Math.min(59, minutes)), 0, 0);
      return combined;
    };

    const jobSchedules = jobs.map((job) => {
      const operationSchedules = (job.operations || [])
        .map((operation) => {
          const plannedStartDate = combineSysproDateTime(
            (operation as any).plannedStartDate || (operation as any).SchStartDate,
            (operation as any).SchStartTime
          );
          const plannedEndDate = combineSysproDateTime(
            (operation as any).plannedEndDate || (operation as any).SchEndDate,
            (operation as any).SchEndTime
          );
          if (!plannedStartDate || !plannedEndDate) {
            return null;
          }

          if (Number.isNaN(plannedStartDate.getTime()) || Number.isNaN(plannedEndDate.getTime()) || plannedEndDate <= plannedStartDate) {
            return null;
          }

          const setupTime = Math.max(0, Number(operation.setupTime) || 0);
          const runTime = Math.max(0, Number(operation.duration) || 0);
          const queueTime = Math.max(0, Number(operation.queueTime) || 0);
          const moveTime = Math.max(0, Number(operation.moveTime) || 0);
          const setupStart = new Date(plannedStartDate);
          const setupEnd = new Date(plannedStartDate.getTime() + setupTime * 60 * 1000);
          const runStart = new Date(setupEnd);
          const runEnd = new Date(plannedEndDate);

          const bookedDurationMinutes = Math.max(1, setupTime + runTime);

          return {
            opId: operation.opId,
            workcentreId: operation.workcentreId,
            resourceId: normalizeMachineValue((operation as any).ScheduledMachine)
              || normalizeMachineValue((operation as any).assignedResourceId)
              || normalizeMachineValue((operation as any).IMachine)
              || operation.workcentreId,
            plannedStartDate,
            plannedEndDate,
            duration: bookedDurationMinutes,
            setupTime,
            runTime,
            queueTime,
            moveTime,
            setupStart,
            setupEnd,
            runStart,
            runEnd,
            queueEnd: new Date(runEnd),
            moveEnd: new Date(runEnd.getTime() + moveTime * 60 * 1000),
            sequence: Number(operation.sequence) || 0,
            isOvertimeSlot: false,
            batchSize: Number(operation.batchSize) || 1,
            slackTime: 0
          };
        })
        .filter((operation): operation is NonNullable<typeof operation> => !!operation)
        .sort((a, b) => a.sequence - b.sequence || a.plannedStartDate.getTime() - b.plannedStartDate.getTime());

      if (!operationSchedules.length) {
        return null;
      }

      return {
        jobId: job.jobId,
        plannedStartDate: operationSchedules[0].plannedStartDate,
        plannedEndDate: operationSchedules[operationSchedules.length - 1].plannedEndDate,
        operationSchedules,
        estimatedTardiness: 0,
        status: 'Scheduled' as const
      };
    }).filter((jobSchedule): jobSchedule is NonNullable<typeof jobSchedule> => !!jobSchedule);

    if (!jobSchedules.length) {
      return null;
    }

    const startMs = Math.min(...jobSchedules.map((jobSchedule) => jobSchedule.plannedStartDate.getTime()));
    const endMs = Math.max(...jobSchedules.map((jobSchedule) => jobSchedule.plannedEndDate.getTime()));

    return {
      scheduleId: 'syspro-live',
      scheduledDate: new Date(),
      version: 1,
      status: 'Draft',
      planningHorizon: {
        startDate: new Date(startMs),
        endDate: new Date(endMs)
      },
      jobSchedules,
      resourceLoads: [],
      constraintViolations: [],
      metrics: {
        totalJobsScheduled: jobSchedules.length,
        jobsOnTime: jobSchedules.length,
        jobsTardy: 0,
        averageTardiness: 0,
        resourceUtilization: 0,
        overtimeHours: 0,
        criticalPathLength: 0,
        totalSetupTime: 0,
        totalQueueTime: 0,
        totalMoveTime: 0
      }
    };
  }, []);

  // loadJobsAndResources, loadSystemStatus, loadWorkcentreDetails,
  // loadAlternativeGroups, and loadMaterialPlan are provided by useJobsData().

  const applyWorkflowFilter = useCallback((filter: WorkflowJobFilter) => {
    setManageTab('none');
    setJobPaneMode('production');
    setWorkflowJobFilter(filter);
    resetJobFilters();
    setDebouncedJobSearch('');
    setJobWcFilter('all');
    setSelectedWorkcentre([]);
    setScheduleFilter(filter === 'unscheduled' ? 'not-scheduled' : 'all');
  }, []);

  const openUserGuide = (section: 'overview' | 'company' | 'jobs' | 'materials' | 'publish' | 'shortcuts' = 'overview') => {
    setGuideFocus(section);
    setShowShortcutsHelp(false);

    const guideWindow = window.open('', 'ascend-aps-user-guide', 'width=1280,height=900,resizable=yes,scrollbars=yes');
    if (!guideWindow) {
      toast.error('Allow pop-ups to open the user guide');
      return;
    }

    guideWindow.document.open();
    guideWindow.document.write(getUserGuideHtml(section));
    guideWindow.document.close();
    guideWindow.focus();
  };

  // loadWorkcentreDetails, loadAlternativeGroups, loadMaterialPlan provided by useJobsData().
  // useSseEvents() handles the SSE EventSource connection — no useEffect needed here.

  // Stable refs for values captured in the keyboard-shortcut useEffect.
  // The effect runs once (empty deps), so without refs it would capture stale
  // closures. The .current assignments happen AFTER all handlers are defined
  // (see the block labelled "sync handler refs" below).
  const scheduleRef = useRef<typeof schedule>(schedule);
  scheduleRef.current = schedule; // schedule is already defined above
  const handleUndoRef = useRef<() => void>(() => {});
  const handleRedoRef = useRef<() => void>(() => {});
  const toggleDarkModeRef = useRef<() => void>(() => {});
  const openUserGuideRef = useRef<(section?: 'overview' | 'company' | 'jobs' | 'materials' | 'publish' | 'shortcuts') => void>(() => {});
  const openScheduleSetupRef = useRef<(ids?: string[]) => void>(() => {});
  /** Refs for arrow-nudge shortcut (Alt+Arrow) */
  const highlightJobIdRef = useRef<string | null>(null);
  const operationMoveRef = useRef<((jobId: string, opId: string, newStart: Date, wc: string) => void) | null>(null);
  /** Ref for scheduling a single operation from the Production Jobs grid */
  const scheduleOpRef = useRef<((job: Job, opId: string) => Promise<void>) | null>(null);

  useEffect(() => {
    console.log('🚀 Syspro Scheduler UI loaded');

    Promise.allSettled([
      loadJobsAndResources(),
      loadSystemStatus(),
      loadWorkcentreDetails(),
      loadAlternativeGroups()
    ]).finally(() => setScheduleLoading(false));

    // Setup keyboard shortcuts — uses refs so handlers always see latest state
    // without needing to re-register on every render.
    const shortcutManager = createShortcutManager();
    shortcutManager.register({
      action: 'Generate Schedule',
      keys: 'Ctrl+Enter',
      description: 'Generate new schedule',
      handler: () => openScheduleSetupRef.current()
    });
    shortcutManager.register({
      action: 'Export Schedule',
      keys: 'Ctrl+Shift+E',
      description: 'Export current schedule',
      handler: () => scheduleRef.current && exportService.downloadScheduleReport(scheduleRef.current)
    });
    shortcutManager.register({
      action: 'Undo',
      keys: 'Ctrl+Z',
      description: 'Undo last change',
      handler: () => handleUndoRef.current()
    });
    shortcutManager.register({
      action: 'Redo',
      keys: 'Ctrl+Shift+Z',
      description: 'Redo last undone change',
      handler: () => handleRedoRef.current()
    });
    shortcutManager.register({
      action: 'Toggle Dark Mode',
      keys: 'Ctrl+Shift+D',
      description: 'Toggle dark mode',
      handler: () => toggleDarkModeRef.current()
    });
    shortcutManager.register({
      action: 'Show Help',
      keys: '?',
      description: 'Open user guide',
      handler: () => openUserGuideRef.current('shortcuts')
    });
    shortcutManager.register({
      action: 'Nudge Op Left',
      keys: 'Alt+ARROWLEFT',
      description: 'Move highlighted operation −1 hour',
      handler: () => {
        const jobId = highlightJobIdRef.current;
        const sched = scheduleRef.current;
        const moveOp = operationMoveRef.current;
        if (!jobId || !sched || !moveOp) return;
        const js = sched.jobSchedules.find(j => j.jobId === jobId);
        if (!js || !js.operationSchedules.length) return;
        // nudge first unfinished op (lowest sequence)
        const op = [...js.operationSchedules].sort((a, b) => (a as any).sequence - (b as any).sequence)[0];
        const newStart = new Date(new Date(op.plannedStartDate).getTime() - 60 * 60_000);
        moveOp(jobId, op.opId, newStart, op.workcentreId);
      }
    });
    shortcutManager.register({
      action: 'Nudge Op Right',
      keys: 'Alt+ARROWRIGHT',
      description: 'Move highlighted operation +1 hour',
      handler: () => {
        const jobId = highlightJobIdRef.current;
        const sched = scheduleRef.current;
        const moveOp = operationMoveRef.current;
        if (!jobId || !sched || !moveOp) return;
        const js = sched.jobSchedules.find(j => j.jobId === jobId);
        if (!js || !js.operationSchedules.length) return;
        const op = [...js.operationSchedules].sort((a, b) => (a as any).sequence - (b as any).sequence)[0];
        const newStart = new Date(new Date(op.plannedStartDate).getTime() + 60 * 60_000);
        moveOp(jobId, op.opId, newStart, op.workcentreId);
      }
    });

    const handleKeyDown = (e: KeyboardEvent) => shortcutManager.handleKeyDown(e);
    window.addEventListener('keydown', handleKeyDown);
    return () => window.removeEventListener('keydown', handleKeyDown);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  useEffect(() => {
    if (scheduleLoading || !schedule || !dbStatus.sysproConnected || scheduleSource !== 'session') {
      return;
    }

    const timeoutId = window.setTimeout(() => {
      // An open what-if saves into itself; only the master goes to /schedule/save.
      const save = activeVersion
        ? versionService.saveInto(activeVersion.versionId, schedule)
        : scheduleService.save(schedule);
      save.catch((error) => {
        console.warn('Could not persist schedule:', error);
      });
    }, 600);

    return () => window.clearTimeout(timeoutId);
  }, [schedule, scheduleLoading, dbStatus.sysproConnected, scheduleSource, activeVersion]);

  useEffect(() => {
    // 'restored' = a saved plan opened from the Versions tab (or loaded at
    // start-up): keep it on the board instead of rebuilding from SYSPRO dates.
    if (scheduleSource === 'session' || scheduleSource === 'restored') {
      return;
    }

    const sysproSchedule = buildScheduleFromSyspro(openJobs);
    if (sysproSchedule) {
      setSchedule(sysproSchedule);

      // Only use Syspro job dates for the board interval when the user has
      // explicitly chosen 'previous-loaded' mode (or before settings have
      // loaded). For 'from-today' / 'custom' the planning interval takes
      // precedence so old Syspro dates don't overwrite the setting.
      const piLocked = activePlanningInterval && activePlanningInterval.mode !== 'previous-loaded';
      const horizonStart = piLocked ? activePlanningInterval!.start : format(sysproSchedule.planningHorizon.startDate, 'yyyy-MM-dd');
      const horizonEnd   = piLocked ? activePlanningInterval!.end   : format(sysproSchedule.planningHorizon.endDate,   'yyyy-MM-dd');
      setBoardIntervalStart(horizonStart);
      setBoardIntervalEnd(horizonEnd);
      setDraftIntervalStart(horizonStart);
      setDraftIntervalEnd(horizonEnd);
      if (scheduleSource !== 'syspro') {
        setScheduleSource('syspro');
      }
      return;
    }

    setSchedule(null);
    if (scheduleSource !== 'none') {
      setScheduleSource('none');
    }

    // Nothing scheduled in SYSPRO yet: show the saved master plan instead of
    // an empty board (once jobs are loaded, so the board has its context).
    if (openJobs.length > 0 && dbStatus.sysproConnected) {
      scheduleService.loadLatest()
        .then(({ schedule: master }) => {
          const st = useScheduleStore.getState();
          if (master && st.scheduleSource === 'none' && !st.activeVersion) {
            setSchedule(convertScheduleDates(master));
            setScheduleSource('restored');
          }
        })
        .catch(() => { /* no saved plan yet */ });
    }
  }, [openJobs, scheduleSource, buildScheduleFromSyspro, activePlanningInterval, dbStatus.sysproConnected]);

  useEffect(() => {
    if (!isGeneratingSchedule) {
      setGenerationProgress(0);
      setGenerationStatusText('Preparing scheduler...');
      return;
    }

    const totalOps = openJobs.reduce((sum, job) => sum + Math.max(1, job.operations?.length || 0), 0);
    const estimatedDurationMs = Math.min(90000, Math.max(10000, totalOps * 180));
    const startedAt = Date.now();

    setGenerationProgress(3);
    setGenerationStatusText('Reading jobs, shifts, and constraints...');

    const timer = window.setInterval(() => {
      const elapsedMs = Date.now() - startedAt;
      const nextPct = Math.min(95, Math.max(3, Math.round((elapsedMs / estimatedDurationMs) * 100)));
      setGenerationProgress(nextPct);

      if (nextPct < 25) {
        setGenerationStatusText('Reading jobs, shifts, and constraints...');
      } else if (nextPct < 55) {
        setGenerationStatusText('Sequencing operations...');
      } else if (nextPct < 85) {
        setGenerationStatusText('Allocating machine capacity...');
      } else {
        setGenerationStatusText('Finalizing the schedule...');
      }
    }, 400);

    return () => window.clearInterval(timer);
  }, [isGeneratingSchedule, openJobs]);

  // generateSchedule, exportToSyspro, and handleExport are provided by useScheduleGeneration().

  const handleScheduleSetupGenerate = (config: ScheduleConfig) => {
    setSchedulingRule(config.schedulingRule);
    setSchedulingDirection(config.schedulingDirection);
    setScheduleDateMode(config.scheduleDateMode);
    setSchedulingHorizon({ start: config.horizonStart, end: config.horizonEnd });
    setBoardIntervalStart(config.horizonStart);
    setBoardIntervalEnd(config.horizonEnd);

    closeScheduleSetup();

    generateSchedule(
      config.selectedJobIds.length < openJobs.length ? config.selectedJobIds : undefined,
      config
    );
  };

  /**
   * Mark the current schedule as session-owned after a manual edit.
   *
   * The autosave effect only persists schedules whose source is 'session',
   * and the SYSPRO-rebuild effect overwrites any schedule whose source is
   * NOT 'session' whenever the job list refreshes. Every manual mutation
   * (drag, nudge, unschedule, undo/redo, version restore) must therefore
   * flip the source to 'session' — otherwise the edit is never saved and
   * gets silently clobbered on the next jobs refresh.
   */
  const markScheduleEdited = () => {
    if (scheduleSource !== 'session') {
      setScheduleSource('session');
    }
  };

  const handleUndo = () => {
    const prevState = undoRedoManager.undo();
    if (prevState) {
      setSchedule(convertScheduleDates(prevState.scheduleData));
      markScheduleEdited();
      toast.success('↩️ Undone');
    } else {
      toast.error('Nothing to undo');
    }
  };

  const handleRedo = () => {
    const nextState = undoRedoManager.redo();
    if (nextState) {
      setSchedule(convertScheduleDates(nextState.scheduleData));
      markScheduleEdited();
      toast.success('↪️ Redone');
    } else {
      toast.error('Nothing to redo');
    }
  };

  // Sync handler refs — must come AFTER all handlers are defined so the refs
  // always point to the latest function instances on every render.
  handleUndoRef.current = handleUndo;
  handleRedoRef.current = handleRedo;
  toggleDarkModeRef.current = toggleDarkMode;
  openUserGuideRef.current = openUserGuide;
  openScheduleSetupRef.current = openScheduleSetup;
  highlightJobIdRef.current = highlightJobId;

  // exportToSyspro and handleExport are provided by useScheduleGeneration().

  const handleApproveOverride = async (violationId: string, reason: string) => {
    try {
      await apiClient.post(`/schedule/${schedule?.scheduleId}/approve-override`, {
        violationId,
        reason
      });
      if (schedule) {
        const updated = {
          ...schedule,
          constraintViolations: schedule.constraintViolations.filter((v) => v.violationId !== violationId)
        };
        setSchedule(updated);
        markScheduleEdited();
      }
      toast.success('✓ Constraint override approved');
      setShowOverrideModal(false);
      setSelectedViolation(null);
    } catch (error: any) {
      toast.error('Failed to approve override');
    }
  };

  const workcentreGroups = useMemo(() => {
    const map: Record<string, Resource[]> = {};

    for (const r of resources) {
      if (!map[r.worcentreId]) map[r.worcentreId] = [];
      map[r.worcentreId].push(r);
    }

    return map;
  }, [resources]);

  const orderedGroupNames = useMemo(() => Object.keys(workcentreGroups).sort(), [workcentreGroups]);

  const visibleJobSource = useMemo(() => {
    if (openJobs.length) return openJobs;
    if (!schedule?.jobSchedules?.length) return [] as Job[];

    return schedule.jobSchedules.map((jobSchedule) => ({
      jobId: jobSchedule.jobId,
      itemCode: jobSchedule.jobId,
      description: 'Scheduled job',
      quantity: 1,
      dueDate: new Date(jobSchedule.plannedEndDate),
      releaseDate: new Date(jobSchedule.plannedStartDate),
      priority: 5,
      status: 'Released' as const,
      operations: jobSchedule.operationSchedules.map((op) => ({
        opId: String(op.opId),
        jobId: jobSchedule.jobId,
        sequence: Number((op as any).sequence || String(op.opId).replace(/\D/g, '') || 10),
        workcentreId: op.workcentreId,
        workcentreName: op.workcentreId,
        duration: Math.max(1, Number((op as any).runTime || op.duration || 1)),
        setupTime: Math.max(0, Number((op as any).setupTime || 0)),
        queueTime: Math.max(0, Number((op as any).queueTime || 0)),
        moveTime: Math.max(0, Number((op as any).moveTime || 0)),
        batchSize: Math.max(1, Number((op as any).batchSize || 1)),
        qualifiedResourceIds: [],
        status: 'NotStarted' as const
      })),
      estimatedMaterialCost: 0,
      estimatedLaborCost: 0
    }));
  }, [openJobs, schedule]);

  useEffect(() => {
    loadMaterialPlan(visibleJobSource);
  }, [visibleJobSource]);

  // Load persisted pins from backend on startup
  useEffect(() => {
    pinService.getAll()
      .then((pins) => {
        const detailMap = new Map<string, PinnedOperationDto>();
        const keySet = new Set<string>();
        for (const pin of pins) {
          const key = `${pin.jobId}::${pin.opId}`;
          detailMap.set(key, pin);
          keySet.add(key);
        }
        setPinnedOpDetails(detailMap);
        setPinnedOps(keySet);
      })
      .catch(() => {
        // Silently ignore — pins are a best-effort feature
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Apply Planning Interval from Settings on every login / page load.
  // 'from-today'      → recompute start/end from today each time
  // 'custom'          → use the saved custom dates
  // 'previous-loaded' → do nothing (keep whatever is in localStorage)
  useEffect(() => {
    if (!user) return; // wait until authenticated
    settingsService.getCompany()
      .then((cs) => {
        // ── Apply company-wide policy settings (persisted-but-inert until 2026-07-08) ──

        // Theme: 'Dark' switches dark mode on; 'Light'/'Blue' switch it off.
        const theme = String(cs?.general?.theme || '').toLowerCase();
        if (theme) {
          const wantDark = theme === 'dark';
          const ui = useUiStore.getState();
          if (wantDark !== ui.isDarkMode) ui.toggleDarkMode();
        }

        // Default scheduling direction & rule for new runs. The setup modal
        // still allows per-run overrides; this only seeds the defaults.
        const dir = cs?.jobManagement?.defaultDirection || cs?.fcs?.schedulingRules?.schedulingMethod;
        if (dir === 'forward' || dir === 'backward') {
          useUiStore.getState().setSchedulingDirection(dir);
        }
        if (cs?.fcs?.schedulingRules?.sequenceBy === 'priority-index') {
          useUiStore.getState().setSchedulingRule('priority');
        }

        const pi = cs?.fcs?.planningInterval;
        if (!pi) return;

        // Always record the mode so buildScheduleFromSyspro knows whether to
        // use Syspro job dates or the planning interval dates for the board.
        if (pi.mode === 'previous-loaded') {
          setActivePlanningInterval({ mode: 'previous-loaded', start: '', end: '' });
          return;
        }

        let start = '';
        let end = '';

        if (pi.mode === 'from-today') {
          const startDate = new Date(Date.now() + (pi.fromTodayStartOffset || 0) * 24 * 60 * 60 * 1000);
          const endDate   = new Date(startDate.getTime() + (pi.fromTodayDurationWeeks || 4) * 7 * 24 * 60 * 60 * 1000);
          start = startDate.toISOString().split('T')[0];
          end   = endDate.toISOString().split('T')[0];
        } else if (pi.mode === 'custom' && pi.customFrom && pi.customTo) {
          start = pi.customFrom;
          end   = pi.customTo;
        }

        if (!start || !end) return;

        setActivePlanningInterval({ mode: pi.mode, start, end });
        setSchedulingHorizonStore(start, end);
        setBoardIntervalStart(start);
        setBoardIntervalEnd(end);
        setDraftIntervalStart(start);
        setDraftIntervalEnd(end);
      })
      .catch(() => {
        // Non-fatal — keep existing horizon
      });
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [user]);

  const scheduleByJobId = useMemo(() => {
    const map = new Map<string, JobSchedule>();
    if (schedule?.jobSchedules) {
      for (const js of schedule.jobSchedules) map.set(js.jobId, js);
    }
    return map;
  }, [schedule]);

  /**
   * Toggle pin for a single operation. Syncs optimistically with the backend:
   * – When pinning: POSTs the current scheduled slot so the engine can freeze it.
   * – When unpinning: DELETEs the pin from the backend store.
   */
  const handleTogglePin = useCallback(async (jobId: string, opId: string) => {
    const key = `${jobId}::${opId}`;
    const alreadyPinned = pinnedOps.has(key);

    if (alreadyPinned) {
      // Optimistic unpin
      togglePinnedOp(jobId, opId);
      setPinnedOpDetails(new Map([...useScheduleStore.getState().pinnedOpDetails].filter(([k]) => k !== key)));
      try {
        await pinService.unpin(jobId, opId);
      } catch {
        // Roll back optimistic update
        togglePinnedOp(jobId, opId);
        toast.error('Could not unpin operation');
      }
    } else {
      // Find the current scheduled slot for this op
      const jobSchedule = scheduleByJobId.get(jobId);
      const opSchedule = jobSchedule?.operationSchedules?.find((o) => String(o.opId) === String(opId));
      if (!opSchedule) {
        toast('Schedule this job first before pinning', { icon: 'ℹ️' });
        return;
      }

      const pinDto: Omit<PinnedOperationDto, 'pinnedAt' | 'pinnedBy'> = {
        jobId,
        opId: String(opId),
        workcentreId: String(opSchedule.workcentreId),
        resourceId: String(opSchedule.resourceId),
        plannedStartDate: new Date(opSchedule.plannedStartDate).toISOString(),
        plannedEndDate: new Date(opSchedule.plannedEndDate).toISOString(),
      };

      // Optimistic pin
      togglePinnedOp(jobId, opId);
      try {
        const result = await pinService.pin(pinDto);
        const fullPin: PinnedOperationDto = { ...pinDto, pinnedAt: new Date().toISOString() };
        setPinnedOpDetails(new Map([...useScheduleStore.getState().pinnedOpDetails, [key, fullPin]]));
        toast.success(`Operation ${opId} pinned — it will stay fixed on regeneration`);
      } catch {
        // Roll back optimistic update
        togglePinnedOp(jobId, opId);
        toast.error('Could not pin operation');
      }
    }
  }, [pinnedOps, togglePinnedOp, setPinnedOpDetails, scheduleByJobId]);

  // Per-job lateness indicator: compare scheduled end date vs job due date
  const jobLatenessMap = useMemo(() => {
    const map = new Map<string, 'late' | 'at-risk' | 'on-time' | 'unscheduled'>();
    for (const js of schedule?.jobSchedules ?? []) {
      const job = openJobs.find(j => j.jobId === js.jobId);
      if (!job?.dueDate) { map.set(js.jobId, 'on-time'); continue; }
      const endDate = new Date(js.plannedEndDate);
      const dueDate = new Date(job.dueDate);
      if (isNaN(endDate.getTime()) || isNaN(dueDate.getTime())) { map.set(js.jobId, 'on-time'); continue; }
      const diffMs = endDate.getTime() - dueDate.getTime();
      if (diffMs > 0) map.set(js.jobId, 'late');
      else if (diffMs > -8 * 60 * 60 * 1000) map.set(js.jobId, 'at-risk');
      else map.set(js.jobId, 'on-time');
    }
    return map;
  }, [schedule, openJobs]);

  const getJobScheduleStatus = useCallback((job: Job): 'scheduled' | 'partial' | 'not-scheduled' => {
    const jobSch = scheduleByJobId.get(job.jobId);
    if (!jobSch) return 'not-scheduled';
    const totalOps = job.operations.length;
    const scheduledOps = jobSch.operationSchedules?.length ?? 0;
    if (scheduledOps >= totalOps && totalOps > 0) return 'scheduled';
    if (scheduledOps > 0) return 'partial';
    return 'not-scheduled';
  }, [scheduleByJobId]);

  /**
   * Explain WHY jobs didn't fully fit the last schedule run.
   *
   * The engine emits a ConstraintViolation for every operation it couldn't
   * place (CapacityExceeded when the machine's hours ran out before the
   * horizon end, and related placement failures). We join each violation's
   * affectedOperationId back to the job's operation to name the work centre
   * that ran out of room, producing a per-job hover tip plus an aggregate
   * bottleneck summary.
   */
  const scheduleShortfall = useMemo(() => {
    const violations = schedule?.constraintViolations;
    if (!violations || violations.length === 0) return null;

    const humanViolation = (t: string): string => {
      switch (t) {
        case 'CapacityExceeded': return 'no capacity in window';
        case 'OvertimeExceeded': return 'over shift capacity';
        case 'ScheduleDateViolation': return 'outside horizon';
        case 'SkillMismatch': return 'no qualified machine';
        case 'LineGroupViolation': return 'line-group conflict';
        case 'SetupConflict': return 'setup conflict';
        case 'BatchViolation': return 'batch rule';
        default: return t;
      }
    };
    const PLACEMENT_TYPES = new Set([
      'CapacityExceeded', 'OvertimeExceeded', 'ScheduleDateViolation',
      'SkillMismatch', 'LineGroupViolation', 'SetupConflict', 'BatchViolation',
    ]);

    // opId -> { wc, seq } across all currently-loaded jobs.
    const opMap = new Map<string, { wc: string; seq: number }>();
    for (const j of openJobs) {
      for (const op of j.operations || []) {
        opMap.set(op.opId, { wc: op.workcentreName || op.workcentreId, seq: op.sequence });
      }
    }

    const reasonsByJob = new Map<string, string[]>();
    const wcCounts = new Map<string, number>();
    const jobIds = new Set<string>();
    let opCount = 0;

    for (const v of violations) {
      if (!PLACEMENT_TYPES.has(v.type)) continue;
      opCount++;
      const info = v.affectedOperationId ? opMap.get(v.affectedOperationId) : undefined;
      const wc = info?.wc || 'work centre';
      if (v.type === 'CapacityExceeded' || v.type === 'OvertimeExceeded') {
        wcCounts.set(wc, (wcCounts.get(wc) || 0) + 1);
      }
      const jid = v.affectedJobId;
      if (jid) {
        jobIds.add(jid);
        const label = info ? `Op ${info.seq} — ${wc}` : (v.description || v.type);
        const line = `${label} (${humanViolation(v.type)})`;
        const arr = reasonsByJob.get(jid) || [];
        if (!arr.includes(line)) arr.push(line);
        reasonsByJob.set(jid, arr);
      }
    }

    if (opCount === 0) return null;

    const tipByJob = new Map<string, string>();
    for (const [jid, arr] of reasonsByJob) {
      tipByJob.set(jid, `Couldn't fit in this schedule:\n• ${arr.join('\n• ')}`);
    }
    const topWc = [...wcCounts.entries()].sort((a, b) => b[1] - a[1]);

    return { tipByJob, jobCount: jobIds.size, opCount, topWc };
  }, [schedule, openJobs]);

  const getJobMaterialStatus = useCallback((job: Job): 'Materials' | 'Partial' | 'No Materials' => {
    return materialStatusByJob[job.jobId] || 'Materials';
  }, [materialStatusByJob]);

  // Master/sub-job helpers — logic shared with MachineGanttBoard via utils/masterSub.
  const getMasterLinkValue = useCallback((job: Job): string => extractMasterLink(job), []);

  const parentJobByChildId = useMemo(() => buildParentMap(visibleJobSource), [visibleJobSource]);

  // Dependency map over ALL open jobs (not just the visible subset) — used by
  // the manual-scheduling dependency guards below.
  const masterParentMap = useMemo(() => buildParentMap(openJobs), [openJobs]);

  const getMasterRootJobId = useCallback(
    (job: Job): string => resolveMasterRootJobId(job.jobId, parentJobByChildId),
    [parentJobByChildId]
  );

  // Debounce search input so filtering only runs after user pauses typing
  useEffect(() => {
    const timer = setTimeout(() => setDebouncedJobSearch(jobSearch), 250);
    return () => clearTimeout(timer);
  }, [jobSearch]);

  // Reset pagination when filters change
  useEffect(() => { setJobPage(0); }, [debouncedJobSearch, jobStatusFilter, jobWcFilter, scheduleFilter, workflowJobFilter, jobPaneMode]);
  useEffect(() => { setMasterJobPage(0); }, [debouncedJobSearch, jobStatusFilter, jobWcFilter, scheduleFilter, workflowJobFilter]);

  // Gen3 multi-criteria job filtering
  const filteredJobs = useMemo(() => {
    let list = selectedWorkcentre.length
      ? visibleJobSource.filter((job) => job.operations.some((op) => selectedWorkcentre.includes(op.workcentreId)))
      : visibleJobSource;

    if (debouncedJobSearch.trim()) {
      const q = debouncedJobSearch.trim().toLowerCase();
      list = list.filter(
        (j) =>
          j.jobId.toLowerCase().includes(q) ||
          j.itemCode.toLowerCase().includes(q) ||
          (j.description || '').toLowerCase().includes(q)
      );
    }

    if (jobStatusFilter !== 'all') {
      list = list.filter((j) => String(j.status).toLowerCase() === jobStatusFilter.toLowerCase());
    }

    if (jobWcFilter !== 'all') {
      list = list.filter((j) => j.operations.some((op) => op.workcentreId === jobWcFilter));
    }

    if (scheduleFilter !== 'all') {
      list = list.filter((j) => getJobScheduleStatus(j) === scheduleFilter);
    }

    if (workflowJobFilter !== 'all') {
      const today = new Date();
      today.setHours(0, 0, 0, 0);
      const nextMonth = new Date(today);
      nextMonth.setMonth(nextMonth.getMonth() + 1);

      list = list.filter((job) => {
        const due = new Date(job.dueDate);
        const dueMs = due.getTime();
        if (!Number.isFinite(dueMs)) return false;

        if (workflowJobFilter === 'unscheduled') {
          return getJobScheduleStatus(job) === 'not-scheduled';
        }
        if (workflowJobFilter === 'past-due') {
          return dueMs < today.getTime();
        }
        if (workflowJobFilter === 'short-term') {
          return dueMs < nextMonth.getTime();
        }
        if (workflowJobFilter === 'long-term') {
          return dueMs >= nextMonth.getTime();
        }
        return true;
      });
    }

    if (advancedFilter || advancedSort.length) {
      const advCtx = {
        scheduleStatus: (job: Job) => { const st = getJobScheduleStatus(job); return st === 'scheduled' ? 'Scheduled' : st === 'partial' ? 'Partial' : 'Not Scheduled'; },
        materialStatus: (job: Job) => getJobMaterialStatus(job),
      };
      if (advancedFilter) list = list.filter((job) => jobMatchesFilter(job, advancedFilter, advCtx));
      if (advancedSort.length) list = applyAdvancedSort(list, advancedSort, advCtx);
    }

    return list;
  }, [visibleJobSource, selectedWorkcentre, debouncedJobSearch, jobStatusFilter, jobWcFilter, scheduleFilter, workflowJobFilter, getJobScheduleStatus, advancedFilter, advancedSort, getJobMaterialStatus]);

  const masterJobGroups = useMemo(() => {
    const jobsById = new Map(visibleJobSource.map((job) => [job.jobId, job] as const));
    const referencedMasterIds = new Set<string>();

    for (const job of visibleJobSource) {
      const rootId = getMasterRootJobId(job);
      if (rootId !== job.jobId) {
        referencedMasterIds.add(rootId);
      }
    }

    const visibleMasterIds = new Set<string>();
    for (const job of filteredJobs) {
      const rootId = getMasterRootJobId(job);
      if (rootId !== job.jobId) {
        visibleMasterIds.add(rootId);
      } else if (referencedMasterIds.has(job.jobId)) {
        visibleMasterIds.add(job.jobId);
      }
    }

    return Array.from(visibleMasterIds)
      .map((masterId) => {
        const familyJobs = visibleJobSource.filter((job) => {
          const rootId = getMasterRootJobId(job);
          return job.jobId === masterId || rootId === masterId;
        });

        const realMaster = jobsById.get(masterId);
        const referenceJob = realMaster || familyJobs[0];
        if (!referenceJob) return null;

        const subJobs = familyJobs
          .filter((job) => job.jobId !== masterId)
          .sort((a, b) => {
            const aDue = new Date(a.dueDate).getTime() || 0;
            const bDue = new Date(b.dueDate).getTime() || 0;
            return (a.priority - b.priority) || (aDue - bDue) || a.jobId.localeCompare(b.jobId);
          });

        if (subJobs.length === 0) return null;

        const aggregateDue = new Date(Math.max(...familyJobs.map((job) => new Date(job.dueDate).getTime() || 0)));
        const aggregateQty = familyJobs.reduce((sum, job) => sum + (Number(job.quantity) || 0), 0);
        const aggregatedOperations: Operation[] = realMaster?.operations?.length
          ? ([...realMaster.operations] as Operation[])
          : subJobs.flatMap((job) => (job.operations || []) as Operation[]);

        const master = {
          ...(referenceJob as Job),
          jobId: masterId,
          description: realMaster?.description || referenceJob.description || `Master Job ${masterId}`,
          quantity: aggregateQty,
          dueDate: aggregateDue,
          status: referenceJob.status,
          operations: aggregatedOperations
        } as Job;

        return { master, subJobs };
      })
      .filter((group): group is { master: Job; subJobs: Job[] } => !!group)
      .sort((a, b) => {
        const aDue = new Date(a.master.dueDate).getTime() || 0;
        const bDue = new Date(b.master.dueDate).getTime() || 0;
        return (a.master.priority - b.master.priority) || (aDue - bDue) || a.master.jobId.localeCompare(b.master.jobId);
      });
  }, [filteredJobs, visibleJobSource, getMasterRootJobId]);

  useEffect(() => {
    if (!visibleJobSource.length) return;

    const hasSelectedWorkcentreMatch =
      !selectedWorkcentre.length ||
      visibleJobSource.some((job) => job.operations.some((op) => selectedWorkcentre.includes(op.workcentreId)));

    const hasStatusMatch =
      jobStatusFilter === 'all' ||
      visibleJobSource.some((job) => String(job.status).toLowerCase() === jobStatusFilter.toLowerCase());

    const hasWorkcentreFilterMatch =
      jobWcFilter === 'all' ||
      visibleJobSource.some((job) => job.operations.some((op) => op.workcentreId === jobWcFilter));

    if (!hasSelectedWorkcentreMatch) {
      setSelectedWorkcentre([]);
    }
    if (!hasStatusMatch) {
      setJobStatusFilter('all');
    }
    if (!hasWorkcentreFilterMatch) {
      setJobWcFilter('all');
    }
  }, [visibleJobSource, selectedWorkcentre, jobStatusFilter, jobWcFilter, scheduleFilter]);

  useEffect(() => {
    if (!visibleJobSource.length) return;
    if (filteredJobs.length > 0) return;
    if (!selectedWorkcentre.length && !debouncedJobSearch.trim() && jobStatusFilter === 'all' && jobWcFilter === 'all' && scheduleFilter === 'all' && workflowJobFilter === 'all') return;

    // Keep the user's search/filter choices intact even when no rows match.
    // The grid already shows a clear empty-state message and manual reset button.
  }, [filteredJobs.length, visibleJobSource.length, selectedWorkcentre, debouncedJobSearch, jobStatusFilter, jobWcFilter, scheduleFilter, workflowJobFilter]);

  // Auto-retry: if openJobs is empty after load, retry up to 3 times with increasing delay
  useEffect(() => {
    if (openJobs.length > 0) {
      jobLoadRetryRef.current = 0;
      return;
    }
    if (dataLoading || isGeneratingSchedule) return;
    if (jobLoadRetryRef.current >= 3) return;

    const delay = (jobLoadRetryRef.current + 1) * 3000; // 3s, 6s, 9s
    const retryTimer = setTimeout(() => {
      jobLoadRetryRef.current += 1;
      console.log(`🔄 Auto-retrying job load (attempt ${jobLoadRetryRef.current}/3)...`);
      loadJobsAndResources();
    }, delay);

    return () => clearTimeout(retryTimer);
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [openJobs.length, dataLoading, isGeneratingSchedule]);

  // What-If handlers
  const createWhatIfScenario = () => {
    if (!schedule) return;
    const copy = JSON.parse(JSON.stringify(schedule)) as Schedule;
    copy.scheduleId = `whatif-${Date.now()}`;
    copy.status = 'Draft';
    copy.scheduledDate = new Date();
    setWhatIfSchedule(convertScheduleDates(copy));
    setWhatIfLabel(`Based on ${schedule.scheduleId} @ ${new Date().toLocaleTimeString()}`);
    toast.success('What-if scenario created');
  };

  const clearWhatIfScenario = () => {
    setWhatIfSchedule(null);
    setWhatIfLabel('');
    toast.success('What-if scenario cleared');
  };

  // Get all unique workcentres for filter dropdown
  const allWorkcentreIds = useMemo(() =>
    Array.from(new Set([
      ...openJobs.flatMap((j) => j.operations.map((o) => o.workcentreId)),
      ...Object.keys(workcentreGroups)
    ])).sort(),
    [openJobs, workcentreGroups]
  );

  const machineOptionsByWorkcentre = useMemo(() => {
    const map: Record<string, Set<string>> = {};

    // From operations data (ScheduledMachine / IMachine / qualifiedResourceIds)
    openJobs.forEach((job) => {
      (job.operations || []).forEach((op) => {
        const wc = String(op.workcentreId || '').trim();
        if (!wc) return;
        if (!map[wc]) map[wc] = new Set();
        const candidates = [
          ...(Array.isArray(op.qualifiedResourceIds) ? op.qualifiedResourceIds : []),
          String((op as any).ScheduledMachine || '').trim(),
          String((op as any).IMachine || '').trim()
        ].filter((id) => id && id !== wc); // exclude WC code itself
        candidates.forEach((id) => map[wc].add(id));
      });
    });

    // From resources (SY_Resource + discovered machines)
    for (const [wc, machines] of Object.entries(workcentreGroups)) {
      if (!map[wc]) map[wc] = new Set();
      machines.forEach((m) => {
        if (m.resourceId !== wc) map[wc].add(m.resourceId);
      });
    }

    // Convert Sets to sorted arrays
    const result: Record<string, string[]> = {};
    for (const [wc, set] of Object.entries(map)) {
      result[wc] = Array.from(set).sort();
    }
    return result;
  }, [openJobs, workcentreGroups]);

  // saveAlternativeGroup and removeAlternativeGroup are provided by useJobsData().

  // dynamicDbColumns, allJobColumns, orderedVisibleColumns, allOperationColumns,
  // saveColumnProfile, handleColDragStart, handleColDrop, formatGridColumnValue,
  // formatJobColumnValue, formatOperationColumnValue, toggleJobColumn, toggleOperationColumn
  // and column-related useEffects are all provided by useColumnManager().

  const toggleJobExpanded = (jobId: string) => {
    setExpandedJobs((prev) => ({ ...prev, [jobId]: !prev[jobId] }));
  };

  const getCalendarForWorkcentre = (workcentreId: string) => {
    return resources.find((resource) => resource.worcentreId === workcentreId || resource.resourceId === workcentreId)?.calendar;
  };

  const getSchedulingHorizonBounds = (override?: { start: string; end: string }) => {
    const startValue = override?.start || schedulingHorizon.start;
    const endValue = override?.end || schedulingHorizon.end;
    const startDate = new Date(`${startValue}T00:00:00`);
    const endDate = new Date(`${endValue}T23:59:59.999`);
    return {
      startDate,
      endDate,
      startMs: startDate.getTime(),
      endMs: endDate.getTime()
    };
  };

  // Productive-window math extracted to utils/calendarWindows.ts (unit-tested).
  // These wrappers bind the App's calendar lookup + current horizon bounds.
  const calendarWindowEnv = (): CalendarWindowEnv => {
    const { startMs, endMs } = getSchedulingHorizonBounds();
    return { getCalendar: getCalendarForWorkcentre, horizonStartMs: startMs, horizonEndMs: endMs };
  };

  const alignToProductiveWindow = (candidateMs: number, _bookedMs: number, workcentreId: string): number =>
    alignToProductiveWindowUtil(calendarWindowEnv(), candidateMs, workcentreId);

  const calculateProductiveEndMs = (startMs: number, bookedMs: number, workcentreId: string): number =>
    calculateProductiveEndMsUtil(calendarWindowEnv(), startMs, bookedMs, workcentreId);

  const autoScheduleDroppedJob = async (jobId: string, dropDate: Date, droppedOnWorkcentre: string, machineId?: string) => {
    try {
      const job = openJobs.find((j) => j.jobId === jobId);
      if (!job) {
        toast.error('Job not found in production list');
        return;
      }
      if (!job.operations?.length) {
        toast.error('Selected job has no operations to schedule');
        return;
      }

      const definitionsResponse = await resourceService.getDefinitions().catch(() => ({ definitions: [] as any[] }));
      const quantityByWorkcentre: Record<string, number> = {};
      for (const definition of definitionsResponse.definitions || []) {
        const wc = String(definition.workcentreId || '');
        if (!wc) continue;
        if (definition.activated === false) continue;
        const qty = Math.max(1, Number(definition.quantity || 1));
        quantityByWorkcentre[wc] = (quantityByWorkcentre[wc] || 0) + qty;
      }

      const horizonBounds = getSchedulingHorizonBounds({ start: boardIntervalStart, end: boardIntervalEnd });
      // Master/sub dependency guard (mirrors the engine rule): a master job may
      // not start before its already-scheduled sub-jobs finish. Clamp the drop
      // time forward and tell the planner instead of silently violating it.
      let dropMs = new Date(dropDate).getTime();
      const masterClamp = clampMasterDropStart(jobId, dropMs, masterParentMap, schedule);
      if (masterClamp.blockingSubJobId) {
        dropMs = masterClamp.clampedStartMs + 60_000;
        toast(
          `${jobId} is a master job — start moved to after sub-job ${masterClamp.blockingSubJobId} finishes (${new Date(dropMs).toLocaleString()})`,
          { icon: 'ℹ️', duration: 6000 }
        );
      }
      // If the user drops past the planning horizon, extend the effective window to
      // cover the drop position + 90-day buffer. The horizon is a guide, not a wall.
      if (dropMs > horizonBounds.endMs) {
        horizonBounds.endMs = dropMs + 90 * 24 * 60 * 60 * 1000;
        horizonBounds.endDate = new Date(horizonBounds.endMs);
      }
      const baselineStart = new Date(Math.max(dropMs, horizonBounds.startMs));

      const baseSchedule: Schedule = schedule
        ? convertScheduleDates(schedule)
        : {
            scheduleId: `manual-${Date.now()}`,
            scheduledDate: new Date(),
            version: 1,
            status: 'Draft',
            planningHorizon: {
              startDate: horizonBounds.startDate,
              endDate: horizonBounds.endDate
            },
            jobSchedules: [],
            resourceLoads: [],
            constraintViolations: [],
            metrics: {
              totalJobsScheduled: 0,
              jobsOnTime: 0,
              jobsTardy: 0,
              averageTardiness: 0,
              resourceUtilization: 0,
              overtimeHours: 0,
              criticalPathLength: 0,
              totalSetupTime: 0,
              totalQueueTime: 0,
              totalMoveTime: 0
            }
          };

      type Interval = { start: number; end: number };
      const intervalsByWorkcentre = new Map<string, Interval[]>();

      for (const js of baseSchedule.jobSchedules) {
        if (js.jobId === job.jobId) continue;
        for (const op of js.operationSchedules) {
          const key = op.workcentreId;
          if (!intervalsByWorkcentre.has(key)) {
            intervalsByWorkcentre.set(key, []);
          }
          intervalsByWorkcentre.get(key)!.push({
            start: new Date(op.plannedStartDate).getTime(),
            end: new Date(op.plannedEndDate).getTime()
          });
        }
      }

      // Slot maths extracted to utils/slotFinder.ts (unit-tested; behaviour
      // preserved — the old inline "re-insert candidate" branch was dead code
      // because every relevant interval end is pre-seeded as a candidate).
      const findEarliestSlot = (
        desiredStartMs: number,
        durationMs: number,
        intervals: Interval[],
        capacity: number,
        workcentreId: string
      ): number | null =>
        findEarliestSlotWithRetry({
          desiredStartMs,
          durationMs,
          intervals,
          capacity,
          workcentreId,
          horizonStartMs: horizonBounds.startMs,
          horizonEndMs: horizonBounds.endMs,
          adapters: { align: alignToProductiveWindow, productiveEnd: calculateProductiveEndMs },
          onForcedPlacement: (wc) =>
            toast(`⚠ ${wc}: no free calendar slot found — job placed outside normal shift hours`, { icon: '⚠️' }),
        });

      const sortedOps = job.operations.slice().sort((a, b) => a.sequence - b.sequence);

      // Find the first op that runs on the dropped workcentre — this is the "anchor".
      // The anchor op should start as close to the drop time as possible.
      // Preceding ops (before the anchor) are back-scheduled so they finish by the drop time.
      const anchorIdx = (() => {
        const idx = sortedOps.findIndex(op => (op.workcentreId || droppedOnWorkcentre) === droppedOnWorkcentre);
        return idx >= 0 ? idx : 0; // fallback: treat op0 as anchor if none match
      })();

      // Estimate wall-clock duration of ops BEFORE the anchor (raw minutes, no calendar).
      // This lets us start the chain early enough for the anchor to land at the drop time.
      let estimatedPrecedingMs = 0;
      for (let i = 0; i < anchorIdx; i++) {
        const op = sortedOps[i];
        estimatedPrecedingMs += (
          Math.max(0, Number(op.queueTime) || 0) +
          Math.max(0, Number(op.setupTime) || 0) +
          Math.max(1, Number(op.duration) || 1) +
          Math.max(0, Number(op.moveTime) || 0)
        ) * 60 * 1000;
      }

      // Start the chain early enough that preceding ops can finish by the drop time.
      const chainStartMs = Math.max(horizonBounds.startMs, baselineStart.getTime() - estimatedPrecedingMs);
      let precedenceCursorMs = chainStartMs;
      const operationSchedules: OperationSchedule[] = [];

      for (const [index, op] of sortedOps.entries()) {
        const durationMinutes = Math.max(Number(op.duration) || 1, 1);
        const setupMinutes = Math.max(Number(op.setupTime) || 0, 0);
        const queueMinutes = Math.max(Number(op.queueTime) || 0, 0);
        const moveMinutes = Math.max(Number(op.moveTime) || 0, 0);
        const bookedMinutes = setupMinutes + durationMinutes;
        const durationMs = bookedMinutes * 60 * 1000;

        const wc = op.workcentreId || droppedOnWorkcentre;
        const capacity = 1; // one operation at a time per production line
        const intervals = intervalsByWorkcentre.get(wc) || [];
        const alternativeMachines = alternativeGroups
          .filter((group) => group.workcentreId === wc)
          .flatMap((group) => group.machineIds || []);
        const candidateMachines = Array.from(new Set([...(op.qualifiedResourceIds || []), ...alternativeMachines].filter(Boolean)));
        // Fallback machine: prefer the dropped machine (for ops on the dropped WC),
        // then the first qualified resource, then the workcentre ID itself.
        // Using the workcentre ID as the resourceId would make the bar invisible in
        // machine-lane rendering (lanes are keyed by resourceId, not worcentreId).
        const fallbackMachine = (machineId && wc === droppedOnWorkcentre) ? machineId : wc;
        // The user dropped the job on a SPECIFIC machine lane. The anchor
        // operation (the one whose workcentre matches the dropped lane) must
        // land on that exact machine — otherwise the bar appears in a
        // different lane (or, if the chosen qualified resource isn't a
        // rendered lane, nowhere at all), which looks like the drop failed.
        // Non-anchor operations keep the qualified-resource rotation so that
        // a multi-op job still spreads across its qualified machines.
        const isAnchorOp = index === anchorIdx;
        const droppedMachinePreferred = isAnchorOp && machineId && wc === droppedOnWorkcentre;
        const assignedMachine = droppedMachinePreferred
          ? machineId
          : (candidateMachines[index % Math.max(1, candidateMachines.length)] || fallbackMachine);

        // Compute desired start:
        // - For the anchor op, honour the drop time as the minimum (the op lands where dropped, or next free slot).
        // - For preceding ops, chain from chainStartMs so they finish in time for the anchor.
        // - For ops after the anchor, chain sequentially from the previous op's end.
        const arrivalMs = index === 0 ? chainStartMs : precedenceCursorMs;
        const effectiveArrivalMs = index === anchorIdx
          ? Math.max(arrivalMs, baselineStart.getTime())
          : arrivalMs;
        const desiredStartMs = effectiveArrivalMs + queueMinutes * 60000;

        const startMs = findEarliestSlot(desiredStartMs, durationMs, intervals, capacity, wc);
        if (startMs === null) {
          toast.error(`Job ${job.jobId} cannot fit within the selected Start and End dates`);
          return;
        }
        const endMs = calculateProductiveEndMs(startMs, durationMs, wc);

        intervals.push({ start: startMs, end: endMs });
        intervalsByWorkcentre.set(wc, intervals);

        const setupStart = new Date(startMs);
        const setupEndMs = calculateProductiveEndMs(startMs, setupMinutes * 60000, wc);
        const setupEnd = new Date(setupEndMs);
        const runStart = new Date(setupEndMs);
        const runEndMs = calculateProductiveEndMs(setupEndMs, durationMinutes * 60000, wc);
        const runEnd = new Date(runEndMs);
        const queueEndDate = new Date(setupStart.getTime());
        const moveEndDate = new Date(runEndMs + moveMinutes * 60000);
        precedenceCursorMs = moveEndDate.getTime();

        operationSchedules.push({
          opId: String(op.opId),
          workcentreId: wc,
          resourceId: assignedMachine,
          plannedStartDate: new Date(startMs),
          plannedEndDate: new Date(endMs),
          duration: bookedMinutes,
          setupTime: setupMinutes,
          runTime: durationMinutes,
          queueTime: queueMinutes,
          moveTime: moveMinutes,
          setupStart,
          setupEnd,
          runStart,
          runEnd,
          queueEnd: queueEndDate,
          moveEnd: moveEndDate,
          sequence: op.sequence,
          isOvertimeSlot: false,
          batchSize: op.batchSize || 1,
          slackTime: 0
        });
      }

      const jobSchedule: JobSchedule = {
        jobId: job.jobId,
        plannedStartDate: operationSchedules[0].plannedStartDate,
        plannedEndDate: operationSchedules[operationSchedules.length - 1].plannedEndDate,
        operationSchedules,
        estimatedTardiness: 0,
        status: 'Scheduled'
      };

      // Non-blocking dependency check on the final placement: catches the
      // cases the drop-time clamp can't (back-scheduled leading ops of a
      // master, or a sub-job now ending after its master starts).
      const depWarning = describeDependencyViolation(
        job.jobId,
        jobSchedule.plannedStartDate.getTime(),
        jobSchedule.plannedEndDate.getTime(),
        masterParentMap,
        baseSchedule
      );
      if (depWarning) {
        toast(`⚠ ${depWarning}`, { icon: '⚠️', duration: 7000 });
      }

      const mergedJobs = [
        ...baseSchedule.jobSchedules.filter((j) => j.jobId !== job.jobId),
        jobSchedule
      ].sort((a, b) => a.plannedStartDate.getTime() - b.plannedStartDate.getTime());

      const updatedSchedule: Schedule = {
        ...baseSchedule,
        jobSchedules: mergedJobs,
        metrics: {
          ...baseSchedule.metrics,
          totalJobsScheduled: mergedJobs.length
        }
      };

      setSchedule(updatedSchedule);
      markScheduleEdited();
      undoRedoManager.addState(updatedSchedule, `Dropped ${job.jobId} on ${droppedOnWorkcentre}`);
      const firstOp = operationSchedules[0];
      const anchorOp = operationSchedules[anchorIdx] ?? firstOp;

      // Keep the board focused: highlight the just-scheduled job, focus the
      // correct workcentre lane on the Gantt, and switch to the Gantt tab.
      setHighlightJobId(job.jobId);
      if (anchorOp?.workcentreId) {
        // Drive MachineGanttBoard's internal lane filter via the focusWorkcentre prop.
        setGanttFocusWorkcentre(anchorOp.workcentreId);
        // Also keep the job-list workcentre filter in sync.
        setSelectedWorkcentre((prev) =>
          prev.includes(anchorOp.workcentreId) ? prev : [anchorOp.workcentreId]
        );
      }
      setContentTab('gantt');

      toast.success(`${job.jobId} scheduled — ${anchorOp.workcentreId} starts ${new Date(anchorOp.plannedStartDate).toLocaleString()}`);
    } catch (error: any) {
      console.error('Autoschedule error:', error);
      toast.error(error.message || 'Failed to autoschedule job');
    }
  };

  /**
   * Click a job row in the Production Jobs grid:
   * - If scheduled → highlight it and switch the lower panel to the Gantt tab so it scrolls into view.
   * - If not scheduled → just toggle the row highlight.
   * - Second click on already-highlighted job → deselect.
   */
  const handleJobRowClick = (jobId: string) => {
    if (highlightJobId === jobId) {
      // Second click on the same job: clear the focus AND the lane filter.
      setHighlightJobId(null);
      setGanttFocusWorkcentre(null);
      setSelectedWorkcentre([]);
      return;
    }
    setHighlightJobId(jobId);

    const jobSchedule = schedule?.jobSchedules.find((j) => j.jobId === jobId);
    const job = openJobs.find((j) => j.jobId === jobId);

    // Every workcentre the job uses (scheduled ops) or might use (routing),
    // in execution order — the Gantt shows ALL of these lanes.
    const scheduledWcs = jobSchedule
      ? [...jobSchedule.operationSchedules]
          .sort((a, b) => new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime())
          .map((op) => op.workcentreId)
      : [];
    const routingWcs = job
      ? [...(job.operations || [])].sort((a, b) => a.sequence - b.sequence).map((op) => op.workcentreId)
      : [];
    const wcs = Array.from(new Set((scheduledWcs.length ? scheduledWcs : routingWcs).filter(Boolean)));

    if (wcs.length) {
      // Override the app-level workcentre filter: ContentTabPanel only hands
      // the Gantt resources for `selectedWorkcentre`, so a previously applied
      // filter would hide the other lanes this job needs. A job click must
      // ALWAYS bring every workcentre/machine the job uses into view.
      setSelectedWorkcentre(wcs);
    }
    setGanttFocusWorkcentre(wcs.length ? wcs : null);
    setContentTab('gantt');

    if (!jobSchedule && wcs.length) {
      toast(`${jobId} is not scheduled yet — showing the ${wcs.length} machine lane${wcs.length === 1 ? '' : 's'} it may use`, { icon: 'ℹ️' });
    }
  };

  const openJobContextMenu = (e: React.MouseEvent, jobId: string) => {
    e.preventDefault();
    setJobContextMenu({
      visible: true,
      x: e.clientX,
      y: e.clientY,
      jobId
    });
  };

  const closeJobContextMenu = () => {
    setJobContextMenu((prev) => ({ ...prev, visible: false, jobId: null }));
  };

  const unscheduleJob = (jobId: string) => {
    if (!schedule) return;
    const updatedSchedule = {
      ...schedule,
      jobSchedules: schedule.jobSchedules.filter((j) => j.jobId !== jobId),
      metrics: {
        ...schedule.metrics,
        totalJobsScheduled: Math.max(0, schedule.jobSchedules.length - 1)
      }
    };
    setSchedule(updatedSchedule);
    markScheduleEdited();
    undoRedoManager.addState(updatedSchedule, `Unscheduled ${jobId}`);
    toast.success(`Job ${jobId} unscheduled`);
  };

  /**
   * Schedule a single operation from the Production Jobs grid.
   * Finds the next available slot on the operation's workcentre and places it
   * in the schedule without touching any other operations.
   */
  const autoScheduleSingleOperation = async (job: Job, opId: string) => {
    const op = job.operations.find((o) => String(o.opId) === String(opId));
    if (!op) { toast.error(`Operation ${opId} not found`); return; }

    const wc: string = (op as any).workcentreId || (op as any).workCentre || '';
    if (!wc) { toast.error(`Operation ${opId} has no workcentre assigned`); return; }

    const baseSchedule = schedule ? convertScheduleDates(schedule) : {
      jobSchedules: [] as JobSchedule[],
      resourceLoads: [],
      constraintViolations: [],
      metrics: { totalJobsScheduled: 0, totalOpsScheduled: 0, averageLateness: 0, onTimeRate: 0, utilizationRate: 0, criticalPathLength: 0 }
    };

    const horizonBounds = getSchedulingHorizonBounds({ start: boardIntervalStart, end: boardIntervalEnd });
    const searchFromMs = Math.max(Date.now(), horizonBounds.startMs);
    if (searchFromMs > horizonBounds.endMs) {
      horizonBounds.endMs = searchFromMs + 90 * 24 * 60 * 60 * 1000;
    }

    // Build intervals for this workcentre, skipping this op if already scheduled.
    type Interval = { start: number; end: number };
    const intervals: Interval[] = [];
    for (const js of baseSchedule.jobSchedules) {
      for (const existingOp of js.operationSchedules) {
        if (js.jobId === job.jobId && String(existingOp.opId) === String(opId)) continue;
        if (String(existingOp.workcentreId) !== wc) continue;
        intervals.push({
          start: new Date(existingOp.plannedStartDate).getTime(),
          end: new Date(existingOp.plannedEndDate).getTime()
        });
      }
    }

    // One operation at a time per production line (workcentre capacity = 1),
    // matching the auto-scheduler. Manual drops snap to the next free slot
    // rather than overlapping another operation on the same line.
    const capacity = 1;

    const setupMinutes = Math.max(0, Number((op as any).setupTime || 0));
    const runMinutes   = Math.max(1, Number((op as any).runTime || (op as any).duration || 1));
    const queueMinutes = Math.max(0, Number((op as any).queueTime || 0));
    const moveMinutes  = Math.max(0, Number((op as any).moveTime || 0));
    const bookedMinutes = setupMinutes + runMinutes;
    const durationMs   = bookedMinutes * 60_000;

    // Capacity-aware slot check.
    const canFitHere = (startMs: number, endMs: number): boolean => {
      let concurrent = 0;
      for (const iv of intervals) {
        if (iv.start < endMs && iv.end > startMs) concurrent++;
        if (concurrent >= capacity) return false;
      }
      return true;
    };

    // Gather candidates: desired start + all interval ends after desired start.
    const candidateSet = new Set<number>([searchFromMs]);
    for (const iv of intervals) {
      if (iv.end >= searchFromMs) candidateSet.add(iv.end);
    }
    const candidates = Array.from(candidateSet).sort((a, b) => a - b);

    let startMs: number = searchFromMs;
    let placed = false;
    for (const c of candidates) {
      if (canFitHere(c, c + durationMs)) { startMs = c; placed = true; break; }
    }
    if (!placed) {
      // Fall back to after the last booked slot.
      const lastEnd = intervals.length > 0 ? Math.max(...intervals.map((iv) => iv.end)) : searchFromMs;
      startMs = Math.max(searchFromMs, lastEnd);
    }

    const endMs       = startMs + durationMs;
    const setupEndMs  = startMs + setupMinutes * 60_000;

    // Pick assigned machine.
    const altMachines = alternativeGroups
      .filter((g) => g.workcentreId === wc)
      .flatMap((g) => g.machineIds || []);
    const candidateMachines = Array.from(new Set([...((op as any).qualifiedResourceIds || []), ...altMachines].filter(Boolean)));
    const assignedMachine = candidateMachines[0] || wc;

    const opSchedule: OperationSchedule = {
      opId:             String(op.opId),
      workcentreId:     wc,
      resourceId:       assignedMachine,
      plannedStartDate: new Date(startMs),
      plannedEndDate:   new Date(endMs),
      duration:         bookedMinutes,
      setupTime:        setupMinutes,
      runTime:          runMinutes,
      queueTime:        queueMinutes,
      moveTime:         moveMinutes,
      setupStart:       new Date(startMs),
      setupEnd:         new Date(setupEndMs),
      runStart:         new Date(setupEndMs),
      runEnd:           new Date(endMs),
      queueEnd:         new Date(startMs),
      moveEnd:          new Date(endMs + moveMinutes * 60_000),
      sequence:         (op as any).sequence ?? 0,
      isOvertimeSlot:   false,
      batchSize:        (op as any).batchSize || 1,
      slackTime:        0
    };

    // Upsert: merge with any existing JobSchedule for this job.
    const existingJS = baseSchedule.jobSchedules.find((j) => j.jobId === job.jobId);
    let newJobSched: JobSchedule;
    if (existingJS) {
      const updatedOps = [
        ...existingJS.operationSchedules.filter((o) => String(o.opId) !== String(opId)),
        opSchedule
      ].sort((a, b) => (a.sequence ?? 0) - (b.sequence ?? 0));
      const starts = updatedOps.map((o) => new Date(o.plannedStartDate).getTime());
      const ends   = updatedOps.map((o) => new Date(o.plannedEndDate).getTime());
      newJobSched = {
        ...existingJS,
        operationSchedules: updatedOps,
        plannedStartDate: new Date(Math.min(...starts)),
        plannedEndDate:   new Date(Math.max(...ends))
      };
    } else {
      newJobSched = {
        jobId: job.jobId,
        plannedStartDate: opSchedule.plannedStartDate,
        plannedEndDate:   opSchedule.plannedEndDate,
        operationSchedules: [opSchedule],
        estimatedTardiness: 0,
        status: 'Scheduled'
      };
    }

    const mergedJobs = [
      ...baseSchedule.jobSchedules.filter((j) => j.jobId !== job.jobId),
      newJobSched
    ].sort((a, b) => new Date(a.plannedStartDate).getTime() - new Date(b.plannedStartDate).getTime());

    const updatedSchedule: Schedule = {
      ...(baseSchedule as Schedule),
      jobSchedules: mergedJobs,
      metrics: { ...(baseSchedule as Schedule).metrics, totalJobsScheduled: mergedJobs.length }
    };

    setSchedule(updatedSchedule);
    markScheduleEdited();
    undoRedoManager.addState(updatedSchedule, `Scheduled op ${opId} of ${job.jobId}`);
    toast.success(`Op ${opId} → ${wc} at ${new Date(startMs).toLocaleString()}`);
  };

  // Keep the ref in sync so renderOperationsTable (defined above) can call this.
  scheduleOpRef.current = autoScheduleSingleOperation;

  const scheduleAroundJob = async (jobId: string, mode: 'left' | 'right' | 'both' | 'master') => {
    const selectedJob = openJobs.find((j) => j.jobId === jobId) || visibleJobSource.find((j) => j.jobId === jobId);
    if (!selectedJob) {
      toast.error('Select a valid job first');
      return;
    }

    const { startMs, endMs } = getSchedulingHorizonBounds();
    const spanMs = Math.max(24 * 60 * 60 * 1000, endMs - startMs);
    const dueMsRaw = new Date(selectedJob.dueDate).getTime();
    const dueMs = Number.isFinite(dueMsRaw)
      ? Math.min(endMs - 60 * 1000, Math.max(startMs, dueMsRaw))
      : startMs + Math.floor(spanMs / 2);

    const getAnchorDate = (anchorMode: 'left' | 'right' | 'both', offsetIndex = 0) => {
      let anchorMs = dueMs;
      if (anchorMode === 'left') anchorMs = Math.max(startMs, dueMs - Math.floor(spanMs * 0.35));
      if (anchorMode === 'right') anchorMs = Math.min(endMs - 60 * 1000, dueMs + Math.floor(spanMs * 0.05));
      if (anchorMode === 'both') anchorMs = Math.max(startMs, dueMs - Math.floor(spanMs * 0.18));
      anchorMs = Math.min(endMs - 60 * 1000, anchorMs + offsetIndex * 60 * 60 * 1000);
      return new Date(anchorMs);
    };

    if (mode === 'master') {
      const masterRootId = getMasterRootJobId(selectedJob);
      const familyJobs = visibleJobSource
        .filter((job) => getMasterRootJobId(job) === masterRootId || job.jobId === masterRootId)
        .sort((a, b) => {
          const aRank = a.jobId === masterRootId ? 0 : 1;
          const bRank = b.jobId === masterRootId ? 0 : 1;
          const aDue = new Date(a.dueDate).getTime() || 0;
          const bDue = new Date(b.dueDate).getTime() || 0;
          return (aRank - bRank) || (a.priority - b.priority) || (aDue - bDue) || a.jobId.localeCompare(b.jobId);
        });

      if (!familyJobs.length) {
        toast.error('No master job family found');
        return;
      }

      // Master/sub precedence (mirrors the engine rule): place every sub-job
      // first, then anchor the master after the latest sub-job end so it can
      // never start before the jobs that feed it are complete.
      const subJobs = familyJobs.filter((j) => j.jobId !== masterRootId);
      const masterJob = familyJobs.find((j) => j.jobId === masterRootId);

      for (const [index, familyJob] of subJobs.entries()) {
        const primaryWorkcentre = familyJob.operations?.[0]?.workcentreId || resources[0]?.worcentreId || 'GEN';
        await autoScheduleDroppedJob(familyJob.jobId, getAnchorDate('both', index), primaryWorkcentre);
      }

      if (masterJob) {
        // Read fresh store state — autoScheduleDroppedJob has already merged
        // the sub-job placements into the schedule by the time it resolves.
        const current = useScheduleStore.getState().schedule;
        let latestSubEndMs = 0;
        for (const sub of subJobs) {
          const js = current?.jobSchedules.find((j) => j.jobId === sub.jobId);
          if (js) latestSubEndMs = Math.max(latestSubEndMs, new Date(js.plannedEndDate).getTime());
        }
        const masterAnchor = latestSubEndMs > 0
          ? new Date(latestSubEndMs + 60 * 1000)
          : getAnchorDate('both', subJobs.length);
        const primaryWorkcentre = masterJob.operations?.[0]?.workcentreId || resources[0]?.worcentreId || 'GEN';
        await autoScheduleDroppedJob(masterJob.jobId, masterAnchor, primaryWorkcentre);
      }

      toast.success(`Scheduled master job group ${masterRootId} — sub-jobs first, master after`);
      return;
    }

    const primaryWorkcentre = selectedJob.operations?.[0]?.workcentreId || resources[0]?.worcentreId || 'GEN';
    await autoScheduleDroppedJob(jobId, getAnchorDate(mode), primaryWorkcentre);
  };

  // Wired to a button planned for the ribbon; not bound yet but kept ready.
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  const handleScheduleAround = async () => {
    const targetJobId = highlightJobId || jobContextMenu.jobId;
    if (!targetJobId) {
      toast.error('Select or right-click a job first');
      return;
    }
    await scheduleAroundJob(targetJobId, scheduleAroundMode);
  };

  const executeJobContextCommand = async (command: string) => {
    const jobId = jobContextMenu.jobId;
    if (!jobId) return;

    const selectedJob = openJobs.find((j) => j.jobId === jobId);

    switch (command) {
      case 'autoschedule':
        openScheduleSetup([jobId]);
        break;
      case 'schedule-around':
        await scheduleAroundJob(jobId, scheduleAroundMode);
        break;
      case 'schedule-around-left':
        await scheduleAroundJob(jobId, 'left');
        break;
      case 'schedule-around-right':
        await scheduleAroundJob(jobId, 'right');
        break;
      case 'schedule-around-both':
        await scheduleAroundJob(jobId, 'both');
        break;
      case 'schedule-around-master':
        await scheduleAroundJob(jobId, 'master');
        break;
      case 'unschedule-selected':
        unscheduleJob(jobId);
        break;
      case 'edit-job':
        setManageTab('none');
        toggleJobExpanded(jobId);
        toast.success(`Editing ${jobId}`);
        break;
      case 'load-required-machines':
        if (selectedJob?.operations?.length) {
          setSelectedWorkcentre([selectedJob.operations[0].workcentreId]);
          toast.success(`Loaded machines for ${jobId}`);
        } else {
          toast.error('No operation machines found for this job');
        }
        break;
      case 'unload-all-machines':
        setSelectedWorkcentre([]);
        toast.success('Machine filter reset');
        break;
      case 'highlight-object':
        if (selectedJob?.operations?.[0]) {
          setSelectedWorkcentre([selectedJob.operations[0].workcentreId]);
        }
        setExpandedJobs((prev) => ({ ...prev, [jobId]: true }));
        toast.success(`Highlighted ${jobId}`);
        break;
      case 'show-details':
        setExpandedJobs((prev) => ({ ...prev, [jobId]: true }));
        toast.success(`Showing details for ${jobId}`);
        break;
      case 'job-status':
        toast.success(`Job ${jobId} status: ${selectedJob?.status || 'Unknown'}`);
        break;
      case 'undo':
        handleUndo();
        break;
      case 'redo':
        handleRedo();
        break;
      case 'refresh':
        await loadJobsAndResources();
        toast.success('Jobs refreshed');
        break;
      case 'save-and-publish':
        await exportToSyspro();
        break;
      case 'load-machines':
        if (selectedJob?.operations?.[0]) {
          setSelectedWorkcentre([selectedJob.operations[0].workcentreId]);
          toast.success(`Loaded machine lane ${selectedJob.operations[0].workcentreId}`);
        }
        break;
      case 'material-planning':
        setContentTab('materials');
        setHighlightJobId(jobId);
        toast.success(`Showing materials for job ${jobId}`);
        break;
      case 'possible-errors': {
        const violations = schedule?.constraintViolations?.filter(v => v.affectedJobId === jobId) || [];
        if (violations.length > 0) {
          toast.error(`Job ${jobId}: ${violations.length} constraint violation(s) — check Constraints tab`);
          setContentTab('constraints');
        } else {
          toast.success(`No constraint violations found for job ${jobId}`);
        }
        break;
      }
      case 'pin':
        setPinnedJobIds(prev => {
          const next = new Set(prev);
          if (next.has(jobId)) { next.delete(jobId); toast.success(`Job ${jobId} unpinned`); }
          else { next.add(jobId); toast.success(`Job ${jobId} pinned — will not be moved by autoschedule`); }
          return next;
        });
        break;
      case 'deadline':
        setHighlightJobId(jobId);
        toast(`Job ${jobId} — due date: ${openJobs.find(j => j.jobId === jobId)?.dueDate || 'unknown'}`, { icon: '📅' });
        break;
      case 'actions':
        toast(`Actions for ${jobId}: Schedule Around, Pin, Exclude, View Materials`, { icon: '⚡', duration: 4000 });
        break;
      default:
        break;
    }

    closeJobContextMenu();
  };

  const handleDraggableMove = (opId: string, newStartDate: Date, newEndDate: Date) => {
    if (!schedule) return;

    const horizonBounds = getSchedulingHorizonBounds();
    if (newStartDate.getTime() < horizonBounds.startMs || newEndDate.getTime() > horizonBounds.endMs) {
      toast.error('Operation must stay within the selected Start and End dates');
      return;
    }

    const updatedJobSchedules = schedule.jobSchedules.map((job) => {
      const updatedOps = job.operationSchedules.map((op) =>
        op.opId === opId
          ? {
              ...op,
              plannedStartDate: newStartDate,
              plannedEndDate: newEndDate
            }
          : op
      );

      const hasUpdated = updatedOps.some((op) => op.opId === opId);
      if (!hasUpdated) return job;

      const opStarts = updatedOps.map((op) => new Date(op.plannedStartDate).getTime());
      const opEnds = updatedOps.map((op) => new Date(op.plannedEndDate).getTime());

      return {
        ...job,
        operationSchedules: updatedOps,
        plannedStartDate: new Date(Math.min(...opStarts)),
        plannedEndDate: new Date(Math.max(...opEnds))
      };
    });

    const updatedSchedule: Schedule = {
      ...schedule,
      jobSchedules: updatedJobSchedules
    };

    setSchedule(updatedSchedule);
    markScheduleEdited();
    undoRedoManager.addState(updatedSchedule, `Dragged operation ${opId}`);
    toast.success(`Operation ${opId} moved`);
  };

  const handleScheduleBoardOperationMove = async (
    jobId: string,
    opId: string,
    proposedStartDate: Date,
    droppedOnWorkcentre: string,
    droppedOnMachineId?: string
  ) => {
    if (!schedule) return;

    const working = convertScheduleDates(schedule);
    const targetJob = working.jobSchedules.find((j) => j.jobId === jobId);
    if (!targetJob) {
      toast.error(`Job ${jobId} not found in schedule`);
      return;
    }

    const sourceJob = openJobs.find((j) => j.jobId === jobId);
    const sequenceByOpId = new Map<string, number>();
    if (sourceJob?.operations?.length) {
      sourceJob.operations.forEach((op) => sequenceByOpId.set(String(op.opId), op.sequence));
    }

    const sortedOps = [...targetJob.operationSchedules].sort((a, b) => {
      const aSeq = sequenceByOpId.get(String(a.opId)) ?? Number(String(a.opId).replace(/\D/g, '')) ?? 999999;
      const bSeq = sequenceByOpId.get(String(b.opId)) ?? Number(String(b.opId).replace(/\D/g, '')) ?? 999999;
      return aSeq - bSeq;
    });

    const movedIdx = sortedOps.findIndex((op) => String(op.opId) === String(opId));
    if (movedIdx < 0) {
      toast.error(`Operation ${opId} not found`);
      return;
    }

    const movedOriginal = sortedOps[movedIdx];
    const horizonBounds = getSchedulingHorizonBounds({ start: boardIntervalStart, end: boardIntervalEnd });
    const predecessorEndMs = movedIdx > 0
      ? new Date(sortedOps[movedIdx - 1].plannedEndDate).getTime()
      : Number.NEGATIVE_INFINITY;
    let precedenceCursorMs = Math.max(new Date(proposedStartDate).getTime(), predecessorEndMs, horizonBounds.startMs);

    // Extend the working horizon when the user drops past the planning-horizon end.
    if (precedenceCursorMs > horizonBounds.endMs) {
      horizonBounds.endMs = precedenceCursorMs + 90 * 24 * 60 * 60 * 1000;
      (horizonBounds as any).endDate = new Date(horizonBounds.endMs);
    }

    const definitionsResponse = await resourceService.getDefinitions().catch(() => ({ definitions: [] as any[] }));
    const quantityByWorkcentre: Record<string, number> = {};
    for (const definition of definitionsResponse.definitions || []) {
      const wc = String(definition.workcentreId || '');
      if (!wc || definition.activated === false) continue;
      const qty = Math.max(1, Number(definition.quantity || 1));
      quantityByWorkcentre[wc] = (quantityByWorkcentre[wc] || 0) + qty;
    }

    type Interval = { start: number; end: number };
    const intervalsByWorkcentre = new Map<string, Interval[]>();

    for (const js of working.jobSchedules) {
      for (const existing of js.operationSchedules) {
        const isSameJobTail = js.jobId === jobId &&
          sortedOps.slice(movedIdx).some((tail) => String(tail.opId) === String(existing.opId));
        if (isSameJobTail) continue;

        const wc = String(existing.workcentreId || '');
        if (!intervalsByWorkcentre.has(wc)) intervalsByWorkcentre.set(wc, []);
        intervalsByWorkcentre.get(wc)!.push({
          start: new Date(existing.plannedStartDate).getTime(),
          end: new Date(existing.plannedEndDate).getTime()
        });
      }
    }

    // Slot maths extracted to utils/slotFinder.ts (unit-tested); calendar
    // awareness injected via the App's shift-window helpers.
    const findEarliestSlot = (
      desiredStartMs: number,
      durationMs: number,
      intervals: Interval[],
      capacity: number,
      workcentreId: string
    ): number | null =>
      findEarliestSlotOrForce({
        desiredStartMs,
        durationMs,
        intervals,
        capacity,
        workcentreId,
        horizonStartMs: horizonBounds.startMs,
        adapters: { align: alignToProductiveWindow, productiveEnd: calculateProductiveEndMs },
        onForcedPlacement: (wc) =>
          toast(`⚠ ${wc}: no free calendar slot found — operation placed outside normal shift hours`, { icon: '⚠️' }),
      });

    const recalculatedTail = sortedOps.map((op, idx) => ({ ...op }));

    for (let i = movedIdx; i < recalculatedTail.length; i++) {
      const op = recalculatedTail[i] as any;
      const setupMinutes = Math.max(Number(op.setupTime || 0), 0);
      const runMinutes = Math.max(Number(op.runTime || op.duration || 1), 1);
      const queueMinutes = Math.max(Number(op.queueTime || 0), 0);
      const moveMinutes = Math.max(Number(op.moveTime || 0), 0);
      const bookedMinutes = setupMinutes + runMinutes;
      const durationMs = Math.max(1, bookedMinutes) * 60 * 1000;
      const wc = i === movedIdx ? droppedOnWorkcentre || op.workcentreId : op.workcentreId;
      const capacity = 1; // one operation at a time per production line
      const intervals = intervalsByWorkcentre.get(wc) || [];
      const desiredStartMs = precedenceCursorMs + queueMinutes * 60000;
      const startMs = findEarliestSlot(desiredStartMs, durationMs, intervals, capacity, wc);
      if (startMs === null) {
        toast.error(`Operation ${op.opId} cannot fit within the selected Start and End dates`);
        return;
      }
      const endMs = calculateProductiveEndMs(startMs, durationMs, wc);

      const setupStart = new Date(startMs);
      const setupEndMs = calculateProductiveEndMs(startMs, setupMinutes * 60000, wc);
      const setupEnd = new Date(setupEndMs);
      const runStart = new Date(setupEndMs);
      const runEndMs = calculateProductiveEndMs(setupEndMs, runMinutes * 60000, wc);
      const runEnd = new Date(runEndMs);
      const moveEnd = new Date(runEndMs + moveMinutes * 60000);

      op.workcentreId = wc;
      // Machine assignment (S3.3): when the op was dropped on a specific
      // machine lane of the SAME workcentre, reassign it to that machine.
      // Machines of other workcentres are rejected — the board already
      // blocks cross-workcentre op drops, this is defence in depth.
      if (i === movedIdx && droppedOnMachineId && droppedOnMachineId !== op.resourceId) {
        const targetMachine = resources.find((r) => r.resourceId === droppedOnMachineId);
        if (targetMachine && targetMachine.worcentreId === wc) {
          op.resourceId = droppedOnMachineId;
        }
      }
      // Never leave resourceId empty — lane rendering keys by machine id.
      op.resourceId = op.resourceId || wc;
      op.duration = bookedMinutes;
      op.plannedStartDate = new Date(startMs);
      op.plannedEndDate = new Date(endMs);
      op.setupStart = setupStart;
      op.setupEnd = setupEnd;
      op.runStart = runStart;
      op.runEnd = runEnd;
      op.queueEnd = new Date(setupStart.getTime());
      op.moveEnd = moveEnd;

      intervals.push({ start: startMs, end: endMs });
      intervalsByWorkcentre.set(wc, intervals);
      precedenceCursorMs = moveEnd.getTime();
    }

    const updatedJobSchedules = working.jobSchedules.map((js) => {
      if (js.jobId !== jobId) return js;

      const byOpId = new Map<string, typeof recalculatedTail[number]>(
        recalculatedTail.map((op) => [String(op.opId), op])
      );
      const mergedOps = js.operationSchedules.map((op) => byOpId.get(String(op.opId)) || op);
      const starts = mergedOps.map((op) => new Date(op.plannedStartDate).getTime());
      const ends = mergedOps.map((op) => new Date(op.plannedEndDate).getTime());

      return {
        ...js,
        operationSchedules: mergedOps,
        plannedStartDate: new Date(Math.min(...starts)),
        plannedEndDate: new Date(Math.max(...ends))
      };
    });

    const updatedSchedule: Schedule = {
      ...working,
      jobSchedules: updatedJobSchedules
    };

    setSchedule(updatedSchedule);
    markScheduleEdited();
    undoRedoManager.addState(updatedSchedule, `Moved ${jobId}/${opId} on board`);

    // Non-blocking master/sub dependency check on the moved job's new window.
    const movedJobSchedule = updatedJobSchedules.find((j) => j.jobId === jobId);
    if (movedJobSchedule) {
      const depWarning = describeDependencyViolation(
        jobId,
        new Date(movedJobSchedule.plannedStartDate).getTime(),
        new Date(movedJobSchedule.plannedEndDate).getTime(),
        masterParentMap,
        updatedSchedule
      );
      if (depWarning) {
        toast(`⚠ ${depWarning}`, { icon: '⚠️', duration: 7000 });
      }
    }

    const movedResult = updatedJobSchedules
      .find((j) => j.jobId === jobId)
      ?.operationSchedules.find((x) => String(x.opId) === String(opId));
    const from = format(new Date(movedOriginal.plannedStartDate), 'HH:mm:ss');
    const to = movedResult ? format(new Date(movedResult.plannedStartDate), 'HH:mm:ss') : format(new Date(proposedStartDate), 'HH:mm:ss');
    toast.success(`Operation sequence updated (${from} -> ${to})`);
  };
  // Sync ref so keyboard nudge shortcut can call the latest version of this function
  operationMoveRef.current = handleScheduleBoardOperationMove;

  // Wired to the file inputs in the Import tab.
  const handleBulkImport = async (
    event: React.ChangeEvent<HTMLInputElement>,
    importType: 'jobs' | 'operations'
  ) => {
    const file = event.target.files?.[0];
    if (!file) return;

    try {
      setImporting(true);
      await BulkImportService.processFile(file, importType);
      await loadJobsAndResources();
      toast.success(`Imported ${importType} from ${file.name}`);
    } catch (error: any) {
      toast.error(apiErrorMessage(error, `Failed to import ${importType}`));
    } finally {
      setImporting(false);
      event.target.value = '';
    }
  };

  const previousScheduleForCompare = useMemo(() => {
    const previous = scheduleVersions.find((v) => !v.isCurrent);
    return previous?.scheduleData || null;
  }, [scheduleVersions]);

  const restoreVersion = async (versionId: string) => {
    try {
      // Call the durable API endpoint — promotes this version in the DB and returns it.
      const { schedule: dbSchedule, restoredAt } = await scheduleService.restoreVersion(versionId);
      setSchedule(dbSchedule);
      markScheduleEdited();
      setScheduleVersions(
        scheduleVersions.map((item) => ({ ...item, isCurrent: item.versionId === versionId }))
      );
      undoRedoManager.addState(dbSchedule, `Restored version ${versionId}`);
      toast.success(`Restored schedule from ${new Date(restoredAt).toLocaleString()}`);
    } catch {
      // Fall back to in-memory restore when the API is unavailable (e.g. offline dev).
      const version = scheduleVersions.find((v) => v.versionId === versionId);
      if (!version) return;
      setSchedule(version.scheduleData);
      markScheduleEdited();
      setScheduleVersions(
        scheduleVersions.map((item) => ({ ...item, isCurrent: item.versionId === versionId }))
      );
      undoRedoManager.addState(version.scheduleData, `Restored version ${version.versionId}`);
      scheduleService.save(version.scheduleData).catch((err) => {
        console.warn('Could not persist restored schedule to DB:', err);
      });
      toast.success(`Restored schedule from ${new Date(version.timestamp).toLocaleString()}`);
    }
  };

  useEffect(() => {
    if (!jobContextMenu.visible) return;

    const handleWindowClick = () => closeJobContextMenu();
    const handleEsc = (e: KeyboardEvent) => {
      if (e.key === 'Escape') closeJobContextMenu();
    };

    window.addEventListener('click', handleWindowClick);
    window.addEventListener('keydown', handleEsc);
    return () => {
      window.removeEventListener('click', handleWindowClick);
      window.removeEventListener('keydown', handleEsc);
    };
  }, [jobContextMenu.visible]);

  useEffect(() => {
    if (!resizeMode) return;

    document.body.style.userSelect = 'none';
    document.body.style.cursor = resizeMode === 'left' ? 'col-resize' : 'row-resize';

    const handleMouseMove = (e: MouseEvent) => {
      if (resizeMode === 'left' && workspaceRef.current) {
        const rect = workspaceRef.current.getBoundingClientRect();
        const next = Math.max(180, Math.min(520, e.clientX - rect.left));
        if (Number.isFinite(next)) {
          setWorkcentrePanelWidth(next);
        }
      }

      if (resizeMode === 'top' && centerPanelRef.current) {
        const rect = centerPanelRef.current.getBoundingClientRect();
        const maxHeight = Math.max(220, rect.height - 220);
        const next = Math.max(240, Math.min(maxHeight, e.clientY - rect.top));
        if (Number.isFinite(next)) {
          setJobsPanelHeight(next);
        }
      }
    };

    const handleMouseUp = () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      setResizeMode(null);
    };

    window.addEventListener('mousemove', handleMouseMove);
    window.addEventListener('mouseup', handleMouseUp);
    return () => {
      document.body.style.userSelect = '';
      document.body.style.cursor = '';
      window.removeEventListener('mousemove', handleMouseMove);
      window.removeEventListener('mouseup', handleMouseUp);
    };
  }, [resizeMode]);

  return (
    <div className="app" data-theme={isDarkMode ? 'dark' : 'light'}>
      <Toaster
        position="top-right"
        toastOptions={{
          style: {
            background: 'var(--bg-elevated)',
            color: 'var(--text-primary)',
            border: '1px solid var(--border-default)',
            borderRadius: 'var(--r-md)',
            boxShadow: 'var(--shadow-2)',
            fontSize: 'var(--fs-sm)',
          },
          success: { iconTheme: { primary: 'var(--status-ok)', secondary: 'var(--bg-elevated)' } },
          error: { iconTheme: { primary: 'var(--status-bad)', secondary: 'var(--bg-elevated)' } },
        }}
      />

      <ScheduleSetupModal
        open={showScheduleSetup}
        onClose={closeScheduleSetup}
        onGenerate={handleScheduleSetupGenerate}
        jobs={openJobs}
        initialConfig={{
          schedulingRule,
          schedulingDirection,
          scheduleDateMode,
          horizonStart: schedulingHorizon.start,
          horizonEnd: schedulingHorizon.end,
        }}
        loading={loading}
        preSelectedJobIds={scheduleSetupPreselect}
      />

      <AppHeader
        isDarkMode={isDarkMode}
        toggleDarkMode={toggleDarkMode}
        onOpenUserGuide={openUserGuide}
        dbStatus={dbStatus}
        dataWarning={dataWarning}
      />

      <main className="aps-main">
        {/* Replan notification banner (#63) — shown when SSE signals SYSPRO data changed */}
        {replanBanner && (
          <div className="aps-replan-banner" role="alert" aria-live="assertive">
            <span className="aps-replan-icon" aria-hidden="true">&#9432;</span>
            <span className="aps-replan-msg">{replanBanner}</span>
            <button
              className="aps-replan-dismiss"
              aria-label="Dismiss"
              onClick={() => setReplanBanner(null)}
            >
              ✕
            </button>
          </div>
        )}
        {/* Onboarding banner — shown only when there is no SYSPRO connection and no data yet */}
        {!dbStatus.sysproConnected && !schedule && openJobs.length === 0 && (
          <div className="aps-onboarding-banner" role="status" aria-live="polite">
            <span className="aps-onboarding-icon" aria-hidden="true">&#9888;</span>
            <span className="aps-onboarding-msg">
              No SYSPRO connection detected.{' '}
              <button
                className="aps-onboarding-link"
                onClick={() => setShowConnectionModal(true)}
              >
                Open a company
              </button>{' '}
              to load jobs and generate a schedule, or check <code>/health/ready</code> for connection status.
            </span>
          </div>
        )}
        <MainTabs />

        <AppRibbon
          loading={loading}
          dataLoading={dataLoading}
          scheduleLoading={scheduleLoading}
          connectionLoading={false}
          dbStatus={dbStatus}
          sseConnected={sseConnected}
          contextJobId={jobContextMenu.jobId}
          onOpenScheduleSetup={openScheduleSetup}
          onLoadData={loadJobsAndResources}
          onExportToSyspro={exportToSyspro}
          onExport={handleExport}
          onUndo={handleUndo}
          onRedo={handleRedo}
          onOpenUserGuide={openUserGuide}
          onCreateWhatIf={createWhatIfScenario}
          onClearWhatIf={clearWhatIfScenario}
          onOpenConnectionModal={() => setShowConnectionModal(true)}
          onOpenSettingsModal={() => setShowSettingsModal(true)}
          onIncludeJob={(jid) => {
            setExcludedJobIds((prev) => { const next = new Set(prev); next.delete(jid); return next; });
            toast.success(`Job ${jid} included in scheduling`);
          }}
          onExcludeJob={(jid) => {
            setExcludedJobIds((prev) => new Set([...prev, jid]));
            toast.success(`Job ${jid} excluded from scheduling`);
          }}
          onApplyWorkflowFilter={applyWorkflowFilter}
          onOpenAdvancedFilter={() => setShowAdvancedFilter(true)}
          advancedFilterActive={!!advancedFilter || advancedSort.length > 0}
        />

        <section
          ref={workspaceRef}
          className="aps-workspace"
          style={{ gridTemplateColumns: '1fr' }}
        >
          <div
            ref={centerPanelRef}
            className="aps-center-panel"
            style={{ gridTemplateRows: `${jobsPanelHeight}px 8px 1fr` }}
          >
            <section className="aps-grid-panel">
              {manageTab === 'none' ? (
                <>
                  <div className="jobs-view-tabs">
                    <button className={`feature-tab ${jobPaneMode === 'production' ? 'active' : ''}`} onClick={() => setJobPaneMode('production')}>
                      Production Jobs
                    </button>
                    <button className={`feature-tab ${jobPaneMode === 'master' ? 'active' : ''}`} onClick={() => setJobPaneMode('master')}>
                      Master Jobs
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
                      {jobPaneMode === 'production' ? 'Production Jobs' : 'Master Jobs'} {selectedWorkcentre.length ? `(Filter: ${selectedWorkcentre.length === 1 ? selectedWorkcentre[0] : `${selectedWorkcentre.length} selected`})` : ''}
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
                      {(jobSearch || jobStatusFilter !== 'all' || jobWcFilter !== 'all' || scheduleFilter !== 'all' || workflowJobFilter !== 'all') && (
                        <button className="job-filter-clear" onClick={() => { setJobSearch(''); setDebouncedJobSearch(''); setJobStatusFilter('all'); setJobWcFilter('all'); setScheduleFilter('all'); setWorkflowJobFilter('all'); }}>✕</button>
                      )}
                      <button className="job-filter-select" onClick={() => setShowColumnPicker((s) => !s)}>
                        Columns ({visibleJobColumns.length}/{allJobColumns.length})
                      </button>
                      <span className="job-count-badge">
                        {jobPaneMode === 'production'
                          ? `${filteredJobs.length} jobs`
                          : `${masterJobGroups.length} master jobs`}
                      </span>
                    </div>
                  </div>
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
                      <span aria-hidden="true" style={{ fontSize: '14px' }}>⚠</span>
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
                            {profileSaving ? '…' : '💾 Save Profile'}
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
                        {jobPaneMode === 'production' ? (
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
                                      <button className="expand-btn" onClick={(e) => { e.stopPropagation(); toggleJobExpanded(job.jobId); }}>
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
                  <h3>Alternative Machine Groups</h3>
                  <p>Create groups of machines for the same work centre so operations can switch between them during manual scheduling and publish-back.</p>
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

            <div
              className="panel-splitter horizontal"
              onMouseDown={(e) => {
                e.preventDefault();
                setResizeMode('top');
              }}
              title="Resize Production Jobs / Schedule Gantt Chart"
            />

            <ContentTabPanel
              resources={resources}
              openJobs={openJobs}
              selectedWorkcentre={selectedWorkcentre}
              boardIntervalStart={boardIntervalStart}
              boardIntervalEnd={boardIntervalEnd}
              schedulingHorizonStart={schedulingHorizonStart}
              schedulingHorizonEnd={schedulingHorizonEnd}
              materialPlan={materialPlan}
              selectedViolation={selectedViolation}
              loading={loading}
              previousScheduleForCompare={previousScheduleForCompare}
              ganttFocusWorkcentre={ganttFocusWorkcentre}
              onJobDrop={autoScheduleDroppedJob}
              onOperationMove={handleScheduleBoardOperationMove}
              onShowMaterials={(jobId: string) => setBomJobId(jobId)}
              onHighlightJob={(jobId: string | null) => { setHighlightJobId(jobId); setJobSearch(jobId || ''); }}
              onSelectViolation={setSelectedViolation}
              onShowOverrideModal={(v: ConstraintViolation) => { setSelectedViolation(v); setShowOverrideModal(true); }}
              onDraggableMove={handleDraggableMove}
              onRestoreVersion={restoreVersion}
              onLoadData={loadJobsAndResources}
              onCreateWhatIf={createWhatIfScenario}
              onClearWhatIf={clearWhatIfScenario}
            />
          </div>
        </section>
      </main>

      <AppFooter />

      {showSettingsModal && (
        <div className="modal-overlay" onClick={() => setShowSettingsModal(false)}>
          <div className="settings-fullscreen-modal" role="dialog" aria-modal="true" aria-label="Settings" onClick={e => e.stopPropagation()}>
            <div className="settings-modal-header">
              <h2>Settings</h2>
              <button className="close-btn" onClick={() => setShowSettingsModal(false)}>✕</button>
            </div>
            <div className="settings-modal-body">
              <SettingsPanel ganttPrefs={ganttPrefs} onGanttPrefsChange={setGanttPrefs} />
            </div>
          </div>
        </div>
      )}

      {isGeneratingSchedule && (
        <div className="modal-overlay">
          <div className="generation-progress-modal" role="dialog" aria-modal="true" aria-label="Generating schedule" aria-live="polite" onClick={(e) => e.stopPropagation()}>
            <div className="generation-progress-icon" aria-hidden="true">&#9203;</div>
            <h3>Generating schedule</h3>
            <p>This is normal for larger plans with many jobs and operations.</p>
            <div className="generation-progress-metrics">
              <strong>{generationProgress}% complete</strong>
              <span>{Math.max(0, 100 - generationProgress)}% outstanding</span>
            </div>
            <div className="generation-progress-bar">
              <div className="generation-progress-fill" style={{ width: `${generationProgress}%` }} />
            </div>
            <div className="generation-progress-status">{generationStatusText}</div>
          </div>
        </div>
      )}

      <ConnectionModal
        open={showConnectionModal}
        onClose={() => setShowConnectionModal(false)}
        onConnected={async () => {
          await Promise.all([loadSystemStatus(), loadJobsAndResources(), loadWorkcentreDetails(), loadAlternativeGroups()]);
        }}
      />

      <ShortcutsHelpModal />

      {/* Live database-diagram modal (HOME → Schema) */}
      <SchemaExplorer open={showSchemaModal} onClose={() => setShowSchemaModal(false)} />

      {/* Constraint Override Modal */}
      <ConstraintOverrideModal
        violation={selectedViolation}
        isOpen={showOverrideModal}
        onClose={() => {
          setShowOverrideModal(false);
          setSelectedViolation(null);
        }}
        onApprove={handleApproveOverride}
      />

      {/* BOM / material availability modal (Gantt right-click → "View materials") */}
      <BomDetailModal
        jobId={bomJobId}
        open={bomJobId !== null}
        onClose={() => setBomJobId(null)}
      />

      <AdvancedFilterBuilder open={showAdvancedFilter} onClose={() => setShowAdvancedFilter(false)} />

      {jobContextMenu.visible && (
        <div
          className="job-context-menu"
          style={{ left: jobContextMenu.x, top: jobContextMenu.y }}
          onClick={(e) => e.stopPropagation()}
        >
          <button className="ctx-item" onClick={() => executeJobContextCommand('autoschedule')}>Autoschedule</button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('schedule-around-left')}>Schedule Around Left</button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('schedule-around-right')}>Schedule Around Right</button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('schedule-around-both')}>Schedule Around Both</button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('schedule-around-master')}>Schedule Entire Master Job</button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('unschedule-selected')}>Unschedule Selected</button>
          <div className="ctx-sep" />

          <button className="ctx-item" onClick={() => executeJobContextCommand('edit-job')}>Edit Job</button>
          <div className="ctx-sep" />
          <button className="ctx-item" onClick={() => executeJobContextCommand('load-required-machines')}>Load Required Machines</button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('unload-all-machines')}>Unload All Machines</button>
          <div className="ctx-sep" />

          <button className="ctx-item" onClick={() => executeJobContextCommand('highlight-object')}>Highlight Object</button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('show-details')}>Show Details</button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('job-status')}>Job Status</button>
          <div className="ctx-sep" />

          <button className="ctx-item" onClick={() => executeJobContextCommand('undo')}>Undo</button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('redo')}>Redo</button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('refresh')}>Refresh</button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('save-and-publish')}>Save and Publish</button>
          <button className="ctx-item has-arrow" onClick={() => executeJobContextCommand('load-machines')}>Load Machines</button>
          <button className="ctx-item has-arrow" onClick={() => executeJobContextCommand('material-planning')}>Material Planning</button>
          <button className="ctx-item has-arrow" onClick={() => executeJobContextCommand('possible-errors')}>Possible Errors</button>
          <button className="ctx-item has-arrow" onClick={() => executeJobContextCommand('pin')}>Pin</button>
          <button className="ctx-item has-arrow" onClick={() => executeJobContextCommand('deadline')}>Deadline</button>
          <button className="ctx-item has-arrow" onClick={() => executeJobContextCommand('actions')}>Actions</button>
        </div>
      )}
    </div>
  );
};

const AppWithAuth: React.FC = () => {
  const { user, loading } = useAuth();
  if (loading) return <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', height: '100vh', fontFamily: 'sans-serif', color: '#3a5d86' }}>Loading…</div>;
  if (!user) return <LoginPage />;
  return <App />;
};

const AppRoot: React.FC = () => (
  <AuthProvider>
    <AppWithAuth />
  </AuthProvider>
);
export default AppRoot;
