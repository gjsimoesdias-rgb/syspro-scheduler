/**
 * uiStore — Zustand store for UI preferences that need to be accessible
 * across multiple components without prop-drilling.
 *
 * S4.1: Extended with dark mode, main/content tabs, panel sizes, and
 * additional filter state so App.tsx can shed its local useState calls.
 *
 * Persisted fields survive page reloads via zustand/persist → localStorage
 * key 'aps-ui-prefs'.
 */
import { create } from 'zustand';
import { persist } from 'zustand/middleware';
import {
  GanttSettingsState,
  GANTT_SETTINGS_DEFAULTS,
} from '../components/GanttSettings';
import type { FilterGroup, SortSpec } from '../lib/advancedFilter';

export type ColorMode = 'dark' | 'light';
export type GanttColorScheme = 'lateness' | 'workcentre' | 'status';

/** Top-level ribbon tabs */
export const MAIN_TABS = ['file', 'home', 'manage', 'schedule', 'review', 'reports', 'view', 'workflow'] as const;
export type MainTab = typeof MAIN_TABS[number];

/** Content-area sub-tabs (under SCHEDULE / PLAN) */
export type ContentTab =
  | 'gantt' | 'jobtree' | 'resources' | 'constraints' | 'draggable' | 'compare'
  | 'bottleneck' | 'history' | 'kpi' | 'capacity' | 'pegging' | 'whatif'
  | 'materials' | 'constraints-mgmt' | 'leveling' | 'guide' | 'inventory'
  | 'settings' | 'scenarios' | 'dispatch' | 'ctp' | 'changeovers' | 'optimize' | 'bomtree' | 'salesorders';

export type WorkflowJobFilter = 'all' | 'unscheduled' | 'past-due' | 'short-term' | 'long-term';
export type JobPaneMode = 'production' | 'master' | 'mrp';
export type ScheduleAroundMode = 'left' | 'right' | 'both' | 'master';

/** Manage-panel sub-tabs */
export type ManageTab = 'none' | 'workcenters' | 'machines' | 'shifts' | 'crews' | 'alternatives' | 'constraints' | 'import' | 'mapping' | 'interval';

/** Scheduling engine sequencing rule */
export type SchedulingRule = 'priority' | 'edd' | 'fifo' | 'spt' | 'critical-ratio';
/** Forward or backward scheduling direction */
export type SchedulingDirection = 'forward' | 'backward';
/** Whether to anchor dates to Syspro originals or to a manual horizon start */
export type ScheduleDateMode = 'syspro' | 'manual';

/** Returns today's ISO date string (YYYY-MM-DD). */
const today = () => new Date().toISOString().split('T')[0];
/** Returns ISO date string 28 days from now. */
const in28Days = () => new Date(Date.now() + 28 * 24 * 60 * 60 * 1000).toISOString().split('T')[0];

/** Apply dark-mode classes to the document root (called from toggle and on hydration). */
function applyDarkMode(dark: boolean) {
  const root = document.documentElement;
  root.classList.toggle('dark-mode', dark);
  root.setAttribute('data-theme', dark ? 'dark' : 'light');
}

interface UiState {
  // ── Dark mode ────────────────────────────────────────────────────────────
  isDarkMode: boolean;
  toggleDarkMode: () => void;

  // ── Navigation tabs ──────────────────────────────────────────────────────
  mainTab: MainTab;
  setMainTab: (v: MainTab) => void;

  contentTab: ContentTab;
  setContentTab: (v: ContentTab) => void;

  // ── Panel layout ─────────────────────────────────────────────────────────
  workcentrePanelCollapsed: boolean;
  setWorkcentrePanelCollapsed: (v: boolean) => void;

  workcentrePanelWidth: number;
  setWorkcentrePanelWidth: (v: number) => void;

  jobsPanelHeight: number;
  setJobsPanelHeight: (v: number) => void;

  // ── Keyboard-shortcut help overlay ───────────────────────────────────────
  showShortcutsHelp: boolean;
  setShowShortcutsHelp: (v: boolean) => void;

