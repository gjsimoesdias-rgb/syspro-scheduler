import React, { useState, useEffect, useCallback } from 'react';
import { useAuth } from '../context/AuthContext';
import { apiJson } from '../services/api';
import './UserManagement.css';
import { errorMessage } from '../utils/errors';


interface User {
  id: number;
  username: string;
  email: string;
  role: string;
  fullName: string | null;
  isActive: boolean;
  lastLogin: string | null;
  companyName: string | null;
  createdAt: string;
}

const ROLE_LABELS: Record<string, string> = {
  super_admin: 'Super Admin',
  company_admin: 'Company Admin',
  planner: 'Planner',
  viewer: 'Viewer',
};

const ROLE_COLORS: Record<string, string> = {
  super_admin: '#7c3aed',
  company_admin: '#2563eb',
  planner: '#059669',
  viewer: '#6b7280',
};

const emptyForm = { username: '', email: '', password: '', role: 'planner', fullName: '' };

const UserManagement: React.FC = () => {
  const { user: me, isRole } = useAuth();
  const [users, setUsers] = useState<User[]>([]);
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [showForm, setShowForm] = useState(false);
  const [editUser, setEditUser] = useState<User | null>(null);
  const [form, setForm] = useState(emptyForm);
  const [saving, setSaving] = useState(false);
  const [confirm, setConfirm] = useState<number | null>(null);

  const load = useCallback(async () => {
    setLoading(true);
    try {
      setUsers(await apiJson('GET', '/users'));
    } catch (e) { setError(errorMessage(e)); }
    finally { setLoading(false); }
  }, []);

  useEffect(() => { load(); }, []); // eslint-disable-line

  const openNew = () => { setEditUser(null); setForm(emptyForm); setShowForm(true); };

  const openEdit = (u: User) => {
    setEditUser(u);
    setForm({ username: u.username, email: u.email, password: '', role: u.role, fullName: u.fullName || '' });
    setShowForm(true);
  };

  const save = async () => {
    if (!form.username || !form.email) { setError('Username and email are required'); return; }
    if (!editUser && !form.password) { setError('Password is required for new users'); return; }
    setSaving(true); setError('');
    try {
      const body: any = { ...form };
      if (editUser && !body.password) delete body.password;
      await apiJson(editUser ? 'PUT' : 'POST', editUser ? `/users/${editUser.id}` : '/users', body);
      setShowForm(false);
      await load();
    } catch (e) { setError(errorMessage(e)); }
    finally { setSaving(false); }
  };

  const toggleActive = async (u: User) => {
    try {
      await apiJson('PUT', `/users/${u.id}`, { isActive: !u.isActive });
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };

  const deleteUser = async (id: number) => {
    try {
      await apiJson('DELETE', `/users/${id}`);
      setConfirm(null);
      await load();
    } catch (e) { setError(errorMessage(e)); }
  };

  const canAdmin = isRole('super_admin', 'company_admin');

  return (
    <div className="um-panel">
      <div className="um-header">
        <div>
          <h3 className="um-title">User Access</h3>
          <p className="um-sub">{users.length} user(s) in your organisation</p>
        </div>
        {canAdmin && <button className="um-add-btn" onClick={openNew}>+ Add User</button>}
      </div>

      {error && <div className="um-error">{error} <button onClick={() => setError('')}>×</button></div>}

      {loading ? <div className="um-loading">Loading users…</div> : (
        <table className="um-table">
          <thead>
            <tr>
              <th>Name / Username</th>
              <th>Email</th>
              <th>Role</th>
              <th>Status</th>
              <th>Last Login</th>
              {canAdmin && <th>Actions</th>}
            </tr>
          </thead>
          <tbody>
            {users.map(u => (
              <tr key={u.id} className={u.isActive ? '' : 'um-row-inactive'}>
                <td>
                  <div className="um-name">{u.fullName || u.username}</div>
                  {u.fullName && <div className="um-username">@{u.username}</div>}
                </td>
                <td>{u.email}</td>
                <td>
                  <span className="um-badge" style={{ background: ROLE_COLORS[u.role] || '#6b7280' }}>
                    {ROLE_LABELS[u.role] || u.role}
                  </span>
                </td>
                <td>
                  <span className={`um-status ${u.isActive ? 'active' : 'inactive'}`}>
                    {u.isActive ? '● Active' : '○ Disabled'}
                  </span>
                </td>
                <td className="um-date">{u.lastLogin ? new Date(u.lastLogin).toLocaleDateString() : '—'}</td>
                {canAdmin && (
                  <td className="um-actions">
                    <button className="um-btn" onClick={() => openEdit(u)}>Edit</button>
                    <button className="um-btn" onClick={() => toggleActive(u)}>
                      {u.isActive ? 'Disable' : 'Enable'}
                    </button>
                    {u.id !== me?.id && (
                      confirm === u.id
                        ? <>
                          <button className="um-btn danger" onClick={() => deleteUser(u.id)}>Confirm delete</button>
                          <button className="um-btn" onClick={() => setConfirm(null)}>Cancel</button>
                        </>
                        : <button className="um-btn danger" onClick={() => setConfirm(u.id)}>Delete</button>
                    )}
                  </td>
                )}
              </tr>
            ))}
          </tbody>
        </table>
      )}

      {showForm && (
        <div className="um-modal-overlay" onClick={() => setShowForm(false)}>
          <div className="um-modal" onClick={e => e.stopPropagation()}>
            <div className="um-modal-header">
              <h3>{editUser ? `Edit ${editUser.username}` : 'Add New User'}</h3>
              <button onClick={() => setShowForm(false)}>×</button>
            </div>
            <div className="um-modal-body">
              {error && <div className="um-error">{error}</div>}
              <label>Full Name
                <input value={form.fullName} onChange={e => setForm(f => ({ ...f, fullName: e.target.value }))} placeholder="Full name (optional)" />
              </label>
              <label>Username *
                <input value={form.username} onChange={e => setForm(f => ({ ...f, username: e.target.value }))} placeholder="Username" />
              </label>
              <label>Email *
                <input type="email" value={form.email} onChange={e => setForm(f => ({ ...f, email: e.target.value }))} placeholder="user@company.com" />
              </label>
              <label>{editUser ? 'New Password (leave blank to keep)' : 'Password *'}
                <input type="password" value={form.password} onChange={e => setForm(f => ({ ...f, password: e.target.value }))} placeholder="Password" />
              </label>
              <label>Role
                <select value={form.role} onChange={e => setForm(f => ({ ...f, role: e.target.value }))}>
                  {isRole('super_admin') && <option value="company_admin">Company Admin</option>}
                  <option value="planner">Planner</option>
                  <option value="viewer">Viewer</option>
                </select>
              </label>
            </div>
            <div className="um-modal-footer">
              <button className="um-btn" onClick={() => setShowForm(false)}>Cancel</button>
              <button className="um-btn primary" onClick={save} disabled={saving}>
                {saving ? 'Saving…' : editUser ? 'Save changes' : 'Create user'}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
};

export default UserManagement;
