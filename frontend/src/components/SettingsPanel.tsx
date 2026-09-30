import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { API_BASE_URL as API } from '../services/api';
import { GanttSettingsState, GANTT_SETTINGS_DEFAULTS } from './GanttSettings';
import UserManagement from './UserManagement';
import LicenseAdmin from './LicenseAdmin';
import './SettingsPanel.css';


// ─── Settings types ────────────────────────────────────────────────────────

interface CompanySettings {
  general: {
    loadCompanyAtStartup: boolean;
    saveWindowsLayout: boolean;
    saveScheduleZoom: boolean;
    savePlanningWarning: boolean;
    showRelatedJobsOnly: boolean;
    theme: string;
  };
  jobManagement: {
    defaultPriority: string;
    defaultDirection: string;
    includeCompletedOps: boolean;
    scheduleWhereStatusComplete: boolean;
    hideCompletedOperations: boolean;
  };
  materials: {
    calculations: string;
    includePastActiveJobs: boolean;
    effectiveStartMode: string;
    todayPlusDays: number;
    specifiedDate: string;
  };
  fcs: {
    designer: {
      wideRowWidth: boolean;
      hideWCWithNoMachines: boolean;
      barHeight: number;
      separationMargin: number;
      labelFontSize: number;
      showShifts: boolean;
      showResources: boolean;
      resourceHideWhenZero: string;
      showAvailableHours: boolean;
      showConsumptionAs: string;
    };
    planningInterval: {
      mode: string;
      fromTodayStartOffset: number;
      fromTodayDurationWeeks: number;
      customFrom: string;
      customTo: string;
    };
    schedulingRules: {
      floatResources: string;
      splitTasks: boolean;
      splitTaskConsumptionMin: boolean;
      splitTaskInterruptionMax: boolean;
      hideCompletedOperations: boolean;
      scheduleWhereStatusComplete: boolean;
      useQueueTime: boolean;
      queueAsHours: boolean;
      queueToNonWorkingTime: boolean;
      autoScheduleNextDay: boolean;
      applyQueueAfterPrevious: boolean;
      useSetupTime: boolean;
      setupFirstJobOnly: boolean;
      skipSetupIfQtyReported: boolean;
      setupApplyEvenNoQty: boolean;
      useWaitTime: boolean;
      useTeardownTime: boolean;
      useMoveTime: boolean;
      moveAsHours: boolean;
      moveToNonWorkingTime: boolean;
      moveAutoNextDay: boolean;
      moveAfterPrevious: boolean;
      useTransfer: boolean;
      transferApplyTo: string;
      overlapPercent?: number;
      schedulingMethod: string;
      forwardFrom: string;
      backwardFrom: string;
      sequenceBy: string;
      linkJobs: boolean;
      machineBalancing: string;
      asap: boolean;
      enforceMaterialConstraints: boolean;
    };
    tracking: {
      showExecutionInJobPanels: boolean;
      runningLateThreshold: number;
      runningEarlyThreshold: number;
      showTimeShiftGreaterThan: number;
    };
  };
}

interface UserSettings {
  gantt: GanttSettingsState;
  ui: { defaultView: string; sidebarCollapsed: boolean };
}

// ─── Tree node type ────────────────────────────────────────────────────────

type TreeSection =
  | 'general' | 'user-access'
  | 'fcs-designer' | 'fcs-interval' | 'fcs-routing' | 'fcs-tracking'
  | 'license-admin'
  | 'my-profile';

interface Props {
  ganttPrefs: GanttSettingsState;
  onGanttPrefsChange: (p: GanttSettingsState) => void;
}

// ─── Helpers ────────────────────────────────────────────────────────────────

function Toggle({ checked, onChange }: { checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="sp-toggle">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      <span className="sp-toggle-slider" />
    </label>
  );
}

function Slider({ value, min, max, step, onChange }: { value: number; min: number; max: number; step?: number; onChange: (v: number) => void }) {
  return (
    <div className="sp-slider-row">
      <input type="range" min={min} max={max} step={step || 1} value={value} onChange={e => onChange(Number(e.target.value))} />
      <input type="number" min={min} max={max} value={value} onChange={e => onChange(Number(e.target.value))} className="sp-num-input" />
    </div>
  );
}

