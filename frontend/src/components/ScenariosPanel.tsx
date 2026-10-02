/**
 * ScenariosPanel — scenario branching UI (#64).
 *
 * Lists saved scenarios for the current schedule, lets an Approver clone
 * the live schedule into a named scenario, and promotes a scenario to live.
 */

import React, { useEffect, useState, useCallback } from 'react';
import './ScenariosPanel.css';
import { apiClient, apiErrorMessage } from '../services/api';
import { confirmDialog } from './DialogHost';

// ── Types ─────────────────────────────────────────────────────────────────────

interface Scenario {
  ScenarioId: string;
  BaseScheduleId: string;
  Name: string;
  Description?: string;
  Status: 'Draft' | 'Promoted' | 'Archived';
  CreatedBy: string;
  CreatedAt: string;
  PromotedAt?: string;
}

interface ScenariosPanelProps {
  /** ID of the currently active schedule — used as the base for new scenarios. */
  currentScheduleId: string | null;
}

// ── Helpers ───────────────────────────────────────────────────────────────────

function fmtDate(iso: string): string {
  try {
    return new Date(iso).toLocaleString([], {
      year: 'numeric',
      month: 'short',
      day: '2-digit',
      hour: '2-digit',
      minute: '2-digit',
    });
  } catch {
    return iso;
  }
}

// ── Component ─────────────────────────────────────────────────────────────────

