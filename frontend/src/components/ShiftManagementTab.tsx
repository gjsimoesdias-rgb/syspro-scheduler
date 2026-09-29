import React, { useEffect, useState, useCallback } from 'react';
import toast from 'react-hot-toast';
import { resourceService } from '../services/api';
import './ShiftManagementTab.css';

type DiversionType = 'Production' | 'Overtime' | 'Lunch' | 'Break' | 'Non Productive';

interface ShiftDiversion {
  id: string;
  type: DiversionType;
  startTime: string;
  endTime: string;
  schedulable: boolean;
}

interface ShiftTemplate {
  shiftId: string;
  name: string;
  startTime: string;
  endTime: string;
  workingDays: number[];
  hoursPerDay: number;
  diversions?: ShiftDiversion[];
}

type ShiftManagementTabProps = {
  onShiftsChanged?: () => void | Promise<void>;
};

const DIVERSION_TYPES: { value: DiversionType; label: string; schedulable: boolean; color: string }[] = [
  { value: 'Production', label: 'Production', schedulable: true, color: '#3e7fe7' },
  { value: 'Overtime', label: 'Overtime', schedulable: true, color: '#10b981' },
  { value: 'Lunch', label: 'Lunch', schedulable: false, color: '#ef4444' },
  { value: 'Break', label: 'Break', schedulable: false, color: '#f59e0b' },
  { value: 'Non Productive', label: 'Non Productive', schedulable: false, color: '#6b7280' },
];

const weekdayNames = ['Sun', 'Mon', 'Tue', 'Wed', 'Thu', 'Fri', 'Sat'];

const DEFAULT_DIVERSIONS = (): ShiftDiversion[] => [
  { id: `d-${Date.now()}-1`, type: 'Non Productive', startTime: '00:00', endTime: '06:00', schedulable: false },
  { id: `d-${Date.now()}-2`, type: 'Production', startTime: '06:00', endTime: '10:00', schedulable: true },
  { id: `d-${Date.now()}-3`, type: 'Break', startTime: '10:00', endTime: '10:15', schedulable: false },
  { id: `d-${Date.now()}-4`, type: 'Production', startTime: '10:15', endTime: '12:00', schedulable: true },
  { id: `d-${Date.now()}-5`, type: 'Lunch', startTime: '12:00', endTime: '13:00', schedulable: false },
  { id: `d-${Date.now()}-6`, type: 'Production', startTime: '13:00', endTime: '17:00', schedulable: true },
  { id: `d-${Date.now()}-7`, type: 'Overtime', startTime: '17:00', endTime: '19:00', schedulable: true },
  { id: `d-${Date.now()}-8`, type: 'Non Productive', startTime: '19:00', endTime: '23:59', schedulable: false }
];

const timeToMinutes = (value: string): number => {
  if (value === '24:00') return 1440;
  const [hours, minutes] = String(value || '00:00').split(':').map((part) => Number(part) || 0);
  return (hours * 60) + minutes;
};

const getDiversionColor = (type: DiversionType) => {
  return DIVERSION_TYPES.find(t => t.value === type)?.color || '#3e7fe7';
};