  // ── Sidebar / workcentre panel ───────────────────────────────────────────
  /** Whether the sidebar with workcentres is collapsed */
  sidebarCollapsed: boolean;
  /** Left resource tree (lines → machines); ticks choose the Gantt lanes. */
  showResourceTree: boolean;
  setShowResourceTree: (v: boolean) => void;
  /** Production lines whose Gantt lane is hidden (unticked in the tree). */
  hiddenLanes: string[];
  setHiddenLanes: (v: string[]) => void;
  setSidebarCollapsed: (v: boolean) => void;

  /** Gantt bar colouring scheme selection */
  ganttColorScheme: GanttColorScheme;
  setGanttColorScheme: (v: GanttColorScheme) => void;

  /** Whether the constraint violations panel is expanded (bottom drawer) */
  violationsPanelExpanded: boolean;
  setViolationsPanelExpanded: (v: boolean) => void;

  /** Show/hide the KPI dashboard overlay */
  kpiVisible: boolean;
  setKpiVisible: (v: boolean) => void;

  /** All Gantt display preferences (zoom, colors, row height …) */
  ganttPrefs: GanttSettingsState;
  setGanttPrefs: (next: GanttSettingsState | ((prev: GanttSettingsState) => GanttSettingsState)) => void;

  // ── Search / filter state ────────────────────────────────────────────────
  /** Production-jobs free-text search (raw, unthrottled) */
  jobSearch: string;
  setJobSearch: (v: string) => void;

  /** Production-jobs status filter */
  jobStatusFilter: string;
  setJobStatusFilter: (v: string) => void;

  /** Reset the job-search filters to their defaults */
  resetJobFilters: () => void;

  scheduleFilter: string;
  setScheduleFilter: (v: string) => void;

  jobWcFilter: string;
  setJobWcFilter: (v: string) => void;

  workflowJobFilter: WorkflowJobFilter;
  setWorkflowJobFilter: (v: WorkflowJobFilter) => void;
  /** Workflow advanced filter (AND/OR/group tree). null = inactive. */
  advancedFilter: FilterGroup | null;
  setAdvancedFilter: (v: FilterGroup | null) => void;
  advancedSort: SortSpec[];
  setAdvancedSort: (v: SortSpec[]) => void;

  jobPaneMode: JobPaneMode;
  setJobPaneMode: (v: JobPaneMode) => void;

  scheduleAroundMode: ScheduleAroundMode;
  setScheduleAroundMode: (v: ScheduleAroundMode) => void;

  // ── Manage sub-tab ───────────────────────────────────────────────────────
  manageTab: ManageTab;
  setManageTab: (v: ManageTab) => void;

  // ── Scheduling engine preferences ────────────────────────────────────────
  schedulingRule: SchedulingRule;
  setSchedulingRule: (v: SchedulingRule) => void;

  schedulingDirection: SchedulingDirection;
  setSchedulingDirection: (v: SchedulingDirection) => void;

  scheduleDateMode: ScheduleDateMode;
  setScheduleDateMode: (v: ScheduleDateMode) => void;

  useAlternatives: boolean;
  setUseAlternatives: (updater: boolean | ((prev: boolean) => boolean)) => void;

  // ── Schedule board display interval ──────────────────────────────────────
  boardIntervalStart: string;
  setBoardIntervalStart: (v: string) => void;

  boardIntervalEnd: string;
  setBoardIntervalEnd: (v: string) => void;

  draftIntervalStart: string;
  setDraftIntervalStart: (v: string) => void;

  draftIntervalEnd: string;
  setDraftIntervalEnd: (v: string) => void;

  // ── Planning horizon (used by the scheduler and capacity views) ───────────
  schedulingHorizonStart: string;
  schedulingHorizonEnd: string;
  setSchedulingHorizon: (start: string, end: string) => void;

  // ── Active planning interval (resolved from settings API on login) ─────────
  // Non-persisted. When set and mode !== 'previous-loaded', the board
  // interval is pinned to these dates and Syspro job dates won't override it.
  activePlanningInterval: { mode: string; start: string; end: string } | null;
  setActivePlanningInterval: (v: { mode: string; start: string; end: string } | null) => void;

