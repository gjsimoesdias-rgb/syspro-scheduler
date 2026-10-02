import React, { useState, useEffect, useMemo, useRef, useCallback } from 'react';
import toast, { Toaster } from 'react-hot-toast';
import { format } from 'date-fns';
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
import ResourceTree from './components/ResourceTree';
import SchemaExplorer from './components/SchemaExplorer';
import ContentTabPanel, { VIEW_GROUPS } from './components/ContentTabPanel';
import CommandPalette, { type PaletteCommand } from './components/CommandPalette';
// Type-only import (no runtime value used)
// Lazy tab panels still used directly in App.tsx (manage tab)
import { AuthProvider, useAuth } from './context/AuthContext';
import LoginPage from './pages/LoginPage';
import { useMarkerStore, passesMarkerFilter } from './stores/markerStore';
import { useUiStore, type WorkflowJobFilter, type JobPaneMode, type ScheduleAroundMode } from './stores/uiStore';
import { useScheduleStore } from './stores/scheduleStore';
import exportService from './services/exportService';
import { createShortcutManager } from './services/keyboardShortcuts';
import BulkImportService from './services/bulkImportService';
import { Schedule, ConstraintViolation, Job, Resource, Operation } from './types';
import { scheduleService, jobService, versionService, apiClient, pinService, settingsService, inventoryService, type JobFmad, type PinnedOperationDto, apiErrorMessage, jobFlagService, type JobFlags, masterRevision, isMasterChangedError } from './services/api';
import { planJobsFrom, planKeyOf } from './utils/planJobs';
import { getUserGuideHtml } from './userGuideHtml';
import ScheduleSetupModal, { ScheduleConfig } from './components/ScheduleSetupModal';
import { useSseEvents } from './hooks/useSseEvents';
import { useJobsData } from './hooks/useJobsData';
import { useScheduleGeneration } from './hooks/useScheduleGeneration';
import { useScheduleDiagnostics } from './hooks/useScheduleDiagnostics';
import { useManualScheduling } from './hooks/useManualScheduling';
import { useJobGridRenderers } from './components/jobGridRenderers';
import JobsPanel from './components/JobsPanel';
import { useColumnManager } from './hooks/useColumnManager';
import { toCsv, downloadCsv } from './utils/csvExport';
import { convertScheduleDates } from './utils/scheduleDates';
import { buildScheduleFromSysproJobs } from './utils/sysproSchedule';
import {
  buildParentMap,
  getMasterRootJobId as resolveMasterRootJobId,
} from './utils/masterSub';
import './App.css';
// Token-based overrides: MUST come after App.css to win specificity battles.
import './styles/aps-overrides.css';
import './styles/lynq.css';


