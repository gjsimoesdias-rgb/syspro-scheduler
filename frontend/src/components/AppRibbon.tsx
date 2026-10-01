/**
 * AppRibbon — the horizontal ribbon bar rendered below MainTabs.
 *
 * Reads navigation + scheduling-preference state directly from Zustand stores
 * (useUiStore, useScheduleStore, useAuth) to avoid prop-drilling.  Only the
 * values that live outside the stores (loading flags, DB status, SSE flag and
 * action callbacks that trigger heavy logic in App) are passed as props.
 */
import React from 'react';
import { Trash2, FlaskConical, Clock, Send, Database } from 'lucide-react';
import { useAuth } from '../context/AuthContext';
import {
  useUiStore,
  type WorkflowJobFilter,
} from '../stores/uiStore';
import { useScheduleStore } from '../stores/scheduleStore';
import { toWeekValue, mondayFromWeekValue, sundayOf } from '../utils/weekWindow';

// ── Prop types ─────────────────────────────────────────────────────────────

export interface DbStatus {
  sysproConnected: boolean;
  schedulerConnected: boolean;
  readOnly?: boolean;
  message?: string;
}

export interface AppRibbonProps {
  // Loading flags
  loading: boolean;
  dataLoading: boolean;
  scheduleLoading: boolean;
  connectionLoading: boolean;

  // System / connection state
  dbStatus: DbStatus;
  sseConnected: boolean;

  /** jobId from the currently-open context menu (may be null). */
  contextJobId?: string | null;

  // Action callbacks
  onOpenScheduleSetup: (preselect?: string[]) => void;
  onLoadData: () => void;
  onExportToSyspro: () => void;
  onExport: (format: 'csv' | 'pdf' | 'json') => void;
  onUndo: () => void;
  onRedo: () => void;
  onOpenUserGuide: (section?: 'overview' | 'company' | 'jobs' | 'materials' | 'publish' | 'shortcuts') => void;
  onCreateWhatIf: () => void;
  onClearWhatIf: () => void;
  onOpenConnectionModal: () => void;
  onOpenSettingsModal: () => void;
  onIncludeJob: (jobId: string) => void;
  onExcludeJob: (jobId: string) => void;
  onApplyWorkflowFilter: (filter: WorkflowJobFilter) => void;
  onOpenAdvancedFilter: () => void;
  advancedFilterActive?: boolean;
}

// ── Component ───────────────────────────────────────────────────────────────

