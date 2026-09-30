import React, { useCallback, useEffect, useState } from 'react';
import toast from 'react-hot-toast';
import { resourceService, CalendarException } from '../services/api';

type Kind = 'closed' | 'short' | 'extra';

const KIND_LABEL: Record<Kind, string> = {
  closed: 'Closed (holiday / shutdown)',
  short: 'Short day or overtime window',
  extra: 'Extra working day (normal shift)',
};

const kindOf = (e: CalendarException): Kind =>
  e.startTime ? 'short' : e.isWorking ? 'extra' : 'closed';

const formatDate = (key: string) =>
  new Date(`${key}T00:00:00`).toLocaleDateString(undefined, { weekday: 'short', day: '2-digit', month: 'short', year: 'numeric' });

/**
 * Calendar exceptions — overrides the weekly shift pattern for specific days.
 * The scheduler, CTP and the optimiser all read these; re-run the schedule
 * after changing them.
 */
const CalendarExceptionsPanel: React.FC<{ onChanged?: () => void }> = ({ onChanged }) => {
  const [items, setItems] = useState<CalendarException[]>([]);
  const [workcentres, setWorkcentres] = useState<Array<{ id: string; name: string }>>([]);
  const [date, setDate] = useState('');
  const [name, setName] = useState('');
  const [scope, setScope] = useState('plant');
  const [kind, setKind] = useState<Kind>('closed');
  const [startTime, setStartTime] = useState('08:00');
  const [endTime, setEndTime] = useState('12:00');
  const [saving, setSaving] = useState(false);
  const [showPast, setShowPast] = useState(false);

  const load = useCallback(async () => {
    try {
      setItems(await resourceService.getCalendarExceptions());
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Could not load calendar exceptions');
    }
  }, []);

  useEffect(() => {
    load();
    resourceService.getWorkcentres()
      .then((rows: any[]) => setWorkcentres((rows || []).map((w) => ({
        id: String(w.worcentreId ?? w.workcentreId ?? w.id),
        name: String(w.name ?? w.worcentreId ?? w.id),
      }))))
      .catch(() => setWorkcentres([]));
  }, [load]);

  const wcName = (id: string) => (id === 'plant' ? 'Whole plant' : workcentres.find((w) => w.id === id)?.name || id);

  const add = async () => {
    if (!date || !name.trim()) {
      toast.error('Date and description are required');
      return;
    }
    setSaving(true);
    try {
      await resourceService.createCalendarException({
        date,
        name: name.trim(),
        scope,
        isWorking: kind !== 'closed',
        ...(kind === 'short' ? { startTime, endTime } : {}),
      });
      toast.success('Calendar exception added — regenerate the schedule to apply it');
      setName('');
      await load();
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Could not add calendar exception');
    } finally {
      setSaving(false);
    }
  };

  const remove = async (e: CalendarException) => {
    if (!window.confirm(`Remove "${e.name}" on ${formatDate(e.date)}?`)) return;
    try {
      await resourceService.deleteCalendarException(e.id);
      await load();
      onChanged?.();
    } catch (err: any) {
      toast.error(err?.response?.data?.error || 'Could not remove calendar exception');
    }
  };

  const today = new Date();
  const todayKey = `${today.getFullYear()}-${String(today.getMonth() + 1).padStart(2, '0')}-${String(today.getDate()).padStart(2, '0')}`;
  const visible = items.filter((e) => showPast || e.date >= todayKey);
  const pastCount = items.length - items.filter((e) => e.date >= todayKey).length;

  return (
    <div className="shifts-table-section calendar-exceptions">
      <h4>Calendar Exceptions</h4>
      <div className="shift-rule-note">
        Public holidays, shutdowns, short days and extra working days. They override the shift pattern for that date;
        a work-centre entry wins over a whole-plant one.
      </div>

      <div className="shift-form-row calendar-exc-form">
        <div className="shift-field">
          <label htmlFor="exc-date">Date</label>
          <input id="exc-date" type="date" value={date} onChange={(e) => setDate(e.target.value)} />
        </div>
        <div className="shift-field calendar-exc-name">
          <label htmlFor="exc-name">Description</label>
          <input id="exc-name" type="text" value={name} maxLength={100} placeholder="e.g. Christmas Day"
            onChange={(e) => setName(e.target.value)} />
        </div>
        <div className="shift-field">
          <label htmlFor="exc-scope">Applies to</label>
          <select id="exc-scope" value={scope} onChange={(e) => setScope(e.target.value)}>
            <option value="plant">Whole plant</option>
            {workcentres.map((w) => <option key={w.id} value={w.id}>{w.name}</option>)}
          </select>
        </div>
        <div className="shift-field">
          <label htmlFor="exc-kind">Type</label>
          <select id="exc-kind" value={kind} onChange={(e) => setKind(e.target.value as Kind)}>
            {(Object.keys(KIND_LABEL) as Kind[]).map((k) => <option key={k} value={k}>{KIND_LABEL[k]}</option>)}
          </select>
        </div>
        {kind === 'short' && (
          <>
            <div className="shift-field">
              <label htmlFor="exc-start">From</label>
              <input id="exc-start" type="time" value={startTime} onChange={(e) => setStartTime(e.target.value)} />
            </div>
            <div className="shift-field">
              <label htmlFor="exc-end">To</label>
              <input id="exc-end" type="time" value={endTime} onChange={(e) => setEndTime(e.target.value)} />
            </div>
          </>
        )}
        <button className="btn btn-primary calendar-exc-add" onClick={add} disabled={saving}>
          {saving ? 'Adding…' : 'Add'}
        </button>
      </div>

      <table className="shifts-table">
        <thead>
          <tr>
            <th>Date</th>
            <th>Description</th>
            <th>Applies to</th>
            <th>Type</th>
            <th>Workable</th>
            <th>Actions</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((e) => (
            <tr key={e.id}>
              <td>{formatDate(e.date)}</td>
              <td><strong>{e.name}</strong></td>
              <td>{wcName(e.scope)}</td>
              <td>{KIND_LABEL[kindOf(e)]}</td>
              <td>{e.startTime ? `${e.startTime}–${e.endTime}` : e.isWorking ? 'Normal shift' : 'None'}</td>
              <td><button className="btn btn-sm" onClick={() => remove(e)}>Remove</button></td>
            </tr>
          ))}
          {visible.length === 0 && (
            <tr><td colSpan={6} className="no-shifts">No upcoming exceptions. Add public holidays above.</td></tr>
          )}
        </tbody>
      </table>
      {pastCount > 0 && (
        <button className="btn btn-sm calendar-exc-past" onClick={() => setShowPast((v) => !v)}>
          {showPast ? 'Hide past dates' : `Show ${pastCount} past date${pastCount === 1 ? '' : 's'}`}
        </button>
      )}
    </div>
  );
};

export default CalendarExceptionsPanel;