const App: React.FC = () => {
  const isDarkMode = useUiStore((s) => s.isDarkMode);
  const toggleDarkMode = useUiStore((s) => s.toggleDarkMode);
  const { user } = useAuth();
  const schedule = useScheduleStore((s) => s.schedule);
  const setSchedule = useScheduleStore((s) => s.setSchedule);
  const [scheduleLoading, setScheduleLoading] = useState(true);
  const scheduleSource = useScheduleStore((s) => s.scheduleSource);
  const activeVersion = useScheduleStore((s) => s.activeVersion);
  const setScheduleSource = useScheduleStore((s) => s.setScheduleSource);
  // loading is provided by useScheduleGeneration (wired below after addVersion)
  const isGeneratingSchedule = useScheduleStore((s) => s.isGeneratingSchedule);
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
  const setWhatIfSchedule = useScheduleStore((s) => s.setWhatIfSchedule);
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
  const showResourceTree = useUiStore((s) => s.showResourceTree);
  const setShowResourceTree = useUiStore((s) => s.setShowResourceTree);
  const setJobPaneMode = useUiStore((s) => s.setJobPaneMode);
  const scheduleAroundMode = useUiStore((s) => s.scheduleAroundMode) as ScheduleAroundMode;
  // Column visibility, ordering, and profile persistence → useColumnManager (wired below after openJobs is available)

  // Gen3: Pagination for job grid tables (reset on filter/search change)
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
  // Pin / Exclude job flags live on the server so they survive reloads and
  // also apply to the background Auto plan (GET/PUT /api/jobs/flags).
  const [jobFlags, setJobFlags] = useState<JobFlags>({ excluded: [], pinned: [] });
  const excludedJobIds = useMemo(() => new Set(jobFlags.excluded), [jobFlags]);
  const pinnedJobIds = useMemo(() => new Set(jobFlags.pinned), [jobFlags]);
  useEffect(() => {
    jobFlagService.get().then(setJobFlags).catch(() => { /* older server: no flags */ });
  }, []);
  const setJobFlag = useCallback(async (jobId: string, flag: 'excluded' | 'pinned', on: boolean) => {
    try {
      setJobFlags(await jobFlagService.set(jobId, { [flag]: on }));
      toast.success(flag === 'excluded'
        ? (on ? `Job ${jobId} excluded — left out of Generate and Auto plan until you include it again` : `Job ${jobId} included in planning again`)
        : (on ? `Job ${jobId} pinned — keeps its machine and times from the master plan on the next Generate` : `Job ${jobId} unpinned`));
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Could not change the job flag'));
    }
  }, []);
  const toggleJobFlag = useCallback(
    (jobId: string, flag: 'excluded' | 'pinned') =>
      setJobFlag(jobId, flag, !(flag === 'excluded' ? excludedJobIds : pinnedJobIds).has(jobId)),
    [setJobFlag, excludedJobIds, pinnedJobIds]);

  // Gen3: Highlighted job in gantt
  const highlightJobId = useScheduleStore((s) => s.highlightJobId);
  const setHighlightJobId = useScheduleStore((s) => s.setHighlightJobId);
  /** Externally-pinned ops ("jobId::opId" keys) — visible in both jobs table and Gantt */
  const pinnedOps = useScheduleStore((s) => s.pinnedOps);

  // Per-job SYSPRO publish state of the master plan (Published / Pending / Error).
  const [publishByJob, setPublishByJob] = useState<Map<string, string>>(new Map());
  const refreshPublishState = useCallback(() => {
    versionService.publishStatus()
      .then((r) => setPublishByJob(new Map(r.jobs.map((j) => [String(j.jobId).trim(), j.state]))))
      .catch(() => { /* optional column */ });
  }, []);
  const togglePinnedOp = useScheduleStore((s) => s.togglePinnedOp);
  const setPinnedOps = useScheduleStore((s) => s.setPinnedOps);
  const setPinnedOpDetails = useScheduleStore((s) => s.setPinnedOpDetails);

  // Material-availability modal — opened from Gantt right-click → "View materials"
  const [bomJobId, setBomJobId] = useState<string | null>(null);

  // Data loading — jobs, resources, workcentres, materials, alternative groups
  const {
    openJobs,
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
  const [expandedJobs, setExpandedJobs] = useState<Record<string, boolean>>({});
  const setWorkcentrePanelWidth = useUiStore((s) => s.setWorkcentrePanelWidth);
  const jobsPanelHeight = useUiStore((s) => s.jobsPanelHeight);
  const setJobsPanelHeight = useUiStore((s) => s.setJobsPanelHeight);
  const [resizeMode, setResizeMode] = useState<null | 'left' | 'top'>(null);
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
    loadJobsAndResources,
    addVersion,
  });

  // Column visibility, ordering, and profile persistence
  const {
    visibleJobColumns,
    visibleOperationColumns,
    allJobColumns,
    allOperationColumns,
    orderedVisibleColumns,
    showColumnPicker,
    setShowColumnPicker,
    showOperationColumnPicker,
    setShowOperationColumnPicker,
    columnProfileName,
    setColumnProfileName,
    profileSaving,
    saveColumnProfile,
    toggleJobColumn,
    toggleOperationColumn,
    handleColDragStart,
    handleColDrop,
    formatJobColumnValue,
    formatOperationColumnValue,
  } = useColumnManager({ openJobs, userId: user?.id !== undefined ? String(user.id) : undefined });

  // SYSPRO column: reload after jobs reload (e.g. after Send to SYSPRO) or a new plan.
  useEffect(() => { if (dbStatus.sysproConnected) refreshPublishState(); }, [openJobs, schedule?.scheduleId, dbStatus.sysproConnected, refreshPublishState]);

  // Job markers (LYNQ-style coloured tags) — grid column, Gantt flag, filter.
  const markerDefs = useMarkerStore((s) => s.definitions);
  const markerAssignments = useMarkerStore((s) => s.assignments);
  const markerFilter = useMarkerStore((s) => s.filter);
  const loadMarkers = useMarkerStore((s) => s.load);
  const assignMarker = useMarkerStore((s) => s.assign);
  useEffect(() => { if (user?.id !== undefined) void loadMarkers(); }, [user?.id, loadMarkers]);

  // FMAD column: first material availability per job — fetched only while the
  // column is shown, and again when the plan's dates change.
  const fmadVisible = visibleJobColumns.includes('fmad');
  const [fmadByJob, setFmadByJob] = useState<Record<string, JobFmad> | undefined>(undefined);
  const fmadPlan = useMemo(
    () => (fmadVisible ? planJobsFrom(openJobs, schedule?.jobSchedules || []) : []),
    [fmadVisible, openJobs, schedule?.jobSchedules],
  );
  const fmadKey = useMemo(() => planKeyOf(fmadPlan), [fmadPlan]);
  useEffect(() => {
    if (!fmadVisible || !dbStatus.sysproConnected || !fmadPlan.length) return;
    let cancelled = false;
    const t = setTimeout(() => {
      inventoryService.fmad(fmadPlan)
        .then((r) => { if (!cancelled) setFmadByJob(r.jobs || {}); })
        .catch(() => { if (!cancelled) setFmadByJob({}); });
    }, 400);
    return () => { cancelled = true; clearTimeout(t); };
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [fmadKey, fmadVisible, dbStatus.sysproConnected]);

  // ─── Cell renderers for the jobs grid (use formatters from useColumnManager) ──

  /** Export the jobs grid as shown (filtered rows, visible columns) for Excel. */
  const exportJobsGrid = () => {
    const text = (job: Job, key: string): unknown => {
      switch (key) {
        case 'scheduleStatus': return getJobScheduleStatus(job);
        case 'materialStatus': return getJobMaterialStatus(job);
        case 'lateness': return jobLatenessMap.get(job.jobId) ?? '';
        case 'lockedOps': return (job.operations || []).filter((o) => pinnedOps.has(`${job.jobId}::${o.opId}`)).length;
        case 'publishState': return publishByJob.get(String(job.jobId).trim()) ?? '';
        case 'fmad': { const f = fmadByJob?.[job.jobId]; return f?.fmad ? f.fmad.slice(0, 10) : f?.status === 'no-supply' ? 'No supply' : ''; }
        case 'dependents': return dependentsByJob.get(job.jobId) || 0;
        case 'marker': return markerDefs.find((d) => d.id === markerAssignments[job.jobId])?.name ?? '';
        case 'validForScheduling': return job.operations?.length ? 'Yes' : 'No operations';
        default: {
          // Numbers go out raw (not "1,960") so Excel can sum them.
          const raw = (job as Record<string, unknown>)[key];
          return typeof raw === 'number' ? raw : formatJobColumnValue(job, key);
        }
      }
    };
    const cols = orderedVisibleColumns;
    const csv = toCsv(cols.map((c) => c.label), filteredJobs.map((job) => cols.map((c) => text(job, c.key))));
    downloadCsv(`production-jobs-${format(new Date(), 'yyyyMMdd-HHmm')}.csv`, csv);
    toast.success(`Exported ${filteredJobs.length} jobs`);
  };

  const buildScheduleFromSyspro = useCallback((jobs: Job[]): Schedule | null => buildScheduleFromSysproJobs(jobs), []);

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
  }, [resetJobFilters, setJobPaneMode, setJobWcFilter, setManageTab, setScheduleFilter, setWorkflowJobFilter]);

  const openUserGuide = (section: 'overview' | 'company' | 'jobs' | 'materials' | 'publish' | 'shortcuts' = 'overview') => {
    setGuideFocus(section);
    setShowShortcutsHelp(false);

    const guideWindow = window.open('', 'crux-aps-user-guide', 'width=1280,height=900,resizable=yes,scrollbars=yes');
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
    console.log('Syspro Scheduler UI loaded');

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
      handler: () => { if (scheduleRef.current) void exportService.downloadScheduleReport(scheduleRef.current); }
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

  /** Put the current master back on the board (after a save conflict). Unsaved board edits are dropped. */
  const reopenMaster = useCallback(async () => {
    try {
      const { schedule: master } = await scheduleService.openLatest();
      useScheduleStore.getState().setActiveVersion(null);
      if (master) {
        setSchedule(convertScheduleDates(master));
        setScheduleSource('restored');
      }
      toast.success('Master plan reopened');
    } catch (error) {
      toast.error(apiErrorMessage(error, 'Could not reopen the master plan'));
    }
  }, [setSchedule, setScheduleSource]);

  useEffect(() => {
    if (scheduleLoading || !schedule || !dbStatus.sysproConnected || scheduleSource !== 'session') {
      return;
    }

    // A save was refused because the master changed elsewhere: stop autosaving
    // (every retry would be refused too) until the master is reopened.
    if (!activeVersion && masterRevision.inConflict()) return;

    const timeoutId = window.setTimeout(() => {
      // An open what-if saves into itself; only the master goes to /schedule/save.
      const save = activeVersion
        ? versionService.saveInto(activeVersion.versionId, schedule)
        : scheduleService.save(schedule);
      save.catch((error) => {
        if (isMasterChangedError(error)) {
          toast.error((t) => (
            <span>
              {apiErrorMessage(error, 'The master plan changed since you loaded it.')}{' '}
              <button className="toast-action" onClick={() => { toast.dismiss(t.id); void reopenMaster(); }}>Reopen master plan</button>
            </span>
          ), { id: 'master-changed', duration: Infinity });
          return;
        }
        console.warn('Could not persist schedule:', error);
      });
    }, 600);

    return () => window.clearTimeout(timeoutId);
  }, [schedule, scheduleLoading, dbStatus.sysproConnected, scheduleSource, activeVersion, reopenMaster]);

  useEffect(() => {
    // 'restored' = a saved plan opened from the Versions tab (or loaded at
    // start-up): keep it on the board instead of rebuilding from SYSPRO dates.
    if (scheduleSource === 'session' || scheduleSource === 'restored') {
      return;
    }

    // The saved master plan is the board's source of truth (it has real
    // KPIs, resource loads and violations). The SYSPRO-dates view below is
    // only a placeholder until it loads, or the fallback when none exists.
    if (openJobs.length > 0 && dbStatus.sysproConnected) {
      scheduleService.loadLatest()
        .then(({ schedule: master, meta }) => {
          const st = useScheduleStore.getState();
          if ((st.scheduleSource === 'none' || st.scheduleSource === 'syspro') && !st.activeVersion) {
            // The board now stands on this master (or on "no master yet"):
            // later saves are checked against this revision.
            masterRevision.set(master ? (typeof meta?.revision === 'number' ? meta.revision : undefined) : null);
            if (master) {
              setSchedule(convertScheduleDates(master));
              setScheduleSource('restored');
            }
          }
        })
        .catch(() => { /* no saved plan yet */ });
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
  }, [openJobs, scheduleSource, buildScheduleFromSyspro, activePlanningInterval, dbStatus.sysproConnected, setBoardIntervalEnd, setBoardIntervalStart, setDraftIntervalEnd, setDraftIntervalStart, setSchedule, setScheduleSource]);

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
  }, [isGeneratingSchedule, openJobs, setGenerationProgress, setGenerationStatusText]);

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
  }, [visibleJobSource, loadMaterialPlan]);

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

  // Lateness, why-late, unscheduled reasons and per-job status (pure, unit-tested).
  const { scheduleByJobId, jobLatenessMap, lateWhyByJob, scheduleShortfall, getJobScheduleStatus } =
    useScheduleDiagnostics(schedule, openJobs);

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
        await pinService.pin(pinDto);
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

  const getJobMaterialStatus = useCallback((job: Job): 'Materials' | 'Partial' | 'No Materials' => {
    return materialStatusByJob[job.jobId] || 'Materials';
  }, [materialStatusByJob]);

  // Master/sub-job helpers — logic shared with MachineGanttBoard via utils/masterSub.

  const parentJobByChildId = useMemo(() => buildParentMap(visibleJobSource), [visibleJobSource]);

  // Dependency map over ALL open jobs (not just the visible subset) — used by
  // the manual-scheduling dependency guards below.
  const masterParentMap = useMemo(() => buildParentMap(openJobs), [openJobs]);

  // Dependents column: sub-jobs (all levels) under each master job.
  const dependentsByJob = useMemo(() => {
    const m = new Map<string, number>();
    parentJobByChildId.forEach((_parent, child) => {
      const seen = new Set<string>([child]);
      let p = parentJobByChildId.get(child);
      while (p && !seen.has(p)) {
        m.set(p, (m.get(p) || 0) + 1);
        seen.add(p);
        p = parentJobByChildId.get(p);
      }
    });
    return m;
  }, [parentJobByChildId]);

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

  // MRP Jobs tab: SYSPRO suggested jobs. When the company plans them they are
  // already in openJobs; otherwise they are fetched read-only for the tab.
  const [mrpPreview, setMrpPreview] = useState<{ included: boolean; jobs: Job[] } | null>(null);
  const [mrpBusy, setMrpBusy] = useState(false);
  const loadMrpPreview = useCallback(async () => {
    try { setMrpPreview(await jobService.getSuggested()); }
    catch { setMrpPreview({ included: false, jobs: [] }); }
  }, []);
  useEffect(() => { if (jobPaneMode === 'mrp') void loadMrpPreview(); }, [jobPaneMode, loadMrpPreview]);
  const suggestedInPlan = useMemo(() => visibleJobSource.filter((j) => (j as any).isSuggested), [visibleJobSource]);
  const mrpIncluded = suggestedInPlan.length > 0 || !!mrpPreview?.included;
  const mrpJobCount = suggestedInPlan.length || mrpPreview?.jobs.length || 0;
  const toggleMrpPlanning = useCallback(async () => {
    setMrpBusy(true);
    try {
      await settingsService.setIncludeMrpSuggestedJobs(!mrpIncluded);
      await loadJobsAndResources();
      await loadMrpPreview();
      toast.success(!mrpIncluded ? 'MRP suggested jobs are now part of the plan — generate a schedule to place them' : 'MRP suggested jobs removed from the plan');
    } catch (e: any) {
      toast.error(e?.response?.status === 403 ? 'Only a company admin can change this setting' : 'Could not change the setting');
    } finally { setMrpBusy(false); }
  }, [mrpIncluded, loadJobsAndResources, loadMrpPreview]);

  // Gen3 multi-criteria job filtering
  const filteredJobs = useMemo(() => {
    const paneSource = jobPaneMode === 'mrp'
      ? (suggestedInPlan.length ? suggestedInPlan : (mrpPreview?.jobs || []))
      : visibleJobSource.filter((j) => !(j as any).isSuggested);
    let list = selectedWorkcentre.length
      ? paneSource.filter((job) => job.operations.some((op) => selectedWorkcentre.includes(op.workcentreId)))
      : paneSource;

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

    if (markerFilter) {
      list = list.filter((j) => passesMarkerFilter(markerFilter, markerAssignments, j.jobId));
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
  }, [visibleJobSource, jobPaneMode, suggestedInPlan, mrpPreview, selectedWorkcentre, debouncedJobSearch, jobStatusFilter, jobWcFilter, scheduleFilter, workflowJobFilter, getJobScheduleStatus, advancedFilter, advancedSort, getJobMaterialStatus, markerFilter, markerAssignments]);

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
  }, [visibleJobSource, selectedWorkcentre, jobStatusFilter, jobWcFilter, scheduleFilter, setJobStatusFilter, setJobWcFilter]);

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
      console.log(`Auto-retrying job load (attempt ${jobLoadRetryRef.current}/3)...`);
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

  // Manual scheduling (drag/drop, schedule-around, op moves, context menu) — hooks/useManualScheduling.ts
  const {
    autoScheduleDroppedJob,
    handleJobRowClick,
    openJobContextMenu,
    closeJobContextMenu,
    executeJobContextCommand,
    handleDraggableMove,
    handleScheduleBoardOperationMove,
  } = useManualScheduling({
    schedule,
    setSchedule,
    openJobs,
    visibleJobSource,
    resources,
    alternativeGroups,
    undoRedoManager,
    markScheduleEdited,
    handleUndo,
    handleRedo,
    exportToSyspro,
    loadJobsAndResources,
    openScheduleSetup,
    masterParentMap,
    getMasterRootJobId,
    boardIntervalStart,
    boardIntervalEnd,
    schedulingHorizon,
    scheduleAroundMode,
    highlightJobId,
    setHighlightJobId,
    jobContextMenu,
    setJobContextMenu,
    setExpandedJobs,
    toggleJobExpanded,
    toggleJobFlag,
    setSelectedWorkcentre,
    setGanttFocusWorkcentre,
    setContentTab,
    setManageTab,
    scheduleOpRef,
    operationMoveRef,
  });
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
    } catch (error: any) {
      // The server refused (e.g. a what-if must be committed instead): say why,
      // and never push the version in as the master behind its back.
      if (error?.response) {
        toast.error(apiErrorMessage(error, 'Could not restore this version'));
        return;
      }
      // Fall back to in-memory restore when the API is unreachable (e.g. offline dev).
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
  }, [jobContextMenu.visible, closeJobContextMenu]);

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
  }, [resizeMode, setJobsPanelHeight, setWorkcentrePanelWidth]);

  // Jobs-grid cell renderers — components/jobGridRenderers.tsx
  const { renderJobCellContent, renderOperationsTable } = useJobGridRenderers({
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
  });

  // ─── Ctrl+K menu search (LYNQ "Type a menu item") ──────────────────────
  const [paletteOpen, setPaletteOpen] = useState(false);
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if ((e.ctrlKey || e.metaKey) && !e.shiftKey && !e.altKey && e.key.toLowerCase() === 'k') {
        e.preventDefault();
        setPaletteOpen((o) => !o);
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);
  // Rebuilt each render (≈40 small objects) so every action sees current state.
  const paletteCommands = ((): PaletteCommand[] => {
    const toManage = (tab: Parameters<typeof setManageTab>[0]) => () => { setMainTab('manage'); setManageTab(tab); };
    const toPane = (mode: JobPaneMode) => () => { setManageTab('none'); setJobPaneMode(mode); };
    const noPlan = !schedule;
    return [
      ...VIEW_GROUPS.flatMap((g) => g.tabs.map((t) => ({
        id: `view-${t.id}`, group: g.label, label: t.label, keywords: `view ${t.id} ${t.id === 'machines' ? 'workunit machine analysis load utilisation utilization idle busy' : ''}`,
        run: () => setContentTab(t.id),
      }))),
      { id: 'act-generate', group: 'Schedule', label: 'Generate schedule…', keywords: 'plan run autoschedule', hint: 'Ctrl+Enter', disabled: !dbStatus.sysproConnected, run: () => openScheduleSetup() },
      { id: 'act-send', group: 'Schedule', label: 'Send to SYSPRO', keywords: 'publish export dates save', disabled: noPlan || !dbStatus.sysproConnected, run: () => { void exportToSyspro(); } },
      { id: 'act-undo', group: 'Schedule', label: 'Undo', hint: 'Ctrl+Z', run: () => handleUndo() },
      { id: 'act-redo', group: 'Schedule', label: 'Redo', hint: 'Ctrl+Shift+Z', run: () => handleRedo() },
      { id: 'act-refresh', group: 'Data', label: 'Refresh jobs from SYSPRO', keywords: 'reload data', run: () => { void loadJobsAndResources(); } },
      { id: 'act-export-grid', group: 'Data', label: 'Export jobs grid (Excel)', keywords: 'csv download', run: () => exportJobsGrid() },
      { id: 'act-report', group: 'Reports', label: 'Schedule report (PDF)', keywords: 'print', disabled: noPlan, run: () => handleExport('pdf') },
      { id: 'pane-production', group: 'Jobs', label: 'Production jobs', run: toPane('production') },
      { id: 'pane-master', group: 'Jobs', label: 'Master jobs', keywords: 'sub jobs', run: toPane('master') },
      { id: 'pane-mrp', group: 'Jobs', label: 'MRP jobs', keywords: 'suggested', run: toPane('mrp') },
      { id: 'flt-unscheduled', group: 'Filter', label: 'Unscheduled jobs', run: () => applyWorkflowFilter('unscheduled') },
      { id: 'flt-pastdue', group: 'Filter', label: 'Past due jobs', keywords: 'late overdue', run: () => applyWorkflowFilter('past-due') },
      { id: 'flt-advanced', group: 'Filter', label: 'Advanced filter…', run: () => setShowAdvancedFilter(true) },
      { id: 'flt-clear', group: 'Filter', label: 'Clear job filters', keywords: 'reset all', run: () => applyWorkflowFilter('all') },
      { id: 'mng-workcenters', group: 'Manage', label: 'Work centres', keywords: 'lines', run: toManage('workcenters') },
      { id: 'mng-machines', group: 'Manage', label: 'Machines', keywords: 'resources', run: toManage('machines') },
      { id: 'mng-shifts', group: 'Manage', label: 'Shifts', keywords: 'calendar', run: toManage('shifts') },
      { id: 'mng-crews', group: 'Manage', label: 'Crews', keywords: 'operators labour employees', run: toManage('crews') },
      { id: 'mng-markers', group: 'Manage', label: 'Markers', keywords: 'tags colours labels', run: toManage('markers') },
      { id: 'mng-alternatives', group: 'Manage', label: 'Alternatives', run: toManage('alternatives') },
      { id: 'mng-interval', group: 'Manage', label: 'Planning interval', keywords: 'board horizon', run: toManage('interval') },
      { id: 'ui-tree', group: 'View', label: showResourceTree ? 'Hide resource tree' : 'Show resource tree', keywords: 'lanes lines', run: () => setShowResourceTree(!showResourceTree) },
      { id: 'ui-dark', group: 'View', label: isDarkMode ? 'Light mode' : 'Dark mode', keywords: 'theme', hint: 'Ctrl+Shift+D', run: () => toggleDarkMode() },
      { id: 'ui-settings', group: 'File', label: 'Settings', keywords: 'preferences options', run: () => setShowSettingsModal(true) },
      { id: 'ui-help', group: 'File', label: 'Help / user guide', run: () => openUserGuide('overview') },
      { id: 'ui-shortcuts', group: 'File', label: 'Keyboard shortcuts', run: () => openUserGuide('shortcuts') },
    ];
  })();

  return (
    <div className="app" data-theme={isDarkMode ? 'dark' : 'light'}>
      <CommandPalette open={paletteOpen} onClose={() => setPaletteOpen(false)} commands={paletteCommands} />
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
        onOpenCommandPalette={() => setPaletteOpen(true)}
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
          onCreateWhatIf={() => setContentTab('history')}
          onClearWhatIf={clearWhatIfScenario}
          onOpenConnectionModal={() => setShowConnectionModal(true)}
          onOpenSettingsModal={() => setShowSettingsModal(true)}
          onIncludeJob={(jid) => { void setJobFlag(jid, 'excluded', false); }}
          onExcludeJob={(jid) => { void setJobFlag(jid, 'excluded', true); }}
          onApplyWorkflowFilter={applyWorkflowFilter}
          onOpenAdvancedFilter={() => setShowAdvancedFilter(true)}
          advancedFilterActive={!!advancedFilter || advancedSort.length > 0}
        />

        <section
          ref={workspaceRef}
          className="aps-workspace"
          style={{ gridTemplateColumns: showResourceTree ? '220px 1fr' : '1fr' }}
        >
          {showResourceTree && (
            <ResourceTree
              resources={resources}
              schedule={schedule}
              selectedWorkcentre={selectedWorkcentre}
              onSelectLine={setSelectedWorkcentre}
            />
          )}
          <div
            ref={centerPanelRef}
            className="aps-center-panel"
            style={{ gridTemplateRows: `${jobsPanelHeight}px 8px 1fr` }}
          >
            <JobsPanel
              WORKCENTRE_PAGE_SIZE={WORKCENTRE_PAGE_SIZE}
              allJobColumns={allJobColumns}
              allWorkcentreIds={allWorkcentreIds}
              alternativeGroups={alternativeGroups}
              boardIntervalEnd={boardIntervalEnd}
              boardIntervalStart={boardIntervalStart}
              columnProfileName={columnProfileName}
              dbStatus={dbStatus}
              draftIntervalEnd={draftIntervalEnd}
              draftIntervalStart={draftIntervalStart}
              expandedJobs={expandedJobs}
              exportJobsGrid={exportJobsGrid}
              filteredJobs={filteredJobs}
              formatJobColumnValue={formatJobColumnValue}
              handleBulkImport={handleBulkImport}
              handleColDragStart={handleColDragStart}
              handleColDrop={handleColDrop}
              handleJobRowClick={handleJobRowClick}
              highlightJobId={highlightJobId}
              importing={importing}
              jobImportRef={jobImportRef}
              jobLatenessMap={jobLatenessMap}
              jobPage={jobPage}
              jobPaneMode={jobPaneMode}
              mrpIncluded={mrpIncluded}
              mrpJobCount={mrpJobCount}
              mrpBusy={mrpBusy}
              onToggleMrpPlanning={toggleMrpPlanning}
              jobSearch={jobSearch}
              jobStatusFilter={jobStatusFilter}
              jobWcFilter={jobWcFilter}
              loadJobsAndResources={loadJobsAndResources}
              loadWorkcentreDetails={loadWorkcentreDetails}
              loading={loading}
              machineOptionsByWorkcentre={machineOptionsByWorkcentre}
              manageTab={manageTab}
              setManageTab={setManageTab}
              masterJobGroups={masterJobGroups}
              masterJobPage={masterJobPage}
              materialStatusByJob={materialStatusByJob}
              newAlternativeGroup={newAlternativeGroup}
              openJobContextMenu={openJobContextMenu}
              openScheduleSetup={openScheduleSetup}
              opsImportRef={opsImportRef}
              orderedVisibleColumns={orderedVisibleColumns}
              profileSaving={profileSaving}
              removeAlternativeGroup={removeAlternativeGroup}
              renderJobCellContent={renderJobCellContent}
              renderOperationsTable={renderOperationsTable}
              saveAlternativeGroup={saveAlternativeGroup}
              saveColumnProfile={saveColumnProfile}
              scheduleFilter={scheduleFilter}
              scheduleShortfall={scheduleShortfall}
              selectedWorkcentre={selectedWorkcentre}
              setBoardIntervalEnd={setBoardIntervalEnd}
              setBoardIntervalStart={setBoardIntervalStart}
              setColumnProfileName={setColumnProfileName}
              setDebouncedJobSearch={setDebouncedJobSearch}
              setDraftIntervalEnd={setDraftIntervalEnd}
              setDraftIntervalStart={setDraftIntervalStart}
              setHighlightJobId={setHighlightJobId}
              setJobPage={setJobPage}
              setJobPaneMode={setJobPaneMode}
              setJobSearch={setJobSearch}
              setJobStatusFilter={setJobStatusFilter}
              setJobWcFilter={setJobWcFilter}
              setMasterJobPage={setMasterJobPage}
              setNewAlternativeGroup={setNewAlternativeGroup}
              setScheduleFilter={setScheduleFilter}
              setSelectedWorkcentre={setSelectedWorkcentre}
              setShowColumnPicker={setShowColumnPicker}
              setWorkcentrePage={setWorkcentrePage}
              setWorkflowJobFilter={setWorkflowJobFilter}
              showColumnPicker={showColumnPicker}
              toggleJobColumn={toggleJobColumn}
              toggleJobExpanded={toggleJobExpanded}
              visibleJobColumns={visibleJobColumns}
              visibleJobSource={visibleJobSource}
              workcentreColumns={workcentreColumns}
              workcentrePage={workcentrePage}
              workcentreRows={workcentreRows}
              workflowJobFilter={workflowJobFilter}
            />

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
              onRefresh={async () => { await loadJobsAndResources(); toast.success('Jobs refreshed'); }}
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
          <div className="ctx-marker-row" role="group" aria-label="Marker">
            <span className="ctx-marker-label">Marker</span>
            {markerDefs.map((d) => (
              <button
                key={d.id}
                className={`ctx-marker-swatch${markerAssignments[jobContextMenu.jobId || ''] === d.id ? ' is-on' : ''}`}
                style={{ ['--mk' as any]: d.color }}
                title={d.name}
                aria-label={`Marker ${d.name}`}
                onClick={() => {
                  const id = jobContextMenu.jobId;
                  setJobContextMenu((p) => ({ ...p, visible: false }));
                  if (id) assignMarker([id], markerAssignments[id] === d.id ? null : d.id).catch(() => toast.error('Could not set the marker'));
                }}
              />
            ))}
            {markerAssignments[jobContextMenu.jobId || ''] && (
              <button className="ctx-marker-clear" title="Clear marker" onClick={() => {
                const id = jobContextMenu.jobId;
                setJobContextMenu((p) => ({ ...p, visible: false }));
                if (id) assignMarker([id], null).catch(() => toast.error('Could not clear the marker'));
              }}>Clear</button>
            )}
            <button className="ctx-marker-clear" title="Add or edit markers" onClick={() => {
              setJobContextMenu((p) => ({ ...p, visible: false }));
              setMainTab('manage'); setManageTab('markers');
            }}>{markerDefs.length ? 'Edit…' : 'Create markers…'}</button>
          </div>
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
          <button className="ctx-item" onClick={() => executeJobContextCommand('pin')}>
            {pinnedJobIds.has(jobContextMenu.jobId || '') ? 'Unpin job' : 'Pin job (keep in place)'}
          </button>
          <button className="ctx-item" onClick={() => executeJobContextCommand('exclude')}>
            {excludedJobIds.has(jobContextMenu.jobId || '') ? 'Include in planning' : 'Exclude from planning'}
          </button>
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
