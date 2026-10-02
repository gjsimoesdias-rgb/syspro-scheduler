import React, { useState, useEffect, useCallback } from 'react';
import { apiJson } from '../services/api';
import './LicenseAdmin.css';
import { errorMessage } from '../utils/errors';


interface License {
  id: number;
  licenseKey: string;
  companyName: string;
  contactEmail: string | null;
  maxUsers: number;
  currentUsers: number;
  plan: string;
  isActive: boolean;
  expiryDate: string | null;
  notes: string | null;
  sysproCompanyDb: string | null;
  createdAt: string;
}

interface LicUser {
  id: number;
  username: string;
  email: string;
  role: string;
  isActive: boolean;
  lastLogin: string | null;
}

const emptyForm = {
  companyName: '', contactEmail: '', maxUsers: 5,
  plan: 'starter', expiryDate: '', notes: '', sysproCompanyDb: '',
};

const PLAN_OPTIONS = ['starter', 'professional', 'enterprise', 'unlimited'];

const PlanBadge = ({ plan }: { plan: string }) => {
  const colors: Record<string, string> = {
    starter: '#6b7280', professional: '#2563eb',
    enterprise: '#7c3aed', unlimited: '#059669',
  };
  return (
    <span className="la-badge" style={{ background: colors[plan] || '#6b7280' }}>
      {plan.charAt(0).toUpperCase() + plan.slice(1)}
    </span>
  );
};