  // ── Modal open/close flags (kept here so App.tsx sheds useState calls) ────
  showOverrideModal: boolean;
  setShowOverrideModal: (v: boolean) => void;

  showSettingsModal: boolean;
  setShowSettingsModal: (v: boolean) => void;

  showConnectionModal: boolean;
  setShowConnectionModal: (v: boolean) => void;

  /** Live database-diagram (schema) modal. */
  showSchemaModal: boolean;
  setShowSchemaModal: (v: boolean) => void;

  showScheduleSetup: boolean;
  /** Pre-selected job IDs passed into the Schedule Setup modal. */
  scheduleSetupPreselect: string[] | undefined;
  openScheduleSetup: (preselect?: string[]) => void;
  closeScheduleSetup: () => void;
}

export const useUiStore = create<UiState>()(
  persist(
    (set) => ({
      // Dark mode — default to true (dark console look). DOM side effects
      // run in the action so they apply even without a React render cycle.
      isDarkMode: true,
      toggleDarkMode: () =>
        set((s) => {
          const next = !s.isDarkMode;
          applyDarkMode(next);
          return { isDarkMode: next };
        }),

      mainTab: 'manage',
      setMainTab: (v) => set({ mainTab: v }),

      contentTab: 'gantt',
      setContentTab: (v) => set({ contentTab: v }),

      workcentrePanelCollapsed: false,
      setWorkcentrePanelCollapsed: (v) => set({ workcentrePanelCollapsed: v }),

      workcentrePanelWidth: 260,
      setWorkcentrePanelWidth: (v) => set({ workcentrePanelWidth: v }),

      jobsPanelHeight: 340,
      setJobsPanelHeight: (v) => set({ jobsPanelHeight: v }),

      showShortcutsHelp: false,
      setShowShortcutsHelp: (v) => set({ showShortcutsHelp: v }),

      sidebarCollapsed: false,
      showResourceTree: false,
      setShowResourceTree: (v) => set({ showResourceTree: v }),
      hiddenLanes: [],
      setHiddenLanes: (v) => set({ hiddenLanes: v }),
      setSidebarCollapsed: (v) => set({ sidebarCollapsed: v }),

      ganttColorScheme: 'lateness',
      setGanttColorScheme: (v) => set({ ganttColorScheme: v }),

      violationsPanelExpanded: false,
      setViolationsPanelExpanded: (v) => set({ violationsPanelExpanded: v }),

      kpiVisible: true,
      setKpiVisible: (v) => set({ kpiVisible: v }),

      ganttPrefs: { ...GANTT_SETTINGS_DEFAULTS },
      setGanttPrefs: (next) =>
        set((s) => ({
          ganttPrefs:
            typeof next === 'function' ? next(s.ganttPrefs) : next,
        })),

      jobSearch: '',
      setJobSearch: (v) => set({ jobSearch: v }),

      jobStatusFilter: 'all',
      setJobStatusFilter: (v) => set({ jobStatusFilter: v }),

      resetJobFilters: () =>
        set({ jobSearch: '', jobStatusFilter: 'all' }),

      scheduleFilter: 'all',
      setScheduleFilter: (v) => set({ scheduleFilter: v }),

      jobWcFilter: 'all',
      setJobWcFilter: (v) => set({ jobWcFilter: v }),

      workflowJobFilter: 'all',
      setWorkflowJobFilter: (v) => set({ workflowJobFilter: v }),
      advancedFilter: null,
      setAdvancedFilter: (v) => set({ advancedFilter: v }),
      advancedSort: [],
      setAdvancedSort: (v) => set({ advancedSort: v }),

      jobPaneMode: 'production',
      setJobPaneMode: (v) => set({ jobPaneMode: v }),

      scheduleAroundMode: 'both',
      setScheduleAroundMode: (v) => set({ scheduleAroundMode: v }),

      manageTab: 'none',
      setManageTab: (v) => set({ manageTab: v }),

      schedulingRule: 'priority',
      setSchedulingRule: (v) => set({ schedulingRule: v }),

      schedulingDirection: 'forward',
      setSchedulingDirection: (v) => set({ schedulingDirection: v }),

      scheduleDateMode: 'syspro',
      setScheduleDateMode: (v) => set({ scheduleDateMode: v }),

      useAlternatives: false,
      setUseAlternatives: (updater) =>
        set((s) => ({
          useAlternatives: typeof updater === 'function' ? updater(s.useAlternatives) : updater,
        })),

      boardIntervalStart: today(),
      setBoardIntervalStart: (v) => set({ boardIntervalStart: v }),

      boardIntervalEnd: in28Days(),
      setBoardIntervalEnd: (v) => set({ boardIntervalEnd: v }),

      draftIntervalStart: today(),
      setDraftIntervalStart: (v) => set({ draftIntervalStart: v }),

      draftIntervalEnd: in28Days(),
      setDraftIntervalEnd: (v) => set({ draftIntervalEnd: v }),

      schedulingHorizonStart: today(),
      schedulingHorizonEnd: in28Days(),
      setSchedulingHorizon: (start, end) => set({ schedulingHorizonStart: start, schedulingHorizonEnd: end }),

      // Active planning interval resolved from backend settings on login.
      // NOT persisted — recomputed every session from the settings API.
      // When non-null and mode !== 'previous-loaded', the board interval is
      // locked to these dates and will not be overwritten by Syspro job dates.
      activePlanningInterval: null as { mode: string; start: string; end: string } | null,
      setActivePlanningInterval: (v: { mode: string; start: string; end: string } | null) =>
        set({ activePlanningInterval: v }),

      // Modal flags — not persisted (ephemeral open/close state)
      showOverrideModal: false,
      setShowOverrideModal: (v) => set({ showOverrideModal: v }),

      showSettingsModal: false,
      setShowSettingsModal: (v) => set({ showSettingsModal: v }),

      showConnectionModal: false,
      setShowConnectionModal: (v) => set({ showConnectionModal: v }),

      showSchemaModal: false,
      setShowSchemaModal: (v) => set({ showSchemaModal: v }),

      showScheduleSetup: false,
      scheduleSetupPreselect: undefined,
      openScheduleSetup: (preselect) => set({ showScheduleSetup: true, scheduleSetupPreselect: preselect }),
      closeScheduleSetup: () => set({ showScheduleSetup: false, scheduleSetupPreselect: undefined }),
    }),
    {
      name: 'aps-ui-prefs', // localStorage key
      // Persist preferences but not ephemeral filter state
      partialize: (s) => ({
        isDarkMode: s.isDarkMode,
        sidebarCollapsed: s.sidebarCollapsed,
        showResourceTree: s.showResourceTree,
        hiddenLanes: s.hiddenLanes,
        ganttColorScheme: s.ganttColorScheme,
        violationsPanelExpanded: s.violationsPanelExpanded,
        kpiVisible: s.kpiVisible,
        ganttPrefs: s.ganttPrefs,
        mainTab: s.mainTab,
        workcentrePanelCollapsed: s.workcentrePanelCollapsed,
        workcentrePanelWidth: s.workcentrePanelWidth,
        jobsPanelHeight: s.jobsPanelHeight,
        schedulingRule: s.schedulingRule,
        schedulingDirection: s.schedulingDirection,
        scheduleDateMode: s.scheduleDateMode,
        useAlternatives: s.useAlternatives,
        boardIntervalStart: s.boardIntervalStart,
        boardIntervalEnd: s.boardIntervalEnd,
        schedulingHorizonStart: s.schedulingHorizonStart,
        schedulingHorizonEnd: s.schedulingHorizonEnd,
        advancedFilter: s.advancedFilter,
        advancedSort: s.advancedSort,
      }),
      onRehydrateStorage: () => (state) => {
        // Apply dark mode to the DOM as soon as persisted state is loaded.
        if (state) applyDarkMode(state.isDarkMode);
      },
    }
  )
);