/** Shown next to settings that are saved but not yet used by the scheduler. */
const NOT_APPLIED_TIP = 'Saved, but the scheduler does not use this setting yet';
function NotApplied() {
  return <span className="sp-na" title={NOT_APPLIED_TIP}>not applied yet</span>;
}

function Row({ label, children, notApplied }: { label: string; children: React.ReactNode; notApplied?: boolean }) {
  return <div className="sp-row"><span className="sp-row-label">{label}{notApplied && <NotApplied />}</span><div className="sp-row-ctrl">{children}</div></div>;
}

function CheckRow({ label, checked, onChange, notApplied }: { label: string; checked: boolean; onChange: (v: boolean) => void; notApplied?: boolean }) {
  return (
    <label className="sp-check-row">
      <input type="checkbox" checked={checked} onChange={e => onChange(e.target.checked)} />
      {label}
      {notApplied && <NotApplied />}
    </label>
  );
}

function Tabs({ tabs, active, onChange }: { tabs: string[]; active: string; onChange: (t: string) => void }) {
  return (
    <div className="sp-tabs">
      {tabs.map(t => <button key={t} className={`sp-tab ${active === t ? 'active' : ''}`} onClick={() => onChange(t)}>{t}</button>)}
    </div>
  );
}

function GroupBox({ title, children }: { title: string; children: React.ReactNode }) {
  return <div className="sp-group"><div className="sp-group-title">{title}</div><div className="sp-group-body">{children}</div></div>;
}

// ─── Main component ─────────────────────────────────────────────────────────

