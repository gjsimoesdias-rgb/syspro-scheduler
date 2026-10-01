import React from 'react';
import './GanttSettings.css';
import { Settings } from 'lucide-react';

export type GanttZoom = 'week' | 'day' | 'hour' | 'minute';
export type GanttColorMode = 'workcentre' | 'lateness' | 'status' | 'critical';
export type GanttBarStyle = 'segmented' | 'solid';

export interface GanttSettingsState {
  zoom: GanttZoom;
  colorMode: GanttColorMode;
  barStyle: GanttBarStyle;
  showUtilBars: boolean;
  showShift: boolean;
  showNowLine: boolean;
  showLegend: boolean;
  rowHeight: number;        // px per sub-row slot (16-36)
  barOpacity: number;       // 0.5 – 1.0
  labelMinWidth: number;    // min bar px before label shows (40-200)
  wcColWidth: number;       // 80-200
  machineColWidth: number;  // 120-320
  defaultZoom: GanttZoom;
  highlightWeekends: boolean;
  showDueDate: boolean;     // show due-date marker line on bars
  showOperationSeq: boolean; // show Op-seq number in label
  opBarRadius: number;      // 0-6px
}

export const GANTT_SETTINGS_DEFAULTS: GanttSettingsState = {
  zoom: 'day',
  colorMode: 'workcentre',
  barStyle: 'segmented',
  showUtilBars: true,
  showShift: true,
  showNowLine: true,
  showLegend: false,
  rowHeight: 34,
  barOpacity: 1.0,
  labelMinWidth: 44,
  wcColWidth: 120,
  machineColWidth: 220,
  defaultZoom: 'day',
  highlightWeekends: false,
  showDueDate: false,
  showOperationSeq: true,
  opBarRadius: 5,
};

const STORAGE_KEY = 'gantt_settings_v1';

export function loadGanttSettings(): GanttSettingsState {
  try {
    const raw = localStorage.getItem(STORAGE_KEY);
    if (!raw) return { ...GANTT_SETTINGS_DEFAULTS };
    return { ...GANTT_SETTINGS_DEFAULTS, ...JSON.parse(raw) };
  } catch {
    return { ...GANTT_SETTINGS_DEFAULTS };
  }
}

export function saveGanttSettings(s: GanttSettingsState): void {
  try { localStorage.setItem(STORAGE_KEY, JSON.stringify(s)); } catch { /* storage unavailable — settings stay session-only */ }
}

interface Props {
  settings: GanttSettingsState;
  onChange: (next: GanttSettingsState) => void;
}

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="gs-row">
      <span className="gs-label">{label}</span>
      <div className="gs-control">{children}</div>
    </div>
  );
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="gs-section">
      <div className="gs-section-title">{title}</div>
      {children}
    </div>
  );
}