const AppRibbon: React.FC<AppRibbonProps> = ({
  loading,
  dataLoading,
  scheduleLoading,
  connectionLoading,
  dbStatus,
  sseConnected,
  onOpenScheduleSetup,
  onLoadData,
  onExportToSyspro,
  onExport,
  onUndo,
  onRedo,
  onOpenUserGuide,
  onCreateWhatIf,
  onClearWhatIf,
  onOpenConnectionModal,
  onOpenSettingsModal,
  onApplyWorkflowFilter,
  onOpenAdvancedFilter,
  advancedFilterActive,
}) => {
  // ── Store reads ─────────────────────────────────────────────────────────
  const mainTab = useUiStore((s) => s.mainTab);
  const manageTab = useUiStore((s) => s.manageTab);
  const setManageTab = useUiStore((s) => s.setManageTab);
  const setMainTab = useUiStore((s) => s.setMainTab);
  const isDarkMode = useUiStore((s) => s.isDarkMode);
  const toggleDarkMode = useUiStore((s) => s.toggleDarkMode);
  const setShowSchemaModal = useUiStore((s) => s.setShowSchemaModal);
  const jobPaneMode = useUiStore((s) => s.jobPaneMode);
  const setJobPaneMode = useUiStore((s) => s.setJobPaneMode);
  const workflowJobFilter = useUiStore((s) => s.workflowJobFilter);
  const schedulingRule = useUiStore((s) => s.schedulingRule);
  const setSchedulingRule = useUiStore((s) => s.setSchedulingRule);
  const schedulingHorizonStart = useUiStore((s) => s.schedulingHorizonStart);
  const schedulingHorizonEnd = useUiStore((s) => s.schedulingHorizonEnd);
  const setSchedulingHorizon = useUiStore((s) => s.setSchedulingHorizon);

  const schedule = useScheduleStore((s) => s.schedule);
  const setSchedule = useScheduleStore((s) => s.setSchedule);
  const whatIfSchedule = useScheduleStore((s) => s.whatIfSchedule);
  const setWhatIfSchedule = useScheduleStore((s) => s.setWhatIfSchedule);
  const undoRedoManager = useScheduleStore((s) => s.undoRedoManager);

  const { user, logout } = useAuth();

  // Snap the planning horizon to the Monday of the picked week; keep the end
  // date if it still lies on/after the new start, otherwise default to Sunday.
  const handlePickWeek = (weekValue: string) => {
    if (!weekValue) return;
    const monday = mondayFromWeekValue(weekValue);
    const end =
      schedulingHorizonEnd && schedulingHorizonEnd >= monday
        ? schedulingHorizonEnd
        : sundayOf(monday);
    setSchedulingHorizon(monday, end);
  };

  // ── Render ───────────────────────────────────────────────────────────────
  return (
    <section className="aps-ribbon">
      {mainTab === 'file' && (
        <>
          <div className="aps-ribbon-group">
            <span className="aps-ribbon-title">COMPANY</span>
            <button className="btn btn-sm" onClick={onOpenConnectionModal} disabled={connectionLoading}>Open Company</button>
            <button className="btn btn-sm" onClick={onLoadData} disabled={dataLoading}>Refresh Data</button>
            <button className="btn btn-sm" onClick={() => logout()}>Close</button>
          </div>
          <div className="aps-ribbon-group">
            <span className="aps-ribbon-title">SETTINGS</span>
            <button className="btn btn-sm" onClick={onOpenSettingsModal}>Settings</button>
            <button className="btn btn-sm" onClick={() => onOpenUserGuide('overview')}>Help</button>
          </div>
        </>
      )}

      {mainTab === 'home' && (
        <div className="aps-ribbon-group">
          <span className="aps-ribbon-title">HOME</span>
          <button className="btn btn-sm" onClick={onLoadData} disabled={dataLoading}>Refresh</button>
          <button className="btn btn-sm" onClick={() => setShowSchemaModal(true)} title="Live database diagram — tables, views & relationships"><Database size={13} aria-hidden="true" /> Schema</button>
          <button className="btn btn-sm" onClick={toggleDarkMode}>{isDarkMode ? 'Light' : 'Dark'}</button>
        </div>
      )}

      {mainTab === 'manage' && (
        <div className="aps-ribbon-group">
          <span className="aps-ribbon-title">FACTORY</span>
          <button className={`btn btn-sm ${manageTab === 'workcenters' ? 'active-tab-btn' : ''}`} onClick={() => setManageTab('workcenters')}>Work Centers</button>
          <button className={`btn btn-sm ${manageTab === 'machines' ? 'active-tab-btn' : ''}`} onClick={() => setManageTab('machines')}>Machines</button>
          <button className={`btn btn-sm ${manageTab === 'alternatives' ? 'active-tab-btn' : ''}`} onClick={() => setManageTab('alternatives')}>Alternatives</button>
          <button className={`btn btn-sm ${manageTab === 'shifts' ? 'active-tab-btn' : ''}`} onClick={() => setManageTab('shifts')}>Shifts</button>
          <button className={`btn btn-sm ${manageTab === 'crews' ? 'active-tab-btn' : ''}`} onClick={() => setManageTab('crews')}>Crews</button>
        </div>
      )}


      {mainTab === 'schedule' && (
        <>
          <div className="aps-ribbon-group">
            <span className="aps-ribbon-title">SCHEDULING</span>
            <button className="btn btn-primary" onClick={() => onOpenScheduleSetup()} disabled={loading || !dbStatus.sysproConnected}>
              {loading ? 'Scheduling...' : 'Autoschedule'}
            </button>
          </div>

          <div className="aps-ribbon-group">
            <span className="aps-ribbon-title">WEEK</span>
            <input
              type="week"
              className="ribbon-select"
              value={toWeekValue(schedulingHorizonStart)}
              onChange={(e) => handlePickWeek(e.target.value)}
              title="Week to schedule — the horizon starts on this week's Monday"
            />
            <input
              type="date"
              className="ribbon-select"
              value={schedulingHorizonEnd}
              min={schedulingHorizonStart}
              onChange={(e) => {
                if (!e.target.value) return;
                const end = e.target.value < schedulingHorizonStart ? schedulingHorizonStart : e.target.value;
                setSchedulingHorizon(schedulingHorizonStart, end);
              }}
              title="Schedule end date — extend beyond Sunday to span more than one week"
            />
          </div>

          <div className="aps-ribbon-group">
            <span className="aps-ribbon-title">RULE</span>
            <select
              className="ribbon-select"
              value={schedulingRule}
              onChange={(e) => setSchedulingRule(e.target.value as typeof schedulingRule)}
              title="Scheduling sequencing rule"
            >
              <option value="priority">Priority</option>
              <option value="edd">Earliest Due Date (EDD)</option>
              <option value="fifo">First In First Out (FIFO)</option>
              <option value="spt">Shortest Processing Time (SPT)</option>
              <option value="critical-ratio">Critical Ratio</option>
            </select>
          </div>

          <div className="aps-ribbon-group">
            <span className="aps-ribbon-title">WHAT-IF</span>
            <button className="btn btn-sm" onClick={onCreateWhatIf}><FlaskConical size={13} aria-hidden="true" /> Plan versions</button>
            {whatIfSchedule && <button className="btn btn-sm" onClick={onClearWhatIf}><Trash2 size={13} aria-hidden="true" /> Clear Scenario</button>}
          </div>

          <div className="aps-ribbon-group">
            <span className="aps-ribbon-title">ACTIONS</span>
            <button
              className="btn btn-sm"
              style={{ color: '#dc2626' }}
              onClick={() => {
                if (schedule && window.confirm('Clear the current schedule? This cannot be undone.')) {
                  setSchedule(null);
                  setWhatIfSchedule(null);
                }
              }}
              disabled={!schedule}
            >
              <Trash2 size={13} aria-hidden="true" /> Clear Schedule
            </button>
            <button
              className="btn btn-primary"
              style={{ background: '#059669' }}
              onClick={onExportToSyspro}
              disabled={loading || !schedule || !dbStatus.sysproConnected}
            >
              {loading ? <><Clock size={13} aria-hidden="true" /> Sending…</> : <><Send size={13} aria-hidden="true" /> Send to Syspro</>}
            </button>
          </div>
        </>
      )}

      {mainTab === 'review' && (
        <div className="aps-ribbon-group">
          <span className="aps-ribbon-title">SCHEDULE</span>
          <button className="btn btn-sm" onClick={onExportToSyspro} disabled={loading || !schedule || !dbStatus.sysproConnected}>
            {scheduleLoading ? '⏳ Restoring…' : 'Save and Publish'}
          </button>
          <button className="btn btn-sm" onClick={onLoadData} disabled={dataLoading}>Refresh</button>
          <button className="btn btn-sm" onClick={onUndo} disabled={loading || !undoRedoManager.canUndo()}>Undo</button>
          <button className="btn btn-sm" onClick={onRedo} disabled={loading || !undoRedoManager.canRedo()}>Redo</button>
        </div>
      )}

      {mainTab === 'reports' && (
        <div className="aps-ribbon-group">
          <span className="aps-ribbon-title">EXPORT</span>
          <button className="btn btn-sm" onClick={() => onExport('csv')} disabled={loading || !schedule}>Production Jobs</button>
          <button className="btn btn-sm" onClick={() => onExport('pdf')} disabled={loading || !schedule}>Schedule report (PDF)</button>
          <button className="btn btn-sm" onClick={() => onExport('json')} disabled={loading || !schedule}>Order Ticket</button>
        </div>
      )}

      {mainTab === 'view' && (
        <>
          <div className="aps-ribbon-group">
            <span className="aps-ribbon-title">VISUAL APS</span>
            <button className="btn btn-sm" onClick={() => { setManageTab('none'); setJobPaneMode('production'); }}>Production Jobs</button>
            <button className="btn btn-sm" onClick={() => { setManageTab('none'); setJobPaneMode('master'); }}>Master Jobs</button>
            <button className="btn btn-sm" onClick={() => { setManageTab('none'); setJobPaneMode('mrp'); }} title="SYSPRO MRP suggested jobs">MRP Jobs</button>
          </div>
          <div className="aps-ribbon-group">
            <span className="aps-ribbon-title">INTERVAL</span>
            <button className={`btn btn-sm ${manageTab === 'interval' ? 'active-tab-btn' : ''}`} onClick={() => setManageTab('interval')}>Set Interval</button>
          </div>
        </>
      )}

      {mainTab === 'workflow' && (
        <div className="aps-ribbon-group">
          <span className="aps-ribbon-title">GLOBAL</span>
          <button className={`btn btn-sm ${workflowJobFilter === 'unscheduled' ? 'active-tab-btn' : ''}`} onClick={() => onApplyWorkflowFilter('unscheduled')}>Unscheduled</button>
          <button className={`btn btn-sm ${workflowJobFilter === 'past-due' ? 'active-tab-btn' : ''}`} onClick={() => onApplyWorkflowFilter('past-due')}>Past Due</button>
          <button className={`btn btn-sm ${workflowJobFilter === 'short-term' ? 'active-tab-btn' : ''}`} onClick={() => onApplyWorkflowFilter('short-term')}>Short Term</button>
          <button className={`btn btn-sm ${workflowJobFilter === 'long-term' ? 'active-tab-btn' : ''}`} onClick={() => onApplyWorkflowFilter('long-term')}>Long Term</button>
          <button className={`btn btn-sm ${advancedFilterActive ? 'active-tab-btn' : ''}`} onClick={onOpenAdvancedFilter} title="Build an AND/OR filter with grouping and sorting">⚙ Advanced Filter{advancedFilterActive ? ' •' : ''}</button>
        </div>
      )}

      <div className="aps-ribbon-status">
        <span className={`status-dot ${dbStatus.sysproConnected ? 'ok' : 'bad'}`} />
        Syspro DB
        <span className={`status-dot ${dbStatus.schedulerConnected ? 'ok' : 'bad'}`} />
        Scheduler DB
        <span
          className={`status-dot ${sseConnected ? 'ok' : 'bad'}`}
          title={sseConnected ? 'Live updates connected' : 'Live updates disconnected'}
        />
        Live
        {user && (
          <>
            <span className="aps-ribbon-sep" aria-hidden="true">|</span>
            <span className="aps-ribbon-user" title={`Role: ${user.role}`}>
              👤 {user.fullName ?? user.username}
            </span>
            <button
              className="aps-ribbon-logout"
              onClick={() => logout()}
              title="Sign out"
              aria-label="Sign out"
            >
              Sign out
            </button>
          </>
        )}
      </div>
    </section>
  );
};

export default AppRibbon;