const SettingsPanel: React.FC<Props> = ({ ganttPrefs, onGanttPrefsChange }) => {
  const { user, authHeader, isRole } = useAuth();
  const [section, setSection] = useState<TreeSection>('general');
  const [companySettings, setCompanySettings] = useState<CompanySettings | null>(null);
  const [userSettings, setUserSettings] = useState<UserSettings | null>(null);
  const [saving, setSaving] = useState(false);
  const [saved, setSaved] = useState(false);
  const [error, setError] = useState('');

  // ── Hoisted state (must not be inside render fns) ────────────────────────
  const [routingTab, setRoutingTab] = useState('DEFAULT');
  const [currentPw, setCurrentPw] = useState('');
  const [newPw, setNewPw] = useState('');
  const [confirmPw, setConfirmPw] = useState('');
  const [pwMsg, setPwMsg] = useState('');

  const canEditCompany = isRole('super_admin', 'company_admin');
  const isSuperAdmin = isRole('super_admin');

  const fetchSettings = useCallback(async () => {
    try {
      const [csRes, usRes] = await Promise.all([
        fetch(`${API}/settings/company`, { headers: authHeader() }),
        fetch(`${API}/settings/user`, { headers: authHeader() }),
      ]);
      if (csRes.ok) setCompanySettings(await csRes.json());
      if (usRes.ok) {
        const us = await usRes.json();
        setUserSettings(us);
        // Sync gantt prefs from DB
        if (us.gantt) onGanttPrefsChange({ ...GANTT_SETTINGS_DEFAULTS, ...us.gantt });
      }
    } catch (e) {
      console.warn('Could not fetch settings from DB, using local state');
    }
  }, [authHeader, onGanttPrefsChange]);

  useEffect(() => { fetchSettings(); }, []); // eslint-disable-line

  const saveCompany = async () => {
    if (!companySettings) return;
    setSaving(true); setError('');
    try {
      const res = await fetch(`${API}/settings/company`, {
        method: 'PUT',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify(companySettings),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const saveUser = async (updated: UserSettings) => {
    setSaving(true); setError('');
    try {
      const res = await fetch(`${API}/settings/user`, {
        method: 'PUT',
        headers: { ...authHeader(), 'Content-Type': 'application/json' },
        body: JSON.stringify(updated),
      });
      if (!res.ok) throw new Error((await res.json()).error);
      setSaved(true); setTimeout(() => setSaved(false), 2000);
    } catch (e: any) { setError(e.message); }
    finally { setSaving(false); }
  };

  const setCS = (fn: (s: CompanySettings) => CompanySettings) => {
    setCompanySettings(prev => prev ? fn(prev) : prev);
  };

  const setUS = (fn: (s: UserSettings) => UserSettings) => {
    setUserSettings(prev => {
      if (!prev) return prev;
      const next = fn(prev);
      return next;
    });
  };

  const setGantt = (key: keyof GanttSettingsState, value: any) => {
    const next = { ...ganttPrefs, [key]: value };
    onGanttPrefsChange(next);
    if (userSettings) {
      const us = { ...userSettings, gantt: next };
      setUserSettings(us);
      saveUser(us);
    }
  };

  // ── Tree items ────────────────────────────────────────────────────────────

  const TreeItem = ({ id, label, indent }: { id: TreeSection; label: string; indent?: boolean }) => (
    <div
      className={`sp-tree-item${indent ? ' indent' : ''}${section === id ? ' active' : ''}`}
      onClick={() => setSection(id)}
    >
      {label}
    </div>
  );

  const TreeGroup = ({ label }: { label: string }) => (
    <div className="sp-tree-group">
      <span className="sp-tree-arrow">▼</span> {label}
    </div>
  );

  // ── Section renderers ─────────────────────────────────────────────────────

  const renderGeneral = () => (
    <div className="sp-content-area">
      <GroupBox title="General">
        {companySettings && canEditCompany && <>
          <CheckRow label="Load company at startup" checked={companySettings.general.loadCompanyAtStartup}
            onChange={v => setCS(s => ({ ...s, general: { ...s.general, loadCompanyAtStartup: v } }))} />
          <CheckRow label="Save windows layout" checked={companySettings.general.saveWindowsLayout}
            onChange={v => setCS(s => ({ ...s, general: { ...s.general, saveWindowsLayout: v } }))} />
          <CheckRow label="Save schedule zoom" checked={companySettings.general.saveScheduleZoom}
            onChange={v => setCS(s => ({ ...s, general: { ...s.general, saveScheduleZoom: v } }))} />
          <CheckRow label="Save and publish warning message?" checked={companySettings.general.savePlanningWarning}
            onChange={v => setCS(s => ({ ...s, general: { ...s.general, savePlanningWarning: v } }))} />
          <CheckRow label="Show related jobs only" checked={companySettings.general.showRelatedJobsOnly}
            onChange={v => setCS(s => ({ ...s, general: { ...s.general, showRelatedJobsOnly: v } }))} />
          <Row label="Choose theme">
            <select value={companySettings.general.theme}
              onChange={e => setCS(s => ({ ...s, general: { ...s.general, theme: e.target.value } }))}>
              <option value="Blue">Blue</option>
              <option value="Dark">Dark</option>
              <option value="Light">Light</option>
            </select>
          </Row>
        </>}
        {!canEditCompany && <p className="sp-note">Read-only. Contact your administrator to change company settings.</p>}
      </GroupBox>
    </div>
  );

  const renderDesigner = () => {
    const d = companySettings?.fcs?.designer;
    return (
      <div className="sp-content-area">
        <Tabs tabs={['GENERAL', 'TASKS', 'DETAILS']} active="GENERAL" onChange={() => {}} />
        <GroupBox title="Data grid">
          {d && canEditCompany ? <CheckRow label="Wide row width" checked={d.wideRowWidth}
            onChange={v => setCS(s => ({ ...s, fcs: { ...s.fcs, designer: { ...s.fcs.designer, wideRowWidth: v } } }))} />
          : <p className="sp-note">Read-only.</p>}
        </GroupBox>
        <GroupBox title="Factory explorer">
          {d && canEditCompany && <CheckRow label="Hide work centers with no associated machines" checked={d.hideWCWithNoMachines}
            onChange={v => setCS(s => ({ ...s, fcs: { ...s.fcs, designer: { ...s.fcs.designer, hideWCWithNoMachines: v } } }))} />}
        </GroupBox>
        <GroupBox title="Planning board">
          {d && canEditCompany ? <>
            <Row label="Height">
              <Slider value={d.barHeight} min={16} max={60} onChange={v => {
                setCS(s => ({ ...s, fcs: { ...s.fcs, designer: { ...s.fcs.designer, barHeight: v } } }));
                setGantt('rowHeight', Math.round(v * 0.57));
              }} />
            </Row>
            <Row label="Separation margin">
              <Slider value={d.separationMargin} min={0} max={10} onChange={v =>
                setCS(s => ({ ...s, fcs: { ...s.fcs, designer: { ...s.fcs.designer, separationMargin: v } } }))} />
            </Row>
            <Row label="Label font size">
              <Slider value={d.labelFontSize} min={7} max={16} onChange={v =>
                setCS(s => ({ ...s, fcs: { ...s.fcs, designer: { ...s.fcs.designer, labelFontSize: v } } }))} />
            </Row>
            <CheckRow label="Show shifts" checked={d.showShifts}
              onChange={v => {
                setCS(s => ({ ...s, fcs: { ...s.fcs, designer: { ...s.fcs.designer, showShifts: v } } }));
                setGantt('showShift', v);
              }} />
            <CheckRow label="Show resources (utilisation)" checked={d.showResources}
              onChange={v => {
                setCS(s => ({ ...s, fcs: { ...s.fcs, designer: { ...s.fcs.designer, showResources: v } } }));
                setGantt('showUtilBars', v);
              }} />
            <CheckRow label="Show available hours" checked={d.showAvailableHours}
              onChange={v => setCS(s => ({ ...s, fcs: { ...s.fcs, designer: { ...s.fcs.designer, showAvailableHours: v } } }))} />
            <Row label="Show consumption as">
              <label><input type="radio" checked={d.showConsumptionAs === 'equalizer'} onChange={() =>
                setCS(s => ({ ...s, fcs: { ...s.fcs, designer: { ...s.fcs.designer, showConsumptionAs: 'equalizer' } } }))} /> Equalizer</label>
              <label style={{ marginLeft: 10 }}><input type="radio" checked={d.showConsumptionAs === 'lines'} onChange={() =>
                setCS(s => ({ ...s, fcs: { ...s.fcs, designer: { ...s.fcs.designer, showConsumptionAs: 'lines' } } }))} /> Lines</label>
              <label style={{ marginLeft: 10 }}><input type="radio" checked={d.showConsumptionAs === 'text'} onChange={() =>
                setCS(s => ({ ...s, fcs: { ...s.fcs, designer: { ...s.fcs.designer, showConsumptionAs: 'text' } } }))} /> Text</label>
            </Row>
          </> : <p className="sp-note">Read-only.</p>}
        </GroupBox>
      </div>
    );
  };

  const renderInterval = () => {
    const pi = companySettings?.fcs?.planningInterval;
    return (
      <div className="sp-content-area">
        <GroupBox title="Planning interval">
          {pi && canEditCompany ? <>
            <div className="sp-radio-group">
              <label>
                <input type="radio" checked={pi.mode === 'from-today'} onChange={() =>
                  setCS(s => ({ ...s, fcs: { ...s.fcs, planningInterval: { ...s.fcs.planningInterval, mode: 'from-today' } } }))} />
                From today
              </label>
              {pi.mode === 'from-today' && <>
                <div className="sp-sub-row">
                  <span>Start date = current date + days:</span>
                  <input type="number" value={pi.fromTodayStartOffset} className="sp-num-input"
                    onChange={e => setCS(s => ({ ...s, fcs: { ...s.fcs, planningInterval: { ...s.fcs.planningInterval, fromTodayStartOffset: Number(e.target.value) } } }))} />
                </div>
                <div className="sp-sub-row">
                  <span>End date = start date + weeks:</span>
                  <input type="number" value={pi.fromTodayDurationWeeks} className="sp-num-input"
                    onChange={e => setCS(s => ({ ...s, fcs: { ...s.fcs, planningInterval: { ...s.fcs.planningInterval, fromTodayDurationWeeks: Number(e.target.value) } } }))} />
                </div>
              </>}
              <label>
                <input type="radio" checked={pi.mode === 'previous-loaded'} onChange={() =>
                  setCS(s => ({ ...s, fcs: { ...s.fcs, planningInterval: { ...s.fcs.planningInterval, mode: 'previous-loaded' } } }))} />
                Previous loaded
              </label>
              <label>
                <input type="radio" checked={pi.mode === 'custom'} onChange={() =>
                  setCS(s => ({ ...s, fcs: { ...s.fcs, planningInterval: { ...s.fcs.planningInterval, mode: 'custom' } } }))} />
                Custom
              </label>
              {pi.mode === 'custom' && <div className="sp-sub-row">
                <span>From:</span>
                <input type="date" value={pi.customFrom} className="sp-num-input"
                  onChange={e => setCS(s => ({ ...s, fcs: { ...s.fcs, planningInterval: { ...s.fcs.planningInterval, customFrom: e.target.value } } }))} />
                <span>to</span>
                <input type="date" value={pi.customTo} className="sp-num-input"
                  onChange={e => setCS(s => ({ ...s, fcs: { ...s.fcs, planningInterval: { ...s.fcs.planningInterval, customTo: e.target.value } } }))} />
              </div>}
            </div>
          </> : <p className="sp-note">Read-only.</p>}
        </GroupBox>
      </div>
    );
  };

  const renderRoutingRules = () => {
    const r = companySettings?.fcs?.schedulingRules;
    const setR = (key: string, value: any) => {
      if (!canEditCompany) return;
      setCS(s => ({ ...s, fcs: { ...s.fcs, schedulingRules: { ...s.fcs.schedulingRules, [key]: value } } }));
    };
    return (
      <div className="sp-content-area">
        <Tabs tabs={['DEFAULT', 'ROUTING', 'MANUAL', 'AUTO']} active={routingTab} onChange={setRoutingTab} />

        {routingTab === 'DEFAULT' && r && (
          <>
            <GroupBox title="General">
              <Row label="Float resources" notApplied>
                {(['off', 'on', 'specific'] as const).map(v => (
                  <label key={v} style={{ marginRight: 12 }}>
                    <input type="radio" checked={r.floatResources === v} onChange={() => setR('floatResources', v)} disabled={!canEditCompany} />
                    {' '}{v.charAt(0).toUpperCase() + v.slice(1)}
                  </label>
                ))}
              </Row>
              <CheckRow notApplied label="Split tasks" checked={r.splitTasks} onChange={v => setR('splitTasks', v)} />
              {r.splitTasks && <>
                <CheckRow notApplied label="Split Task Consumption (Min)" checked={r.splitTaskConsumptionMin} onChange={v => setR('splitTaskConsumptionMin', v)} />
                <CheckRow notApplied label="Split Task Interruption (Max)" checked={r.splitTaskInterruptionMax} onChange={v => setR('splitTaskInterruptionMax', v)} />
              </>}
            </GroupBox>
            <GroupBox title="Material">
              <CheckRow
                label="Enforce material availability (block jobs with short components)"
                checked={r.enforceMaterialConstraints ?? true}
                onChange={v => setR('enforceMaterialConstraints', v)}
              />
              {(r.enforceMaterialConstraints ?? true) === false && (
                <div style={{ fontSize: 12, opacity: 0.75, padding: '2px 0 4px 24px' }}>
                  Jobs will be scheduled even when components are short. Shortages still appear as warnings in the Constraints tab.
                </div>
              )}
            </GroupBox>
          </>
        )}

        {routingTab === 'ROUTING' && r && (
          <>
            <GroupBox title="General">
              <CheckRow notApplied label="Hide completed operations" checked={r.hideCompletedOperations ?? true} onChange={v => setR('hideCompletedOperations', v)} />
              <CheckRow notApplied label="Schedule where status is complete" checked={r.scheduleWhereStatusComplete ?? true} onChange={v => setR('scheduleWhereStatusComplete', v)} />
            </GroupBox>
            <GroupBox title="Queue">
              <CheckRow label="Use queue time" checked={r.useQueueTime} onChange={v => setR('useQueueTime', v)} />
              {r.useQueueTime && <>
                <CheckRow notApplied label="Apply as hours instead of days" checked={r.queueAsHours} onChange={v => setR('queueAsHours', v)} />
                <CheckRow notApplied label="Apply to non working time" checked={r.queueToNonWorkingTime} onChange={v => setR('queueToNonWorkingTime', v)} />
                <CheckRow notApplied label="Auto schedule to next day" checked={r.autoScheduleNextDay} onChange={v => setR('autoScheduleNextDay', v)} />
                <CheckRow notApplied label="Apply after previous" checked={r.applyQueueAfterPrevious} onChange={v => setR('applyQueueAfterPrevious', v)} />
              </>}
            </GroupBox>
            <GroupBox title="Setup">
              <CheckRow label="Use setup time" checked={r.useSetupTime} onChange={v => setR('useSetupTime', v)} />
              {r.useSetupTime && <>
                <CheckRow label="Setup once per group — same item back-to-back skips setup; same-item jobs due within 7 days run together" checked={r.setupFirstJobOnly} onChange={v => setR('setupFirstJobOnly', v)} />
                <CheckRow notApplied label="Skip if operation has quantity reported" checked={r.skipSetupIfQtyReported} onChange={v => setR('skipSetupIfQtyReported', v)} />
                <CheckRow notApplied label="Apply even when no run or open quantity" checked={r.setupApplyEvenNoQty} onChange={v => setR('setupApplyEvenNoQty', v)} />
              </>}
            </GroupBox>
            <GroupBox title="Move">
              <CheckRow label="Use move time" checked={r.useMoveTime} onChange={v => setR('useMoveTime', v)} />
              {r.useMoveTime && <>
                <CheckRow notApplied label="Apply as hours instead of days" checked={r.moveAsHours} onChange={v => setR('moveAsHours', v)} />
                <CheckRow notApplied label="Apply to non working time" checked={r.moveToNonWorkingTime} onChange={v => setR('moveToNonWorkingTime', v)} />
                <CheckRow notApplied label="Auto schedule to next day" checked={r.moveAutoNextDay} onChange={v => setR('moveAutoNextDay', v)} />
                <CheckRow notApplied label="Apply after previous" checked={r.moveAfterPrevious} onChange={v => setR('moveAfterPrevious', v)} />
              </>}
            </GroupBox>
            <GroupBox title="Transfer/Overlap">
              <CheckRow label="Use transfer (overlap operations)" checked={r.useTransfer} onChange={v => setR('useTransfer', v)} />
              {r.useTransfer && <Row label="Start next operation after % of the previous run">
                <Slider value={r.overlapPercent ?? 100} min={5} max={100} step={5} onChange={v => setR('overlapPercent', v)} />
                <span className="sp-hint">{(r.overlapPercent ?? 100) >= 100 ? 'No overlap — the next operation waits for the previous one to finish' : `Next op starts once ${r.overlapPercent}% of the previous run is done (plus move time); it can't finish before the last batch arrives`}</span>
              </Row>}
              {r.useTransfer && <Row label="Apply to" notApplied>
                <select value={r.transferApplyTo} onChange={e => setR('transferApplyTo', e.target.value)}>
                  <option value="next-operation">Next operation</option>
                  <option value="all">All operations</option>
                </select>
              </Row>}
            </GroupBox>
          </>
        )}

        {routingTab === 'MANUAL' && r && (
          <GroupBox title="General">
            <CheckRow label="Autofit" checked={false} onChange={() => {}} />
            <CheckRow label="Schedule around" checked={true} onChange={() => {}} />
            <CheckRow label="Autoscroll" checked={true} onChange={() => {}} />
          </GroupBox>
        )}

        {routingTab === 'AUTO' && r && (
          <GroupBox title="General">
            <Row label="Scheduling method">
              <label><input type="radio" checked={r.schedulingMethod === 'forward'} onChange={() => setR('schedulingMethod', 'forward')} /> Forward</label>
              <label style={{ marginLeft: 16 }}><input type="radio" checked={r.schedulingMethod === 'backward'} onChange={() => setR('schedulingMethod', 'backward')} /> Backward</label>
            </Row>
            <Row label="Forward from" notApplied>
              {(['interval-start', 'job-start', 'today'] as const).map(v => (
                <label key={v} style={{ marginRight: 10 }}>
                  <input type="radio" checked={r.forwardFrom === v} onChange={() => setR('forwardFrom', v)} disabled={r.schedulingMethod !== 'forward'} />
                  {' '}{v === 'interval-start' ? 'Interval start' : v === 'job-start' ? 'Job/operation start' : 'Today'}
                </label>
              ))}
            </Row>
            <Row label="Sequence by">
              <label><input type="radio" checked={r.sequenceBy === 'grid-grouping'} onChange={() => setR('sequenceBy', 'grid-grouping')} /> Grid grouping</label>
              <label style={{ marginLeft: 16 }}><input type="radio" checked={r.sequenceBy === 'priority-index'} onChange={() => setR('sequenceBy', 'priority-index')} /> Priority index</label>
            </Row>
            <CheckRow notApplied label="Link jobs" checked={r.linkJobs} onChange={v => setR('linkJobs', v)} />
            <Row label="Machine balancing" notApplied>
              <select value={r.machineBalancing} onChange={e => setR('machineBalancing', e.target.value)}>
                <option value="schedule-critical">Schedule (Critical)</option>
                <option value="schedule-primary">Schedule (Primary)</option>
                <option value="schedule-alternatives">Schedule (Alternatives)</option>
                <option value="due-date-critical">Due Date (Critical)</option>
                <option value="due-date-primary">Due Date (Primary)</option>
              </select>
              <label style={{ marginLeft: 16 }}>
                <input type="checkbox" checked={r.asap} onChange={e => setR('asap', e.target.checked)} /> ASAP
              </label>
            </Row>
          </GroupBox>
        )}
      </div>
    );
  };

  const renderTracking = () => {
    const t = companySettings?.fcs?.tracking;
    if (!t) return null;
    return (
      <div className="sp-content-area">
        <GroupBox title="Progress alerts">
          <CheckRow label="Show execution in job panels" checked={t.showExecutionInJobPanels}
            onChange={v => setCS(s => ({ ...s, fcs: { ...s.fcs, tracking: { ...s.fcs.tracking, showExecutionInJobPanels: v } } }))} />
          <Row label="Running late more than">
            <input type="number" value={t.runningLateThreshold} min={0} max={100} className="sp-num-input" disabled={!canEditCompany}
              onChange={e => setCS(s => ({ ...s, fcs: { ...s.fcs, tracking: { ...s.fcs.tracking, runningLateThreshold: Number(e.target.value) } } }))} />
            <span style={{ marginLeft: 4 }}>%</span>
          </Row>
          <Row label="Running early more than">
            <input type="number" value={t.runningEarlyThreshold} min={0} max={100} className="sp-num-input" disabled={!canEditCompany}
              onChange={e => setCS(s => ({ ...s, fcs: { ...s.fcs, tracking: { ...s.fcs.tracking, runningEarlyThreshold: Number(e.target.value) } } }))} />
            <span style={{ marginLeft: 4 }}>%</span>
          </Row>
        </GroupBox>
        <GroupBox title="Track changes">
          <Row label="Show when timeshift greater than">
            <input type="number" value={t.showTimeShiftGreaterThan} min={0} className="sp-num-input" disabled={!canEditCompany}
              onChange={e => setCS(s => ({ ...s, fcs: { ...s.fcs, tracking: { ...s.fcs.tracking, showTimeShiftGreaterThan: Number(e.target.value) } } }))} />
            <span style={{ marginLeft: 4 }}>Hrs</span>
          </Row>
        </GroupBox>
      </div>
    );
  };

  const renderMyProfile = () => {
    const changePassword = async () => {
      if (newPw !== confirmPw) { setPwMsg('New passwords do not match'); return; }
      if (newPw.length < 8) { setPwMsg('New password must be at least 8 characters'); return; }
      try {
        const res = await fetch(`${API}/users/me/change-password`, {
          method: 'POST',
          headers: { ...authHeader(), 'Content-Type': 'application/json' },
          body: JSON.stringify({ currentPassword: currentPw, newPassword: newPw }),
        });
        const data = await res.json();
        if (!res.ok) throw new Error(data.error);
        setPwMsg('Password changed successfully!');
        setCurrentPw(''); setNewPw(''); setConfirmPw('');
      } catch (e: any) { setPwMsg(e.message); }
    };

    return (
      <div className="sp-content-area">
        <GroupBox title="My Profile">
          <Row label="Username"><span className="sp-value-text">{user?.username}</span></Row>
          <Row label="Email"><span className="sp-value-text">{user?.email}</span></Row>
          <Row label="Full name"><span className="sp-value-text">{user?.fullName || '—'}</span></Row>
          <Row label="Role"><span className="sp-badge sp-badge-role">{user?.role?.replace('_', ' ')}</span></Row>
          <Row label="Company"><span className="sp-value-text">{user?.companyName || 'N/A (Super Admin)'}</span></Row>
        </GroupBox>
        <GroupBox title="Gantt Board Preferences">
          <Row label="Default zoom">
            <select value={ganttPrefs.defaultZoom} onChange={e => setGantt('defaultZoom', e.target.value)}>
              <option value="week">Week</option>
              <option value="day">Day</option>
              <option value="hour">Hour</option>
              <option value="minute">Minute</option>
            </select>
          </Row>
          <Row label="Default colour mode">
            <select value={ganttPrefs.colorMode} onChange={e => setGantt('colorMode', e.target.value as any)}>
              <option value="workcentre">Workcentre</option>
              <option value="lateness">Lateness</option>
              <option value="status">Status</option>
              <option value="critical">Critical path</option>
            </select>
          </Row>
          <Row label="Show utilisation bars"><Toggle checked={ganttPrefs.showUtilBars} onChange={v => setGantt('showUtilBars', v)} /></Row>
          <Row label="Show shift info"><Toggle checked={ganttPrefs.showShift} onChange={v => setGantt('showShift', v)} /></Row>
          <Row label="Highlight weekends"><Toggle checked={ganttPrefs.highlightWeekends} onChange={v => setGantt('highlightWeekends', v)} /></Row>
        </GroupBox>
        <GroupBox title="Change Password">
          <Row label="Current password">
            <input type="password" value={currentPw} onChange={e => setCurrentPw(e.target.value)} className="sp-text-input" />
          </Row>
          <Row label="New password">
            <input type="password" value={newPw} onChange={e => setNewPw(e.target.value)} className="sp-text-input" />
          </Row>
          <Row label="Confirm new password">
            <input type="password" value={confirmPw} onChange={e => setConfirmPw(e.target.value)} className="sp-text-input" />
          </Row>
          {pwMsg && <div className={`sp-msg ${pwMsg.includes('success') ? 'ok' : 'err'}`}>{pwMsg}</div>}
          <button className="sp-action-btn" onClick={changePassword}>Change password</button>
        </GroupBox>
      </div>
    );
  };

  // ── Layout ────────────────────────────────────────────────────────────────

  const renderSection = () => {
    switch (section) {
      case 'general': return renderGeneral();
      case 'fcs-designer': return renderDesigner();
      case 'fcs-interval': return renderInterval();
      case 'fcs-routing': return renderRoutingRules();
      case 'fcs-tracking': return renderTracking();
      case 'user-access': return <UserManagement />;
      case 'license-admin': return <LicenseAdmin />;
      case 'my-profile': return renderMyProfile();
      default: return null;
    }
  };

  const isCompanySaving = ['general', 'fcs-designer', 'fcs-interval', 'fcs-routing', 'fcs-tracking'].includes(section);

  return (
    <div className="sp-panel">
      {/* ── Left tree ───────────────────────────────── */}
      <div className="sp-tree">
        <TreeGroup label="SETTINGS" />
        <TreeItem id="general" label="General" indent />
        {canEditCompany && <TreeItem id="user-access" label="User Access" indent />}

        <TreeGroup label="FINITE CAPACITY SCHEDULING" />
        <TreeItem id="fcs-designer" label="Designer" indent />
        <TreeItem id="fcs-interval" label="Planning Interval" indent />
        <TreeItem id="fcs-routing" label="Scheduling &amp; Routing Rules" indent />
        <TreeItem id="fcs-tracking" label="Tracking" indent />

        {isSuperAdmin && <>
          <TreeGroup label="LICENSE MANAGEMENT" />
          <TreeItem id="license-admin" label="Licenses &amp; Companies" indent />
        </>}

        <div className="sp-tree-separator" />
        <TreeItem id="my-profile" label="👤 My Profile &amp; Preferences" />
      </div>

      {/* ── Right panel ─────────────────────────────── */}
      <div className="sp-main">
        {error && <div className="sp-error-bar">{error} <button onClick={() => setError('')}>×</button></div>}
        <div className="sp-scroll">
          {renderSection()}
        </div>

        {/* Footer */}
        <div className="sp-footer">
          <button className="sp-btn sp-btn-reset" onClick={fetchSettings}>↺ Reload</button>
          {isCompanySaving && canEditCompany && (
            <button className="sp-btn sp-btn-save" onClick={saveCompany} disabled={saving}>
              {saving ? 'Saving…' : 'Save'}
            </button>
          )}
          {saved && <span className="sp-saved-note">✓ Saved</span>}
          <div className="sp-footer-spacer" />
          <span className="sp-user-info">Signed in as <strong>{user?.username}</strong> · {user?.role?.replace('_', ' ')}</span>
        </div>
      </div>
    </div>
  );
};

export default SettingsPanel;
