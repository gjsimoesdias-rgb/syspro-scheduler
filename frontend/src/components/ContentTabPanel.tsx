/**
 * ContentTabPanel — the bottom panel in the workspace.
 *
 * Renders the feature tab bar (Gantt, KPIs, Capacity, …) and the selected
 * tab content.  Reads schedule + UI preferences from Zustand stores and
 * receives data + action callbacks as props.
 */
import React, { lazy, Suspense, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { BarChart2, Target, BookOpen, Factory, Settings2, CalendarCheck, type LucideIcon } from 'lucide-react';
import { useUiStore, type ContentTab } from '../stores/uiStore';
import { useScheduleStore } from '../stores/scheduleStore';
import type { Resource, Job, ConstraintViolation } from '../types';
import type { GanttSettingsState } from './GanttSettings';
import SettingsPanel from './SettingsPanel';

// Lazy tab content
const MachineGanttBoard     = lazy(() => import('./MachineGanttBoard'));
const MasterJobTree         = lazy(() => import('./MasterJobTree'));
const KpiDashboard          = lazy(() => import('./KpiDashboard'));
const CapacityHistogram     = lazy(() => import('./CapacityHistogram'));
const PeggingView           = lazy(() => import('./PeggingView'));
const WhatIfPanel           = lazy(() => import('./WhatIfPanel'));
const ResourceDefinitionTab = lazy(() => import('./ResourceDefinitionTab'));
const ConstraintViolations  = lazy(() => import('./ConstraintViolations'));
const DraggableGantt        = lazy(() => import('./DraggableGantt'));
const ScheduleComparison    = lazy(() => import('./ScheduleComparison'));
const BottleneckAnalysis    = lazy(() => import('./BottleneckAnalysis'));
const AuditLogFeed          = lazy(() => import('./AuditLogFeed'));
const MaterialVisibility    = lazy(() => import('./MaterialVisibility'));
const ConstraintOverride    = lazy(() => import('./ConstraintOverride'));
const ResourceLeveling      = lazy(() => import('./ResourceLeveling'));
const InventoryDashboard    = lazy(() => import('./InventoryDashboard'));
const SalesOrderPegging     = lazy(() => import('./SalesOrderPegging'));
const VersionsPanel         = lazy(() => import('./VersionsPanel'));
const DispatchListView      = lazy(() => import('./DispatchListView'));
const OrderPromisePanel     = lazy(() => import('./OrderPromisePanel'));
const ChangeoverMatrix      = lazy(() => import('./ChangeoverMatrix'));
const OptimizerPanel        = lazy(() => import('./OptimizerPanel'));
const BomTreeView           = lazy(() => import('./BomTreeView'));


// ── Views ─────────────────────────────────────────────────────────────────
// 19 feature tabs grouped into six views, like LYNQ's single planning screen.
type ViewGroupId = 'plan' | 'analyse' | 'materials' | 'versions' | 'promise' | 'setup';
const VIEW_GROUPS: Array<{ id: ViewGroupId; label: string; icon: LucideIcon; tabs: Array<{ id: ContentTab; label: string }> }> = [
  { id: 'plan', label: 'Plan', icon: BarChart2, tabs: [
    { id: 'gantt', label: 'Gantt' }, { id: 'jobtree', label: 'Job tree' },
    { id: 'dispatch', label: 'Dispatch list' }, { id: 'constraints', label: 'Constraints' },
  ] },
  { id: 'analyse', label: 'Analyse', icon: Target, tabs: [
    { id: 'kpi', label: 'KPIs' }, { id: 'capacity', label: 'Capacity' }, { id: 'bottleneck', label: 'Bottleneck' },
    { id: 'leveling', label: 'Leveling' }, { id: 'pegging', label: 'Pegging' },
  ] },
  { id: 'materials', label: 'Materials', icon: Factory, tabs: [
    { id: 'materials', label: 'Material plan' }, { id: 'inventory', label: 'Inventory' }, { id: 'bomtree', label: 'Structure' },
  ] },
  { id: 'versions', label: 'Versions', icon: BookOpen, tabs: [
    { id: 'history', label: 'Plan versions' }, { id: 'optimize', label: 'Optimize rules' }, { id: 'whatif', label: 'Quick what-if' },
  ] },
  { id: 'promise', label: 'Promise', icon: CalendarCheck, tabs: [{ id: 'ctp', label: 'Capable to promise' }, { id: 'salesorders', label: 'Sales orders' }] },
  { id: 'setup', label: 'Setup', icon: Settings2, tabs: [
    { id: 'resources', label: 'Resources' }, { id: 'changeovers', label: 'Changeover matrix' },
  ] },
];
const groupOfTab = (tab: ContentTab) => VIEW_GROUPS.find((g) => g.tabs.some((t) => t.id === tab)) ?? VIEW_GROUPS[0];

// ── Types ────────────────────────────────────────────────────────────────────

export interface ContentTabPanelProps {
  resources: Resource[];
  openJobs: Job[];
  selectedWorkcentre: string[];
  boardIntervalStart: string;
  boardIntervalEnd: string;
  schedulingHorizonStart: string;
  schedulingHorizonEnd: string;
  materialPlan: any[];
  selectedViolation: ConstraintViolation | null;
  loading: boolean;
  previousScheduleForCompare: any | null;

  /** Drives MachineGanttBoard lane focus after a scheduling action or job click. */
  ganttFocusWorkcentre?: string | string[] | null;

  // Gantt action callbacks
  onJobDrop: (jobId: string, dropDate: Date, workcentreId: string, machineId?: string) => void;
  onOperationMove: (jobId: string, opId: string, newStartDate: Date, workcentreId: string, machineId?: string) => void;
  onShowMaterials: (jobId: string) => void;
  /** Gantt toolbar Refresh: reload jobs and resources. */
  onRefresh?: () => void | Promise<void>;
  onHighlightJob: (jobId: string | null) => void;

  // Constraint callbacks
  onSelectViolation: (v: ConstraintViolation | null) => void;
  onShowOverrideModal: (violation: ConstraintViolation) => void;

  // Misc callbacks
  onDraggableMove: (opId: string, newStartDate: Date, newEndDate: Date) => void;
  onRestoreVersion: (versionId: string) => void;
  onLoadData: () => void;
  onCreateWhatIf: () => void;
  onClearWhatIf: () => void;
}

// ── Component ────────────────────────────────────────────────────────────────

const LoadingFallback = () => (
  <div className="tab-loading-spinner" role="status" aria-label="Loading tab…">
    <span className="spinner" />Loading…
  </div>
);

const ContentTabPanel: React.FC<ContentTabPanelProps> = ({
  resources,
  openJobs,
  selectedWorkcentre,
  boardIntervalStart,
  boardIntervalEnd,
  schedulingHorizonStart,
  schedulingHorizonEnd,
  materialPlan,
  selectedViolation,
  loading,
  previousScheduleForCompare,
  ganttFocusWorkcentre,
  onJobDrop,
  onOperationMove,
  onShowMaterials,
  onRefresh,
  onHighlightJob,
  onSelectViolation,
  onShowOverrideModal,
  onDraggableMove,
  onRestoreVersion,
  onLoadData,
  onCreateWhatIf,
  onClearWhatIf,
}) => {
  // ── Store reads ─────────────────────────────────────────────────────────
  const contentTab   = useUiStore((s) => s.contentTab);
  const setContentTab = useUiStore((s) => s.setContentTab);
  const activeVersion = useScheduleStore((s) => s.activeVersion);
  const activeGroup = groupOfTab(contentTab);
  // Each view reopens on the sub-view last used in it.
  const [lastTabByGroup, setLastTabByGroup] = useState<Partial<Record<ViewGroupId, ContentTab>>>({});
  useEffect(() => {
    if (activeGroup.tabs.some((t) => t.id === contentTab)) {
      setLastTabByGroup((m) => (m[activeGroup.id] === contentTab ? m : { ...m, [activeGroup.id]: contentTab }));
    }
  }, [contentTab, activeGroup]);

  // Compare and Scenarios were folded into the Versions tab.
  useEffect(() => {
    if (contentTab === 'compare' || contentTab === 'scenarios') setContentTab('history');
  }, [contentTab, setContentTab]);
  const isDarkMode   = useUiStore((s) => s.isDarkMode);
  const ganttPrefs   = useUiStore((s) => s.ganttPrefs);
  const setGanttPrefs = useUiStore((s) => s.setGanttPrefs);

  const schedule          = useScheduleStore((s) => s.schedule);
  const setSchedule       = useScheduleStore((s) => s.setSchedule);
  const whatIfSchedule    = useScheduleStore((s) => s.whatIfSchedule);
  const whatIfLabel       = useScheduleStore((s) => s.whatIfLabel);
  const undoRedoManager   = useScheduleStore((s) => s.undoRedoManager);
  const highlightJobId    = useScheduleStore((s) => s.highlightJobId);
  const pinnedOps         = useScheduleStore((s) => s.pinnedOps);
  const setPinnedOps      = useScheduleStore((s) => s.setPinnedOps);
  const scheduleVersions  = useScheduleStore((s) => s.scheduleVersions);

  // ── Local state ──────────────────────────────────────────────────────────
  const [showAllOverrides, setShowAllOverrides] = useState(false);

  // The Gantt always shows every workcentre (production line) lane, so it
  // receives the full resource list regardless of any selection.
  const visibleResources = resources;
  void selectedWorkcentre;

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <section className="aps-gantt-panel">
      {/* Tab bar — six views (LYNQ-style) with their sub-views underneath. */}
      <div className="feature-tab-bar feature-group-bar" role="tablist" aria-label="Views">
        {VIEW_GROUPS.map((g) => {
          const active = g.id === activeGroup.id;
          const Icon = g.icon;
          return (
            <button
              key={g.id}
              role="tab"
              aria-selected={active}
              className={`feature-tab feature-group-tab ${active ? 'active' : ''}`}
              onClick={() => setContentTab(lastTabByGroup[g.id] ?? g.tabs[0].id)}
            >
              <Icon size={14} aria-hidden="true" /> {g.label}
              {g.id === 'versions' && activeVersion ? <span className="badge" title={`What-if open: ${activeVersion.name}`}>what-if</span> : null}
              {g.id === 'plan' && schedule?.constraintViolations?.length ? <span className="badge" title="Constraint violations">{schedule.constraintViolations.length}</span> : null}
            </button>
          );
        })}
      </div>
      {activeGroup.tabs.length > 1 && (
        <div className="feature-subtab-bar" role="tablist" aria-label={`${activeGroup.label} views`}>
          {activeGroup.tabs.map((t) => (
            <button
              key={t.id}
              role="tab"
              aria-selected={contentTab === t.id}
              className={`feature-subtab ${contentTab === t.id ? 'active' : ''}`}
              onClick={() => setContentTab(t.id)}
            >
              {t.label}
              {t.id === 'constraints' && schedule?.constraintViolations?.length ? <span className="badge">{schedule.constraintViolations.length}</span> : null}
            </button>
          ))}
        </div>
      )}

      {/* Tab content */}
      <div className="feature-tab-content">
        <Suspense fallback={<LoadingFallback />}>
          {contentTab === 'gantt' && (
            <MachineGanttBoard
              schedule={schedule}
              resources={visibleResources}
              horizonStart={boardIntervalStart}
              horizonEnd={boardIntervalEnd}
              loading={loading}
              highlightJobId={highlightJobId}
              jobs={openJobs}
              ganttPrefs={ganttPrefs}
              onJobDrop={onJobDrop}
              onOperationMove={onOperationMove}
              onHighlightJob={onHighlightJob}
              onShowMaterials={onShowMaterials}
              onRefresh={onRefresh}
              constraintViolations={schedule?.constraintViolations ?? []}
              focusedViolationOpId={selectedViolation?.affectedOperationId}
              focusWorkcentre={ganttFocusWorkcentre}
              externalLockedOps={pinnedOps}
              onLockChange={(key, locked) => {
                const next = new Set(pinnedOps);
                if (locked) next.add(key); else next.delete(key);
                setPinnedOps(next);
              }}
            />
          )}

          {contentTab === 'jobtree' && (
            <MasterJobTree
              jobs={openJobs}
              schedule={schedule}
              highlightJobId={highlightJobId}
              onShowOnGantt={(jobId) => {
                onHighlightJob(jobId);
                setContentTab('gantt');
              }}
            />
          )}

          {contentTab === 'kpi' && (
            <KpiDashboard schedule={schedule} jobsTotal={openJobs.length} />
          )}

          {contentTab === 'capacity' && (
            <CapacityHistogram
              schedule={schedule}
              resources={resources}
              horizonStart={schedulingHorizonStart}
              horizonEnd={schedulingHorizonEnd}
            />
          )}

          {contentTab === 'pegging' && (
            <PeggingView schedule={schedule} jobs={openJobs} />
          )}

          {contentTab === 'whatif' && (
            <WhatIfPanel
              liveSchedule={schedule}
              scenarioSchedule={whatIfSchedule}
              scenarioLabel={whatIfLabel}
              onCreateScenario={onCreateWhatIf}
              onClearScenario={onClearWhatIf}
            />
          )}

          {contentTab === 'resources' && (
            <div className="resources-summary-tab">
              <h3>Resource Summary</h3>
              <p>{resources.length} resources loaded from Syspro</p>
              <ResourceDefinitionTab onDefinitionsChanged={onLoadData} />
            </div>
          )}

          {contentTab === 'constraints' && (
            <div className="constraints-tab">
              <ConstraintViolations
                violations={schedule?.constraintViolations || []}
                jobs={openJobs}
                selectedViolationId={selectedViolation?.violationId}
                onSelect={(v) => {
                  onSelectViolation(v);
                  if (v.affectedJobId) onHighlightJob(v.affectedJobId);
                  setContentTab('gantt');
                }}
              />
              {(schedule?.constraintViolations || []).length > 0 && (
                <div className="constraints-actions">
                  {(schedule?.constraintViolations || []).slice(0, showAllOverrides ? undefined : 8).map((violation) => (
                    <button
                      key={violation.violationId}
                      className="btn btn-sm"
                      onClick={() => onShowOverrideModal(violation)}
                    >
                      Override {violation.type} ({violation.affectedJobId || 'N/A'})
                    </button>
                  ))}
                  {(schedule?.constraintViolations || []).length > 8 && (
                    <button
                      className="btn btn-sm btn-ghost"
                      onClick={() => setShowAllOverrides((p) => !p)}
                    >
                      {showAllOverrides
                        ? 'Show fewer'
                        : `+${(schedule?.constraintViolations || []).length - 8} more`}
                    </button>
                  )}
                </div>
              )}
            </div>
          )}

          {contentTab === 'draggable' && (
            <DraggableGantt schedule={schedule} onJobMoved={onDraggableMove} />
          )}

          {contentTab === 'compare' && (
            <ScheduleComparison
              currentSchedule={schedule}
              previousSchedule={previousScheduleForCompare}
            />
          )}

          {contentTab === 'bottleneck' && (
            <BottleneckAnalysis resourceLoads={schedule?.resourceLoads || []} />
          )}

          {contentTab === 'history' && (
            <div style={{ display: 'flex', gap: '1rem', height: '100%', overflow: 'hidden' }}>
              <div style={{ flex: '0 0 68%', overflowY: 'auto', borderRight: '1px solid var(--border-color, #e5e7eb)', paddingRight: '1rem' }}>
                <VersionsPanel />
              </div>
              <div style={{ flex: 1, overflow: 'hidden', display: 'flex', flexDirection: 'column' }}>
                <AuditLogFeed />
              </div>
            </div>
          )}

          {contentTab === 'materials' && schedule && (
            <MaterialVisibility
              jobSchedules={schedule.jobSchedules}
              jobs={openJobs}
            />
          )}

          {contentTab === 'constraints-mgmt' && (
            <ConstraintOverride
              violations={schedule?.constraintViolations || []}
              onOverride={(violationIds, recalculate) => {
                if (!schedule) return;
                const updated = {
                  ...schedule,
                  constraintViolations: schedule.constraintViolations.map((v) =>
                    violationIds.includes(v.violationId) ? { ...v, overridden: true } : v
                  ),
                };
                setSchedule(updated);
                undoRedoManager.addState(updated, `Override ${violationIds.length} constraint(s)`);
                toast.success(
                  `${violationIds.length} constraint(s) overridden${recalculate ? ' — re-run schedule to apply' : ''}`
                );
              }}
            />
          )}

          {contentTab === 'leveling' && schedule && (
            <ResourceLeveling
              jobSchedules={schedule.jobSchedules}
              onLevel={(optimized) => {
                const updated = { ...schedule, jobSchedules: optimized };
                setSchedule(updated);
                undoRedoManager.addState(updated, 'Resource leveling applied');
                toast.success('Resource leveling applied to schedule');
              }}
            />
          )}

          {contentTab === 'inventory' && (
            <InventoryDashboard isDarkMode={isDarkMode} />
          )}


          {contentTab === 'settings' && (
            <SettingsPanel ganttPrefs={ganttPrefs} onGanttPrefsChange={setGanttPrefs} />
          )}

          {contentTab === 'dispatch' && (
            <DispatchListView schedule={schedule} resources={resources} jobs={openJobs} />
          )}

          {contentTab === 'ctp' && (
            <OrderPromisePanel resources={resources} jobs={openJobs} />
          )}

          {contentTab === 'changeovers' && (
            <ChangeoverMatrix />
          )}

          {contentTab === 'optimize' && (
            <OptimizerPanel />
          )}

          {contentTab === 'salesorders' && (
            <SalesOrderPegging jobSchedules={schedule?.jobSchedules || []} jobs={openJobs} />
          )}

          {contentTab === 'bomtree' && (
            <BomTreeView />
          )}
        </Suspense>
      </div>
    </section>
  );
};
export default ContentTabPanel;
