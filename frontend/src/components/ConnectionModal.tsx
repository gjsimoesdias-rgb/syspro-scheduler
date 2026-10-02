/**
 * ConnectionModal — "Open Company / Database" dialog.
 *
 * Self-contained: owns its own form state and calls the status-service APIs
 * directly.  Emits `onConnected` when the connection succeeds so the parent
 * can refresh its data.
 */
import React, { useState } from 'react';
import toast from 'react-hot-toast';
import { statusService, apiErrorMessage } from '../services/api';

// ── Types ────────────────────────────────────────────────────────────────────

interface ConnectionForm {
  server: string;
  instanceName: string;
  port: string;
  database: string;
  schedulerDatabase: string;
  userName: string;
  password: string;
  authMode: string;
}

export interface ConnectionModalProps {
  open: boolean;
  onClose: () => void;
  /** Called after a successful connection so the parent can reload data. */
  onConnected: () => void;
  /** Initial form values — derived from persisted config if available. */
  initialForm?: Partial<ConnectionForm>;
}

// ── Component ────────────────────────────────────────────────────────────────

const DEFAULT_FORM: ConnectionForm = {
  server: 'localhost',
  instanceName: '',
  port: '',
  database: '',
  schedulerDatabase: '',
  userName: '',
  password: '',
  authMode: 'windows',
};

const ConnectionModal: React.FC<ConnectionModalProps> = ({
  open,
  onClose,
  onConnected,
  initialForm,
}) => {
  const [form, setForm] = useState<ConnectionForm>({ ...DEFAULT_FORM, ...initialForm });
  const [companies, setCompanies] = useState<string[]>([]);
  const [loading, setLoading] = useState(false);

  if (!open) return null;

  const set = (field: keyof ConnectionForm, value: string) =>
    setForm((prev) => ({ ...prev, [field]: value }));

  const handleLoadCompanies = async () => {
    if (!form.server.trim()) {
      toast.error('Server is required');
      return;
    }
    try {
      setLoading(true);
      const response = await statusService.getDatabases({
        ...form,
        port: form.port ? Number(form.port) : undefined,
      });
      const dbs: string[] = response.databases || [];
      setCompanies(dbs);
      if (!form.database && dbs[0]) set('database', dbs[0]);
    } catch (error) {
      const data = (error as { response?: { data?: { error?: string; details?: Array<{ message?: string }> } } } | null)?.response?.data;
      const msg = data?.details?.[0]?.message || data?.error || 'Failed to load company list';
      toast.error(msg);
    } finally {
      setLoading(false);
    }
  };

  const handleConnect = async () => {
    if (!form.database.trim()) {
      toast.error('Select a company / database first');
      return;
    }
    try {
      setLoading(true);
      const response = await statusService.connect({
        ...form,
        port: form.port ? Number(form.port) : undefined,
      });
      toast.success(response.message || 'Connected');
      onClose();
      onConnected();
    } catch (error) {
      console.error('Company connect failed:', error);
      toast.error(apiErrorMessage(error, 'Failed to connect to company database'));
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="modal-overlay" onClick={onClose}>
      <div
        className="shortcuts-modal connection-modal"
        role="dialog"
        aria-modal="true"
        aria-label="Open Company / Database"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="modal-header">
          <h3>Open Company / Database</h3>
          <button className="close-btn" onClick={onClose}>✕</button>
        </div>
        <div className="guide-grid">
          <label className="guide-card">
            <strong>Server</strong>
            <input className="job-search-input" value={form.server} onChange={(e) => set('server', e.target.value)} />
          </label>
          <label className="guide-card">
            <strong>Instance</strong>
            <input className="job-search-input" value={form.instanceName} onChange={(e) => set('instanceName', e.target.value)} />
          </label>
          <label className="guide-card">
            <strong>Port</strong>
            <input className="job-search-input" value={form.port} onChange={(e) => set('port', e.target.value)} />
          </label>
          <label className="guide-card">
            <strong>Auth Mode</strong>
            <select className="job-filter-select" value={form.authMode} onChange={(e) => set('authMode', e.target.value)}>
              <option value="sql">SQL Login</option>
              <option value="windows">Windows</option>
            </select>
          </label>
          {form.authMode === 'sql' && (
            <label className="guide-card">
              <strong>User</strong>
              <input className="job-search-input" value={form.userName} onChange={(e) => set('userName', e.target.value)} />
            </label>
          )}
          {form.authMode === 'sql' && (
            <label className="guide-card">
              <strong>Password</strong>
              <input type="password" className="job-search-input" value={form.password} onChange={(e) => set('password', e.target.value)} />
            </label>
          )}
          <label className="guide-card">
            <strong>Company / Database</strong>
            <select className="job-filter-select" value={form.database} onChange={(e) => set('database', e.target.value)}>
              <option value="">Select database</option>
              {companies.map((name) => (
                <option key={name} value={name}>{name}</option>
              ))}
            </select>
          </label>
          <label className="guide-card">
            <strong>Scheduler DB (optional)</strong>
            <input className="job-search-input" value={form.schedulerDatabase} onChange={(e) => set('schedulerDatabase', e.target.value)} />
          </label>
        </div>
        <div className="inline-btns">
          <button className="btn btn-sm" onClick={handleLoadCompanies} disabled={loading}>Load Companies</button>
          <button className="btn btn-primary" onClick={handleConnect} disabled={loading}>Connect</button>
        </div>
      </div>
    </div>
  );
};

export default ConnectionModal;