const GanttSettings: React.FC<Props> = ({ settings, onChange }) => {
  const set = <K extends keyof GanttSettingsState>(key: K, value: GanttSettingsState[K]) =>
    onChange({ ...settings, [key]: value });

  const reset = () => onChange({ ...GANTT_SETTINGS_DEFAULTS });

  return (
    <div className="gantt-settings-panel">
      <div className="gs-header">
        <h2><Settings size={13} className="ui-icon" aria-hidden="true" /> Gantt Board Settings</h2>
        <p>Changes apply instantly and are saved in your browser.</p>
      </div>

      <div className="gs-body">

        {/* ── DISPLAY ── */}
        <Section title="Display">
          <Row label="Default zoom level">
            <select value={settings.defaultZoom} onChange={e => set('defaultZoom', e.target.value as GanttZoom)}>
              <option value="week">Week (56 px/day)</option>
              <option value="day">Day (144 px/day)</option>
              <option value="hour">Hour (288 px/day)</option>
              <option value="minute">Minute (1440 px/day)</option>
            </select>
          </Row>

          <Row label="Colour mode">
            <select value={settings.colorMode} onChange={e => set('colorMode', e.target.value as GanttColorMode)}>
              <option value="workcentre">Workcentre (uniform colour)</option>
              <option value="lateness">Lateness (on-time / at-risk / late)</option>
              <option value="status">Status (constraint violations)</option>
              <option value="critical">Critical path (slack-based)</option>
            </select>
          </Row>

          <Row label="Bar style">
            <select value={settings.barStyle} onChange={e => set('barStyle', e.target.value as GanttBarStyle)}>
              <option value="segmented">Segmented (setup / run phases)</option>
              <option value="solid">Solid (single fill)</option>
            </select>
          </Row>

          <Row label="Bar corner radius">
            <div className="gs-slider-row">
              <input type="range" min={0} max={6} step={1} value={settings.opBarRadius}
                onChange={e => set('opBarRadius', Number(e.target.value))} />
              <span>{settings.opBarRadius}px</span>
            </div>
          </Row>

          <Row label="Bar opacity">
            <div className="gs-slider-row">
              <input type="range" min={0.3} max={1} step={0.05} value={settings.barOpacity}
                onChange={e => set('barOpacity', Number(e.target.value))} />
              <span>{Math.round(settings.barOpacity * 100)}%</span>
            </div>
          </Row>

          <Row label="Highlight weekend columns">
            <label className="gs-toggle">
              <input type="checkbox" checked={settings.highlightWeekends}
                onChange={e => set('highlightWeekends', e.target.checked)} />
              <span className="gs-toggle-slider" />
            </label>
          </Row>
        </Section>

        {/* ── ROWS ── */}
        <Section title="Rows &amp; Columns">
          <Row label="Row slot height">
            <div className="gs-slider-row">
              <input type="range" min={20} max={60} step={2} value={settings.rowHeight}
                onChange={e => set('rowHeight', Number(e.target.value))} />
              <span>{settings.rowHeight}px</span>
            </div>
          </Row>

          <Row label="Workcentre column width">
            <div className="gs-slider-row">
              <input type="range" min={80} max={200} step={10} value={settings.wcColWidth}
                onChange={e => set('wcColWidth', Number(e.target.value))} />
              <span>{settings.wcColWidth}px</span>
            </div>
          </Row>

          <Row label="Machine column width">
            <div className="gs-slider-row">
              <input type="range" min={140} max={320} step={10} value={settings.machineColWidth}
                onChange={e => set('machineColWidth', Number(e.target.value))} />
              <span>{settings.machineColWidth}px</span>
            </div>
          </Row>

          <Row label="Show utilisation bars">
            <label className="gs-toggle">
              <input type="checkbox" checked={settings.showUtilBars}
                onChange={e => set('showUtilBars', e.target.checked)} />
              <span className="gs-toggle-slider" />
            </label>
          </Row>

          <Row label="Show shift info">
            <label className="gs-toggle">
              <input type="checkbox" checked={settings.showShift}
                onChange={e => set('showShift', e.target.checked)} />
              <span className="gs-toggle-slider" />
            </label>
          </Row>
        </Section>

        {/* ── LABELS ── */}
        <Section title="Labels">
          <Row label="Show label when bar is wider than">
            <div className="gs-slider-row">
              <input type="range" min={40} max={200} step={10} value={settings.labelMinWidth}
                onChange={e => set('labelMinWidth', Number(e.target.value))} />
              <span>{settings.labelMinWidth}px</span>
            </div>
          </Row>

          <Row label="Show operation sequence number">
            <label className="gs-toggle">
              <input type="checkbox" checked={settings.showOperationSeq}
                onChange={e => set('showOperationSeq', e.target.checked)} />
              <span className="gs-toggle-slider" />
            </label>
          </Row>
        </Section>

        {/* ── OVERLAYS ── */}
        <Section title="Overlays">
          <Row label="Show 'Now' line">
            <label className="gs-toggle">
              <input type="checkbox" checked={settings.showNowLine}
                onChange={e => set('showNowLine', e.target.checked)} />
              <span className="gs-toggle-slider" />
            </label>
          </Row>

          <Row label="Show legend panel by default">
            <label className="gs-toggle">
              <input type="checkbox" checked={settings.showLegend}
                onChange={e => set('showLegend', e.target.checked)} />
              <span className="gs-toggle-slider" />
            </label>
          </Row>
        </Section>

      </div>

      <div className="gs-footer">
        <button className="gs-reset-btn" onClick={reset}>↺ Reset to defaults</button>
        <span className="gs-saved-note">✓ Saved automatically</span>
      </div>
    </div>
  );
};

export default GanttSettings;