const ScenariosPanel: React.FC<ScenariosPanelProps> = ({ currentScheduleId }) => {
  const [scenarios, setScenarios] = useState<Scenario[]>([]);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [toast, setToast] = useState<{ msg: string; ok: boolean } | null>(null);

  // Create form
  const [newName, setNewName] = useState('');
  const [newDesc, setNewDesc] = useState('');
  const [creating, setCreating] = useState(false);
  const [promoting, setPromoting] = useState<string | null>(null);
  const [deleting, setDeleting] = useState<string | null>(null);

  const showToast = (msg: string, ok = true) => {
    setToast({ msg, ok });
    setTimeout(() => setToast(null), 4000);
  };

  const loadScenarios = useCallback(async () => {
    setLoading(true);
    setError(null);
    try {
      // apiClient adds the signed-in user's token (the old code read a
      // localStorage key that was never set, so every call returned 401).
      const { data } = await apiClient.get('/scenarios', {
        params: currentScheduleId ? { baseScheduleId: currentScheduleId } : undefined,
      });
      setScenarios(data.scenarios ?? []);
    } catch (e: any) {
      setError(apiErrorMessage(e, 'Failed to load scenarios'));
    } finally {
      setLoading(false);
    }
  }, [currentScheduleId]);

  useEffect(() => {
    loadScenarios();
  }, [loadScenarios]);

  const handleCreate = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!currentScheduleId) {
      showToast('No active schedule to branch from', false);
      return;
    }
    if (!newName.trim()) {
      showToast('Enter a scenario name', false);
      return;
    }
    setCreating(true);
    try {
      await apiClient.post('/scenarios', {
        baseScheduleId: currentScheduleId,
        name: newName.trim(),
        description: newDesc.trim() || undefined,
      });
      setNewName('');
      setNewDesc('');
      showToast('Scenario created');
      await loadScenarios();
    } catch (e: any) {
      showToast(apiErrorMessage(e, 'Failed to create scenario'), false);
    } finally {
      setCreating(false);
    }
  };

  const handlePromote = async (scenarioId: string, name: string) => {
    if (!(await confirmDialog({ title: 'Promote scenario', message: `Promote "${name}" to the live schedule? This will replace the current live schedule.`, confirmLabel: 'Promote' }))) return;
    setPromoting(scenarioId);
    try {
      await apiClient.post(`/scenarios/${encodeURIComponent(scenarioId)}/promote`);
      showToast(`"${name}" promoted to live schedule. Reload to see changes.`);
      await loadScenarios();
    } catch (e: any) {
      showToast(apiErrorMessage(e, 'Failed to promote scenario'), false);
    } finally {
      setPromoting(null);
    }
  };

  const handleDelete = async (scenarioId: string, name: string) => {
    if (!(await confirmDialog({ title: 'Delete scenario', message: `Delete scenario "${name}"?`, confirmLabel: 'Delete', danger: true }))) return;
    setDeleting(scenarioId);
    try {
      await apiClient.delete(`/scenarios/${encodeURIComponent(scenarioId)}`);
      showToast(`Scenario "${name}" deleted`);
      await loadScenarios();
    } catch (e: any) {
      showToast(apiErrorMessage(e, 'Failed to delete scenario'), false);
    } finally {
      setDeleting(null);
    }
  };

  return (
    <div className="scenarios-panel">
      {/* Toast */}
      {toast && (
        <div className={`scenarios-toast ${toast.ok ? 'ok' : 'err'}`} role="status">
          {toast.msg}
        </div>
      )}

      <div className="scenarios-header">
        <h2 className="scenarios-title">Scenario Branching</h2>
        <p className="scenarios-desc">
          Clone the current schedule into a named scenario to explore &quot;what-if&quot; alternatives.
          Promote a scenario to replace the live schedule.
        </p>
      </div>

      {/* Create form */}
      <form className="scenarios-create-form" onSubmit={handleCreate}>
        <h3>New Scenario</h3>
        {!currentScheduleId && (
          <p className="scenarios-warn">Generate a schedule first to enable scenario branching.</p>
        )}
        <div className="scenarios-form-row">
          <input
            className="scenarios-input"
            type="text"
            placeholder="Scenario name *"
            value={newName}
            onChange={(e) => setNewName(e.target.value)}
            disabled={!currentScheduleId || creating}
            maxLength={120}
          />
          <input
            className="scenarios-input"
            type="text"
            placeholder="Description (optional)"
            value={newDesc}
            onChange={(e) => setNewDesc(e.target.value)}
            disabled={!currentScheduleId || creating}
          />
          <button
            type="submit"
            className="btn btn-primary scenarios-create-btn"
            disabled={!currentScheduleId || creating || !newName.trim()}
          >
            {creating ? 'Creating…' : '+ Branch'}
          </button>
        </div>
      </form>

      {/* Scenario list */}
      <div className="scenarios-list-header">
        <h3>Saved Scenarios {scenarios.length > 0 && <span className="scenarios-count">({scenarios.length})</span>}</h3>
        <button className="btn btn-sm" onClick={loadScenarios} disabled={loading}>
          {loading ? '' : '↻ Refresh'}
        </button>
      </div>

      {error && <div className="scenarios-error" role="alert">{error}</div>}

      {!loading && scenarios.length === 0 && !error && (
        <div className="scenarios-empty">No scenarios yet. Branch the current schedule to get started.</div>
      )}

      <ul className="scenarios-list">
        {scenarios.map((s) => (
          <li key={s.ScenarioId} className={`scenarios-item status-${s.Status.toLowerCase()}`}>
            <div className="scenarios-item-main">
              <span className="scenarios-item-name">{s.Name}</span>
              <span className={`scenarios-badge badge-${s.Status.toLowerCase()}`}>{s.Status}</span>
            </div>
            {s.Description && <p className="scenarios-item-desc">{s.Description}</p>}
            <div className="scenarios-item-meta">
              <span>Created by {s.CreatedBy} · {fmtDate(s.CreatedAt)}</span>
              {s.PromotedAt && <span> · Promoted {fmtDate(s.PromotedAt)}</span>}
            </div>
            <div className="scenarios-item-actions">
              {s.Status === 'Draft' && (
                <>
                  <button
                    className="btn btn-sm btn-primary"
                    onClick={() => handlePromote(s.ScenarioId, s.Name)}
                    disabled={promoting === s.ScenarioId || !!deleting}
                  >
                    {promoting === s.ScenarioId ? 'Promoting…' : '↑ Promote to Live'}
                  </button>
                  <button
                    className="btn btn-sm btn-danger"
                    onClick={() => handleDelete(s.ScenarioId, s.Name)}
                    disabled={!!deleting || !!promoting}
                  >
                    {deleting === s.ScenarioId ? 'Deleting…' : 'Delete'}
                  </button>
                </>
              )}
            </div>
          </li>
        ))}
      </ul>
    </div>
  );
};

export default ScenariosPanel;
