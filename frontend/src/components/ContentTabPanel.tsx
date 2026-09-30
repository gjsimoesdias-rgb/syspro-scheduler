/**
 * ContentTabPanel — the bottom panel in the workspace.
 *
 * Renders the feature tab bar (Gantt, KPIs, Capacity, …) and the selected
 * tab content.  Reads schedule + UI preferences from Zustand stores and
 * receives data + action callbacks as props.
 */
import React, { lazy, Suspense, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import {
  BarChart2, Target, TrendingUp, FlaskConical, Users, AlertTriangle,
  Zap, BookOpen, Factory, Package, Settings2, GitBranch,
  ClipboardList, CalendarCheck, Timer, Wand2, Link2, Scale, Layers,
} from 'lucide-react';
import { useUiStore } from '../stores/uiStore';
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
const VersionsPanel         = lazy(() => import('./VersionsPanel'));
const DispatchListView      = lazy(() => import('./DispatchListView'));
const OrderPromisePanel     = lazy(() => import('./OrderPromisePanel'));
const ChangeoverMatrix      = lazy(() => import('./ChangeoverMatrix'));
const OptimizerPanel        = lazy(() => import('./OptimizerPanel'));
const BomTreeView           = lazy(() => import('./BomTreeView'));

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
      {/* Tab bar */}
      <div className="feature-tab-bar">
        <button className={`feature-tab ${contentTab === 'gantt' ? 'active' : ''}`} onClick={() => setContentTab('gantt')}><BarChart2 size={13} aria-hidden="true" /> Gantt</button>
        <button className={`feature-tab ${contentTab === 'jobtree' ? 'active' : ''}`} onClick={() => setContentTab('jobtree')}><GitBranch size={13} aria-hidden="true" /> Job Tree</button>
        <button className={`feature-tab ${contentTab === 'kpi' ? 'active' : ''}`} onClick={() => setContentTab('kpi')}><Target size={13} aria-hidden="true" /> KPIs</button>
        <button className={`feature-tab ${contentTab === 'capacity' ? 'active' : ''}`} onClick={() => setContentTab('capacity')}><TrendingUp size={13} aria-hidden="true" /> Capacity</button>
        <button className={`feature-tab ${contentTab === 'whatif' ? 'active' : ''}`} onClick={() => setContentTab('whatif')}><FlaskConical size={13} aria-hidden="true" /> What-If</button>
        <button className={`feature-tab ${contentTab === 'resources' ? 'active' : ''}`} onClick={() => setContentTab('resources')}><Users size={13} aria-hidden="true" /> Resources</button>
        <button className={`feature-tab ${contentTab === 'constraints' ? 'active' : ''}`} onClick={() => setContentTab('constraints')}>
          <AlertTriangle size={13} aria-hidden="true" /> Constraints {schedule?.constraintViolations?.length ? <span className="badge">{schedule.constraintViolations.length}</span> : null}
        </button>
        <button className={`feature-tab ${contentTab === 'bottleneck' ? 'active' : ''}`} onClick={() => setContentTab('bottleneck')}><Zap size={13} aria-hidden="true" /> Bottleneck</button>
        <button className={`feature-tab ${contentTab === 'history' ? 'active' : ''}`} onClick={() => setContentTab('history')}><BookOpen size={13} aria-hidden="true" /> Versions{activeVersion ? <span className="badge" title={`What-if open: ${activeVersion.name}`}>what-if</span> : null}</button>
        <button className={`feature-tab ${contentTab === 'materials' ? 'active' : ''}`} onClick={() => setContentTab('materials')}><Factory size={13} aria-hidden="true" /> Materials</button>
        <button className={`feature-tab ${contentTab === 'inventory' ? 'active' : ''}`} onClick={() => setContentTab('inventory')}><Package size={13} aria-hidden="true" /> Inventory</button>
        <button className={`feature-tab ${contentTab === 'dispatch' ? 'active' : ''}`} onClick={() => setContentTab('dispatch')}><ClipboardList size={13} aria-hidden="true" /> Dispatch</button>
        <button className={`feature-tab ${contentTab === 'ctp' ? 'active' : ''}`} onClick={() => setContentTab('ctp')}><CalendarCheck size={13} aria-hidden="true" /> Promise</button>
        <button className={`feature-tab ${contentTab === 'changeovers' ? 'active' : ''}`} onClick={() => setContentTab('changeovers')}><Timer size={13} aria-hidden="true" /> Changeover Matrix</button>
        <button className={`feature-tab ${contentTab === 'optimize' ? 'active' : ''}`} onClick={() => setContentTab('optimize')}><Wand2 size={13} aria-hidden="true" /> Optimize</button>
        <button className={`feature-tab ${contentTab === 'pegging' ? 'active' : ''}`} onClick={() => setContentTab('pegging')}><Link2 size={13} aria-hidden="true" /> Pegging</button>
        <button className={`feature-tab ${contentTab === 'leveling' ? 'active' : ''}`} onClick={() => setContentTab('leveling')}><Scale size={13} aria-hidden="true" /> Leveling</button>
        <button className={`feature-tab ${contentTab === 'bomtree' ? 'active' : ''}`} onClick={() => setContentTab('bomtree')}><Layers size={13} aria-hidden="true" /> Structure</button>
      </div>

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
              planningHorizonStart={schedule.planningHorizon.startDate}
              planningHorizonEnd={schedule.planningHorizon.endDate}
              materialPlan={materialPlan as any[]}
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

          {contentTab === 'bomtree' && (
            <BomTreeView />
          )}
        </Suspense>
      </div>
    </section>
  );
};
export default ContentTabPanel;