const ShiftManagementTab: React.FC<ShiftManagementTabProps> = ({ onShiftsChanged }) => {
  const [shifts, setShifts] = useState<ShiftTemplate[]>([]);
  const [loading, setLoading] = useState(false);
  const [shiftName, setShiftName] = useState('');
  const [shiftDays, setShiftDays] = useState<number[]>([1, 2, 3, 4, 5]);
  const [diversions, setDiversions] = useState<ShiftDiversion[]>(DEFAULT_DIVERSIONS());
  const [editingShiftId, setEditingShiftId] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setLoading(true);
      const response = await resourceService.getDefinitions();
      const loadedShifts = (response.shifts || []).map((s: any) => ({
        ...s,
        diversions: s.diversions || []
      }));
      setShifts(loadedShifts);
    } catch (error: any) {
      toast.error(error.message || 'Failed to load shifts');
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => { load(); }, [load]);

  const resetForm = () => {
    setEditingShiftId(null);
    setShiftName('');
    setShiftDays([1, 2, 3, 4, 5]);
    setDiversions(DEFAULT_DIVERSIONS());
  };

  const toggleDay = (day: number) => {
    setShiftDays(prev =>
      prev.includes(day) ? prev.filter(d => d !== day) : [...prev, day].sort((a, b) => a - b)
    );
  };

  const addDiversion = () => {
    const lastEnd = diversions.length > 0 ? diversions[diversions.length - 1].endTime : '00:00';
    setDiversions(prev => [...prev, {
      id: `d-${Date.now()}`,
      type: 'Non Productive',
      startTime: lastEnd,
      endTime: '23:59',
      schedulable: false
    }]);
  };

  const removeDiversion = (id: string) => {
    setDiversions(prev => prev.filter(d => d.id !== id));
  };

  const updateDiversion = (id: string, field: keyof ShiftDiversion, value: string | boolean) => {
    setDiversions(prev => prev.map(d => {
      if (d.id !== id) return d;
      if (field === 'type') {
        const typeInfo = DIVERSION_TYPES.find(t => t.value === value);
        return { ...d, type: value as DiversionType, schedulable: typeInfo?.schedulable ?? true };
      }
      return { ...d, [field]: value };
    }));
  };

  const validateDiversions = (items: ShiftDiversion[]) => {
    if (items.length === 0) return 'At least one diversion is required';
    const sorted = [...items].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime));
    if (sorted[0].startTime !== '00:00') {
      return 'Diversions must start at 00:00';
    }
    let cursor = 0;
    for (const item of sorted) {
      const start = timeToMinutes(item.startTime);
      const end = timeToMinutes(item.endTime);
      if (end <= start) {
        return `Invalid diversion time range: ${item.startTime} to ${item.endTime}`;
      }
      if (start !== cursor) {
        return 'Diversions must cover the full 24 hours with no gaps or overlaps';
      }
      cursor = end;
    }
    if (cursor < 1439) {
      return 'Diversions must end at 23:59 or 24:00';
    }
    return null;
  };

  const computeHours = (items: ShiftDiversion[] = diversions) => {
    return Math.round(items
      .filter(d => d.schedulable)
      .reduce((total, div) => total + Math.max(0, timeToMinutes(div.endTime) - timeToMinutes(div.startTime)), 0) / 60 * 100) / 100;
  };

  const saveShift = async () => {
    if (!shiftName.trim()) {
      toast.error('Shift name is required');
      return;
    }
    if (shifts.some((shift) => shift.shiftId !== editingShiftId && shift.name.trim().toLowerCase() === shiftName.trim().toLowerCase())) {
      toast.error(`A shift named "${shiftName.trim()}" already exists`);
      return;
    }
    if (shiftDays.length === 0) {
      toast.error('At least one working day is required');
      return;
    }

    const validationError = validateDiversions(diversions);
    if (validationError) {
      toast.error(validationError);
      return;
    }

    const payload = {
      name: shiftName.trim(),
      workingDays: shiftDays,
      hoursPerDay: computeHours(diversions),
      startTime: '00:00',
      endTime: '23:59',
      diversions: [...diversions].sort((a, b) => timeToMinutes(a.startTime) - timeToMinutes(b.startTime))
    };

    try {
      if (editingShiftId) {
        await resourceService.updateShift(editingShiftId, payload);
        toast.success(`Shift "${shiftName}" updated`);
      } else {
        await resourceService.createShift(payload);
        toast.success(`Shift "${shiftName}" created`);
      }
      await load();
      if (onShiftsChanged) {
        await onShiftsChanged();
      }
      resetForm();
    } catch (error: any) {
      toast.error(error.message || 'Failed to save shift');
    }
  };

  const editShift = (shift: ShiftTemplate) => {
    setEditingShiftId(shift.shiftId);
    setShiftName(shift.name);
    setShiftDays([...shift.workingDays]);
    setDiversions(shift.diversions?.length ? shift.diversions.map((div, idx) => ({ ...div, id: div.id || `d-${idx + 1}` })) : DEFAULT_DIVERSIONS());
  };

  const deleteShift = async (shift: ShiftTemplate) => {
    if (shift.shiftId === 'default') {
      toast.error('The default shift cannot be deleted');
      return;
    }

    if (!window.confirm(`Delete shift "${shift.name}"? Machines using it will be reset to Default.`)) {
      return;
    }

    try {
      await resourceService.deleteShift(shift.shiftId);
      await load();
      if (onShiftsChanged) {
        await onShiftsChanged();
      }
      if (editingShiftId === shift.shiftId) {
        resetForm();
      }
      toast.success(`Shift "${shift.name}" deleted`);
    } catch (error: any) {
      toast.error(error.message || 'Failed to delete shift');
    }
  };

  const renderShiftTimeline = (divs: ShiftDiversion[]) => {
    return (
      <div className="shift-timeline-bar">
        {divs.map((div, i) => {
          const divMin = Math.max(0, timeToMinutes(div.endTime) - timeToMinutes(div.startTime));
          const pct = Math.max(0, (divMin / 1440) * 100);
          return (
            <div
              key={i}
              className={`shift-timeline-segment ${div.schedulable ? 'schedulable' : 'non-schedulable'}`}
              style={{ width: `${pct}%`, background: getDiversionColor(div.type) }}
              title={`${div.type}: ${div.startTime} - ${div.endTime}`}
            >
              {pct > 8 && <span className="segment-label">{div.type}</span>}
            </div>
          );
        })}
      </div>
    );
  };

  return (
    <div className="shift-mgmt-tab">
      <div className="shift-mgmt-header">
        <h3>Shift Management</h3>
        <button className="btn btn-sm" onClick={load} disabled={loading}>
          {loading ? 'Loading...' : 'Refresh'}
        </button>
      </div>

      <div className="shift-builder-card">
        <h4>{editingShiftId ? `Edit Shift: ${shiftName}` : 'Create New Shift'}</h4>

        <div className="shift-form-row">
          <div className="shift-field">
            <label>Shift Name</label>
            <input
              value={shiftName}
              onChange={e => setShiftName(e.target.value)}
              placeholder="e.g. Day Shift"
            />
          </div>
          <div className="shift-field">
            <label>Productive Hours</label>
            <input type="text" readOnly value={`${computeHours(diversions)}h`} className="shift-hours-display" />
          </div>
        </div>

        <div className="shift-days-row">
          <label>Working Days</label>
          <div className="weekday-pills">
            {weekdayNames.map((name, idx) => (
              <button
                key={name}
                className={`day-pill ${shiftDays.includes(idx) ? 'active' : ''}`}
                onClick={() => toggleDay(idx)}
              >
                {name}
              </button>
            ))}
          </div>
        </div>

        <div className="diversions-section">
          <div className="diversions-header">
            <label>Diversions</label>
            <button className="btn btn-sm btn-add-div" onClick={addDiversion}>+ Add Diversion</button>
          </div>

          <div className="shift-rule-note">Each shift must define diversions for the full 24 hours from 00:00 to 23:59.</div>

          <div className="diversions-list">
            {diversions.map((div, idx) => (
              <div className="diversion-row" key={div.id}>
                <span className="div-num">{idx + 1}</span>
                <select
                  value={div.type}
                  onChange={e => updateDiversion(div.id, 'type', e.target.value)}
                  className="div-type-select"
                >
                  {DIVERSION_TYPES.map(t => (
                    <option key={t.value} value={t.value}>{t.label}</option>
                  ))}
                </select>
                <input
                  type="time"
                  value={div.startTime}
                  onChange={e => updateDiversion(div.id, 'startTime', e.target.value)}
                />
                <span className="div-to">to</span>
                <input
                  type="time"
                  value={div.endTime}
                  onChange={e => updateDiversion(div.id, 'endTime', e.target.value)}
                />
                <span
                  className={`div-badge ${div.schedulable ? 'schedulable' : 'non-schedulable'}`}
                  style={{ background: getDiversionColor(div.type) }}
                >
                  {div.schedulable ? 'Schedulable' : 'Non Schedulable'}
                </span>
                <button className="div-remove-btn" onClick={() => removeDiversion(div.id)} title="Remove">✕</button>
              </div>
            ))}
          </div>

          <div className="shift-preview">
            <label>24h Preview</label>
            {renderShiftTimeline(diversions)}
            <div className="shift-preview-times">
              <span>00:00</span>
              <span>23:59</span>
            </div>
          </div>
        </div>

        <div className="shift-form-actions">
          {editingShiftId ? (
            <>
              <button className="btn btn-primary" onClick={saveShift}>Save Changes</button>
              <button className="btn btn-sm" onClick={resetForm}>Cancel</button>
            </>
          ) : (
            <button className="btn btn-primary" onClick={saveShift}>Create Shift</button>
          )}
        </div>
      </div>

      <div className="shifts-table-section">
        <h4>Existing Shifts</h4>
        <table className="shifts-table">
          <thead>
            <tr>
              <th>Name</th>
              <th>Working Days</th>
              <th>Productive Hours</th>
              <th>Timeline</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {shifts.map(shift => (
              <tr key={shift.shiftId}>
                <td><strong>{shift.name}</strong></td>
                <td>{shift.workingDays.map(d => weekdayNames[d]).join(', ')}</td>
                <td>{shift.hoursPerDay}h</td>
                <td className="shift-timeline-cell">
                  {renderShiftTimeline(shift.diversions || [])}
                </td>
                <td>
                  <div className="inline-btns">
                    <button className="btn btn-sm" onClick={() => editShift(shift)}>Edit</button>
                    {shift.shiftId !== 'default' && (
                      <button className="btn btn-sm" onClick={() => deleteShift(shift)}>Delete</button>
                    )}
                  </div>
                </td>
              </tr>
            ))}
            {shifts.length === 0 && (
              <tr><td colSpan={5} className="no-shifts">No shifts defined. Create one above.</td></tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="shift-legend">
        {DIVERSION_TYPES.map(t => (
          <span key={t.value} className="shift-legend-item">
            <span className="shift-legend-dot" style={{ background: t.color }} />
            {t.label} ({t.schedulable ? 'Schedulable' : 'Non Schedulable'})
          </span>
        ))}
      </div>
    </div>
  );
};

export default ShiftManagementTab;