const LicenseAdmin: React.FC = () => {
  const [licenses, setLicenses] = useState<License[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editLic, setEditLic] = useState<License | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [expandedId, setExpandedId] = useState<number | null>(null);
  const [licUsers, setLicUsers] = useState<LicUser[]>([]);
  const [confirm, setConfirm] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setLicenses(await apiJson('GET', '/licenses'));
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, []); // eslint-disable-line

  const loadUsers = async (id: number) => {
    if (expandedId === id) { setExpandedId(null); return; }
    setExpandedId(id);
    try {
      setLicUsers(await apiJson('GET', `/licenses/${id}/users`));
    } catch (e) { setError(errorMessage(e)); }
  };

  const openNew = () => { setEditLic(null); setForm(emptyForm); setShowForm(true); };

  const openEdit = (l: License) => {
    setEditLic(l);
    setForm({
      companyName: l.companyName, contactEmail: l.contactEmail || '',
      maxUsers: l.maxUsers, plan: l.plan,
      expiryDate: l.expiryDate ? l.expiryDate.slice(0, 10) : '',
      notes: l.notes || '',
      sysproCompanyDb: l.sysproCompanyDb || '',
    });
    setShowForm(true);
  };

  const save = async () => {
    if (!form.companyName) { setError('Company name is required'); return; }
    setSaving(true); setError('');
    try {
      await apiJson(editLic ? 'PUT' : 'POST', editLic ? `/licenses/${editLic.id}` : '/licenses', form);
      setShowForm(false);
      await load();
    } catch (e) { setError(errorMessage(e)); }
    finally { setSaving(false); }
  };

  const toggleActive = async (l: License) => {
    try {
      await apiJson('PUT', `/licenses/${l.id}`, { isActive: !l.isActive });
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };

  const deleteLic = async (id: number) => {
    try {
      await apiJson('DELETE', `/licenses/${id}`);
      setConfirm(null);
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };

  const isExpiring = (l: License) => {
    if (!l.expiryDate) return false;
    const days = (new Date(l.expiryDate).getTime() - Date.now()) / 86400000;
    return days < 30;
  };

  const isExpired = (l: License) => {
    if (!l.expiryDate) return false;
    return new Date(l.expiryDate) < new Date();
  };

  return (
    <div className="la-panel">
      <div className="la-header">
        <div>
          <h3 className="la-title">License Management</h3>
          <p className="la-sub">{licenses.length} license(s) — {licenses.filter(l => l.isActive).length} active</p>
        </div>
        <button className="la-add-btn" onClick={openNew}>+ New License</button>
      </div>

      {error && <div className="la-error">{error} <button onClick={() => setError('')}>×</button></div>}

      {loading ? <div className="la-loading">Loading…</div> : (
        <table className="la-table">
          <thead>
            <tr>
              <th>Company</th>
              <th>License Key</th>
              <th>Plan</th>
              <th>Users</th>
              <th>Status</th>
              <th>Expires</th>
              <th>Actions</th>
            </tr>
          </thead>
          <tbody>
            {licenses.map(l => (
              <React.Fragment key={l.id}>
                <tr className={`la-row ${!l.isActive ? 'la-row-inactive' : ''} ${isExpired(l) ? 'la-row-expired' : ''}`}>
                  <td>
                    <div className="la-company">{l.companyName}</div>
                    {l.contactEmail && <div className="la-email">{l.contactEmail}</div>}
                  </td>
                  <td><code className="la-key">{l.licenseKey}</code></td>
                  <td><PlanBadge plan={l.plan} /></td>
                  <td>
                    <div className="la-users-cell">
                      <span className={l.currentUsers >= l.maxUsers ? 'la-at-limit' : ''}>
                        {l.currentUsers} / {l.maxUsers}
                      </span>
                      <div className="la-user-bar">
                        <div className="la-user-bar-fill" style={{ width: `${Math.min(100, (l.currentUsers / l.maxUsers) * 100)}%` }} />
                      </div>
                    </div>
                  </td>
                  <td>
                    {l.isActive
                      ? <span className="la-status active">● Active</span>
                      : <span className="la-status inactive">○ Disabled</span>}
                  </td>
                  <td>
                    {l.expiryDate
                      ? <span className={isExpired(l) ? 'la-expired' : isExpiring(l) ? 'la-expiring' : ''}>
                        {new Date(l.expiryDate).toLocaleDateString()}
                      </span>
                      : <span className="la-no-expiry">∞ No expiry</span>}
                  </td>
                  <td className="la-actions">
                    <button className="la-btn" onClick={() => loadUsers(l.id)}>
                      {expandedId === l.id ? 'Hide' : 'Users'}
                    </button>
                    <button className="la-btn" onClick={() => openEdit(l)}>Edit</button>
                    <button className="la-btn" onClick={() => toggleActive(l)}>
                      {l.isActive ? 'Disable' : 'Enable'}
                    </button>
                    {confirm === l.id
                      ? <>
                        <button className="la-btn danger" onClick={() => deleteLic(l.id)}>Confirm</button>
                        <button className="la-btn" onClick={() => setConfirm(null)}>Cancel</button>
                      </>
                      : <button className="la-btn danger" onClick={() => setConfirm(l.id)}>Delete</button>}
                  </td>
                </tr>
                {expandedId === l.id && (
                  <tr className="la-expand-row">
                    <td colSpan={7}>
                      <div className="la-users-panel">
                        <strong>Users for {l.companyName}</strong>
                        {licUsers.length === 0 ? <span> — no users yet</span> : (
                          <table className="la-sub-table">
                            <thead>
                              <tr><th>Username</th><th>Email</th><th>Role</th><th>Active</th><th>Last Login</th></tr>
                            </thead>
                            <tbody>
                              {licUsers.map(u => (
                                <tr key={u.id}>
                                  <td>{u.username}</td>
                                  <td>{u.email}</td>
                                  <td>{u.role}</td>
                                  <td>{u.isActive ? '✓' : '✗'}</td>
                                  <td>{u.lastLogin ? new Date(u.lastLogin).toLocaleDateString() : '—'}</td>
                                </tr>
                              ))}
                            </tbody>
                          </table>
                        )}
                      </div>
                    </td>
                  </tr>
                )}
              </React.Fragment>
            ))}
          </tbody>
        </table>
      )}

      {showForm && (
        <div className="la-modal-overlay" onClick={() => setShowForm(false)}>
          <div className="la-modal" onClick={e => e.stopPropagation()}>
            <div className="la-modal-header">
              <h3>{editLic ? `Edit — ${editLic.companyName}` : 'New License'}</h3>
              <button onClick={() => setShowForm(false)}>×</button>
            </div>
            <div className="la-modal-body">
              {error && <div className="la-error">{error}</div>}
              <label>Company Name *
                <input value={form.companyName} onChange={e => setForm(f => ({ ...f, companyName: e.target.value }))} placeholder="Acme Corp" />
              </label>
              <label>Contact Email
                <input type="email" value={form.contactEmail} onChange={e => setForm(f => ({ ...f, contactEmail: e.target.value }))} placeholder="admin@company.com" />
              </label>
              <label>Plan
                <select value={form.plan} onChange={e => setForm(f => ({ ...f, plan: e.target.value }))}>
                  {PLAN_OPTIONS.map(p => <option key={p} value={p}>{p.charAt(0).toUpperCase() + p.slice(1)}</option>)}
                </select>
              </label>
              <label>Max Users
                <input type="number" min={1} max={9999} value={form.maxUsers}
                  onChange={e => setForm(f => ({ ...f, maxUsers: Number(e.target.value) }))} />
              </label>
              <label>Expiry Date (leave blank = no expiry)
                <input type="date" value={form.expiryDate} onChange={e => setForm(f => ({ ...f, expiryDate: e.target.value }))} />
              </label>
              <label>SYSPRO company database
                <input value={form.sysproCompanyDb} onChange={e => setForm(f => ({ ...f, sysproCompanyDb: e.target.value }))} placeholder="e.g. SysproCompanyH" />
                <small>Admins and Windows sign-ins without a company use the settings of the company linked to the connected database. Not needed with a single company.</small>
              </label>
              <label>Notes
                <textarea value={form.notes} onChange={e => setForm(f => ({ ...f, notes: e.target.value }))} rows={2} />
              </label>
            </div>
            <div className="la-modal-footer">
              <button className="la-btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="la-btn primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : editLic ? 'Save changes' : 'Create License'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default LicenseAdmin;
