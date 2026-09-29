import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { statusService, apiErrorMessage } from '../services/api';
import './LoginPage.css';

type SystemState = 'checking' | 'needs-setup' | 'ready';

const LoginPage: React.FC = () => {
  const { login, loginWithNtlm, ntlmAvailable } = useAuth();

  // JWT login state
  const [username, setUsername] = useState('');
  const [loginPassword, setLoginPassword] = useState('');
  // Set only on a brand-new install: the one-time password the server generated
  // for the first 'superadmin' account.
  const [initialAdmin, setInitialAdmin] = useState<{ username: string; password: string } | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [ntlmLoading, setNtlmLoading] = useState(false);
  const [showLoginPassword, setShowLoginPassword] = useState(false);

  // DB setup state
  const [systemState, setSystemState] = useState<SystemState>('checking');
  const [setupForm, setSetupForm] = useState({
    server: '',
    instanceName: '',
    port: '',
    authMode: 'sql',
    userName: 'sa',
    password: '',
    schedulerDatabase: 'SCHEDULER',
  });
  const [showSetupPassword, setShowSetupPassword] = useState(false);
  const [availableCompanies, setAvailableCompanies] = useState<string[]>([]);
  const [selectedCompany, setSelectedCompany] = useState('');
  const [setupLoading, setSetupLoading] = useState(false);
  const [setupError, setSetupError] = useState('');

  // Check if the backend has live DB connections
  useEffect(() => {
    fetch('/health/ready')
      .then(r => r.json())
      .then(data => setSystemState(data.status === 'READY' ? 'ready' : 'needs-setup'))
      .catch(() => setSystemState('needs-setup'));
  }, []);

  // Silently attempt Windows SSO once system is ready
  useEffect(() => {
    if (systemState !== 'ready' || !ntlmAvailable) return;
    setNtlmLoading(true);
    loginWithNtlm().catch(() => setNtlmLoading(false));
  }, [systemState]); // eslint-disable-line

  // DB setup handlers
  const setSetupField = (field: string, value: string) =>
    setSetupForm(prev => ({ ...prev, [field]: value }));

  const handleLoadCompanies = async () => {
    setSetupError('');
    setSetupLoading(true);
    try {
      const payload: Record<string, unknown> = {
        server: setupForm.server.trim(),
        instanceName: setupForm.instanceName.trim(),
        authMode: setupForm.authMode,
        userName: setupForm.userName,
        password: setupForm.password,
      };
      if (setupForm.port.trim()) payload.port = Number(setupForm.port.trim());
      const res = await statusService.getDatabases(payload as any);
      const dbs: string[] = res.databases || [];
      setAvailableCompanies(dbs);
      if (dbs.length > 0) setSelectedCompany(prev => prev || dbs[0]);
      if (dbs.length === 0) setSetupError('Connected but no user databases found.');
    } catch (err: any) {
      setSetupError(apiErrorMessage(err, 'Failed to load databases'));
    } finally {
      setSetupLoading(false);
    }
  };

  const handleConnect = async () => {
    if (!selectedCompany) { setSetupError('Select a company / database first'); return; }
    setSetupError('');
    setSetupLoading(true);
    try {
      const payload: Record<string, unknown> = {
        server: setupForm.server.trim(),
        instanceName: setupForm.instanceName.trim(),
        authMode: setupForm.authMode,
        userName: setupForm.userName,
        password: setupForm.password,
        database: selectedCompany,
        schedulerDatabase: setupForm.schedulerDatabase.trim() || 'SCHEDULER',
      };
      if (setupForm.port.trim()) payload.port = Number(setupForm.port.trim());
      const result = await statusService.connect(payload as any);
      if (result?.initialAdmin?.username && result?.initialAdmin?.password) {
        setInitialAdmin(result.initialAdmin);
        setUsername(result.initialAdmin.username);
        setLoginPassword(result.initialAdmin.password);
      }
      setSystemState('ready');
    } catch (err: any) {
      setSetupError(apiErrorMessage(err, 'Failed to connect'));
    } finally {
      setSetupLoading(false);
    }
  };

  // JWT login handlers
  const handleNtlm = async () => {
    setNtlmLoading(true);
    setError('');
    try {
      await loginWithNtlm();
    } catch (err: any) {
      setError(err.message || 'Windows authentication failed');
      setNtlmLoading(false);
    }
  };

  const handleSubmit = async (e: React.FormEvent) => {
    e.preventDefault();
    if (!username || !loginPassword) { setError('Please enter username and password'); return; }
    setLoading(true);
    setError('');
    try {
      await login(username.trim(), loginPassword);
    } catch (err: any) {
      setError(err.message || 'Login failed');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="login-page">
      <div className={`login-card${systemState === 'needs-setup' ? ' login-card--wide' : ''}`}>
        <div className="login-logo">
          <div className="brand-lockup" aria-label="Ascend APS">
            <div className="brand-icon" />
            <div className="brand-text">
              <span className="brand-ascend">Ascend</span>
              <span className="brand-aps">APS</span>
            </div>
          </div>
        </div>

        {systemState === 'checking' && (
          <p className="login-checking">Connecting&hellip;</p>
        )}

        {systemState === 'needs-setup' && (
          <>
            <h2 className="login-heading">Connect to Database</h2>
            <p className="login-sub">No database connection is configured. Enter your SQL Server details to get started.</p>

            <div className="setup-grid">
              <div className="login-field">
                <label>Server</label>
                <input value={setupForm.server} onChange={e => setSetupField('server', e.target.value)} placeholder="LAPTOP-P002LE98" />
              </div>
              <div className="login-field">
                <label>Instance</label>
                <input value={setupForm.instanceName} onChange={e => setSetupField('instanceName', e.target.value)} placeholder="SQLEXPRESS04" />
              </div>
              <div className="login-field">
                <label>Port <span className="login-hint">(leave blank for named instance)</span></label>
                <input value={setupForm.port} onChange={e => setSetupField('port', e.target.value)} placeholder="1433" />
              </div>
              <div className="login-field">
                <label>Auth Mode</label>
                <select className="login-select" value={setupForm.authMode} onChange={e => setSetupField('authMode', e.target.value)}>
                  <option value="sql">SQL Login</option>
                  <option value="windows">Windows (Integrated)</option>
                </select>
              </div>
              {setupForm.authMode === 'sql' && (
                <div className="login-field">
                  <label>User</label>
                  <input value={setupForm.userName} onChange={e => setSetupField('userName', e.target.value)} placeholder="sa" autoComplete="username" />
                </div>
              )}
              {setupForm.authMode === 'sql' && (
                <div className="login-field">
                  <label>Password</label>
                  <div className="login-pw-wrap">
                    <input
                      type={showSetupPassword ? 'text' : 'password'}
                      value={setupForm.password}
                      onChange={e => setSetupField('password', e.target.value)}
                      autoComplete="current-password"
                    />
                    <button type="button" className="login-pw-toggle" onClick={() => setShowSetupPassword(v => !v)} tabIndex={-1}>
                      {showSetupPassword ? '\uD83D\uDE48' : '\uD83D\uDC41'}
                    </button>
                  </div>
                </div>
              )}
              <div className="login-field setup-full">
                <label>Company / Database</label>
                <div className="setup-db-row">
                  <select
                    className="login-select"
                    value={selectedCompany}
                    onChange={e => setSelectedCompany(e.target.value)}
                    disabled={availableCompanies.length === 0}
                  >
                    <option value="">{availableCompanies.length === 0 ? 'Click Load Companies first' : 'Select database'}</option>
                    {availableCompanies.map(name => (
                      <option key={name} value={name}>{name}</option>
                    ))}
                  </select>
                  <button
                    type="button"
                    className="login-btn-outline"
                    onClick={handleLoadCompanies}
                    disabled={setupLoading || !setupForm.server.trim()}
                  >
                    {setupLoading ? 'Loading\u2026' : 'Load Companies'}
                  </button>
                </div>
              </div>
              <div className="login-field setup-full">
                <label>Scheduler DB <span className="login-hint">(optional)</span></label>
                <input value={setupForm.schedulerDatabase} onChange={e => setSetupField('schedulerDatabase', e.target.value)} placeholder="SCHEDULER" />
              </div>
            </div>

            {setupError && <div className="login-error" role="alert">{setupError}</div>}

            <button
              type="button"
              className="login-btn"
              onClick={handleConnect}
              disabled={setupLoading || !selectedCompany}
              style={{ marginTop: 8 }}
            >
              {setupLoading ? 'Connecting\u2026' : 'Connect'}
            </button>
          </>
        )}

        {systemState === 'ready' && (
          <>
            <h2 className="login-heading">Sign in to your account</h2>

            {initialAdmin && (
              <div className="login-notice" role="status">
                <strong>First admin account created.</strong> Username <code>{initialAdmin.username}</code>, password{' '}
                <code>{initialAdmin.password}</code>. Copy it now — it won&rsquo;t be shown again. Change it after signing
                in (Settings &rsaquo; Users).
              </div>
            )}

            {ntlmAvailable && (
              <div className="login-ntlm-section">
                <button
                  type="button"
                  className="login-ntlm-btn"
                  onClick={handleNtlm}
                  disabled={ntlmLoading || loading}
                >
                  {ntlmLoading
                    ? <span className="login-ntlm-spinner" aria-hidden="true">&#9203;</span>
                    : <span className="login-ntlm-icon" aria-hidden="true">&#129695;</span>}
                  {ntlmLoading ? 'Connecting\u2026' : 'Sign in with Windows'}
                </button>
                <div className="login-divider"><span>or sign in manually</span></div>
              </div>
            )}

            <form className="login-form" onSubmit={handleSubmit} autoComplete="on">
              <div className="login-field">
                <label htmlFor="lp-username">Username or Email</label>
                <input
                  id="lp-username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  placeholder="Enter username or email"
                  disabled={loading || ntlmLoading}
                  autoFocus={!ntlmAvailable}
                />
              </div>

              <div className="login-field">
                <label htmlFor="lp-password">Password</label>
                <div className="login-pw-wrap">
                  <input
                    id="lp-password"
                    type={showLoginPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={e => setLoginPassword(e.target.value)}
                    placeholder="Enter password"
                    disabled={loading || ntlmLoading}
                  />
                  <button
                    type="button"
                    className="login-pw-toggle"
                    onClick={() => setShowLoginPassword(v => !v)}
                    tabIndex={-1}
                    aria-label="Toggle password visibility"
                  >
                    {showLoginPassword ? '\uD83D\uDE48' : '\uD83D\uDC41'}
                  </button>
                </div>
              </div>

              {error && <div className="login-error" role="alert">{error}</div>}

              <button type="submit" className="login-btn" disabled={loading || ntlmLoading}>
                {loading ? 'Signing in\u2026' : 'Sign in'}
              </button>
            </form>
          </>
        )}

        <div className="login-footer">
          Syspro Scheduler v2.0 &nbsp;&middot;&nbsp; &copy; 2026
        </div>
      </div>
    </div>
  );
};

export default LoginPage;
