import React, { useState, useEffect } from 'react';
import { useAuth } from '../context/AuthContext';
import { statusService, apiErrorMessage } from '../services/api';
import './LoginPage.css';
import CruxLogo from '../components/CruxLogo';
import { KeyRound } from 'lucide-react';
import { errorMessage } from '../utils/errors';

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
      const res = await statusService.getDatabases(payload as Parameters<typeof statusService.getDatabases>[0]);
      const dbs: string[] = res.databases || [];
      setAvailableCompanies(dbs);
      if (dbs.length > 0) setSelectedCompany(prev => prev || dbs[0]);
      if (dbs.length === 0) setSetupError('Connected but no user databases found.');
    } catch (err) {
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
      const result = await statusService.connect(payload as Parameters<typeof statusService.connect>[0]);
      if (result?.initialAdmin?.username && result?.initialAdmin?.password) {
        setInitialAdmin(result.initialAdmin);
        setUsername(result.initialAdmin.username);
        setLoginPassword(result.initialAdmin.password);
      }
      setSystemState('ready');
    } catch (err) {
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
    } catch (err) {
      setError(errorMessage(err, 'Windows authentication failed'));
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
    } catch (err) {
      setError(errorMessage(err, 'Login failed'));
    } finally {
      setLoading(false);
    }
  };

  const [showForgot, setShowForgot] = useState(false);

  return (
    <div className="login-page">
      <aside className="login-hero" aria-hidden="true">
        <div className="login-hero-grid" />
        <svg className="login-hero-gantt" viewBox="0 0 800 520" preserveAspectRatio="xMidYMid slice">
          {GANTT_ROWS.map((row, r) => (
            <g key={r} className={`lh-row lh-row-${r % 3}`}>
              <line x1="0" x2="800" y1={40 + r * 64} y2={40 + r * 64} className="lh-rule" />
              {row.map(([x, w, accent], i) => (
                <rect key={i} x={x} y={52 + r * 64} width={w} height="26" rx="5"
                  className={accent ? 'lh-bar lh-bar-accent' : 'lh-bar'} />
              ))}
            </g>
          ))}
          <line x1="520" x2="520" y1="20" y2="500" className="lh-now" />
        </svg>
        <div className="login-hero-shade" />
        <div className="login-hero-copy">
          <CruxLogo variant="full" height={170} className="login-hero-logo" />
          <p className="login-hero-tag">Finite-capacity scheduling for SYSPRO</p>
          <ul className="login-hero-points">
            <li>Every line, every job — scheduled to real capacity</li>
            <li>What-if versions before you commit</li>
            <li>Dates straight back to SYSPRO</li>
          </ul>
        </div>
      </aside>

      <main className="login-panel">
        <div className={`login-form-wrap${systemState === 'needs-setup' ? ' login-form-wrap--wide' : ''}`}>
          <div className="login-mobile-logo">
            <CruxLogo variant="full" height={110} />
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
            <h1 className="login-heading">Welcome back to CRUX APS</h1>

            {initialAdmin && (
              <div className="login-notice" role="status">
                <strong>First admin account created.</strong> Username <code>{initialAdmin.username}</code>, password{' '}
                <code>{initialAdmin.password}</code>. Copy it now — it won&rsquo;t be shown again. Change it after signing
                in (Settings &rsaquo; Users).
              </div>
            )}

            <form className="login-form" onSubmit={handleSubmit} autoComplete="on">
              <div className="login-field">
                <label htmlFor="lp-username">Username or email</label>
                <input
                  id="lp-username"
                  type="text"
                  autoComplete="username"
                  value={username}
                  onChange={e => setUsername(e.target.value)}
                  disabled={loading || ntlmLoading}
                  autoFocus={!ntlmAvailable}
                />
              </div>

              <div className="login-field">
                <div className="login-label-row">
                  <label htmlFor="lp-password">Password</label>
                  <button type="button" className="login-link" onClick={() => setShowForgot(v => !v)}>
                    Forgot your password?
                  </button>
                </div>
                <div className="login-pw-wrap">
                  <input
                    id="lp-password"
                    type={showLoginPassword ? 'text' : 'password'}
                    autoComplete="current-password"
                    value={loginPassword}
                    onChange={e => setLoginPassword(e.target.value)}
                    disabled={loading || ntlmLoading}
                  />
                  <button
                    type="button"
                    className="login-pw-toggle"
                    onClick={() => setShowLoginPassword(v => !v)}
                    tabIndex={-1}
                    aria-label={showLoginPassword ? 'Hide password' : 'Show password'}
                  >
                    {showLoginPassword ? 'Hide' : 'Show'}
                  </button>
                </div>
                {showForgot && (
                  <p className="login-hint-box">
                    Ask your CRUX APS administrator to reset it in Settings &rsaquo; User Access.
                  </p>
                )}
              </div>

              {error && <div className="login-error" role="alert">{error}</div>}

              <button type="submit" className="login-btn" disabled={loading || ntlmLoading}>
                {loading ? 'Signing in\u2026' : 'Sign in'}
              </button>
            </form>

            {ntlmAvailable && (
              <>
                <div className="login-divider"><span>Or</span></div>
                <button
                  type="button"
                  className="login-sso-btn"
                  onClick={handleNtlm}
                  disabled={ntlmLoading || loading}
                >
                  <KeyRound size={16} aria-hidden="true" />
                  {ntlmLoading ? 'Connecting\u2026' : 'Sign in with Windows'}
                </button>
              </>
            )}
          </>
        )}

          <footer className="login-footer">
            <span>&copy; 2026 CRUX APS. All rights reserved.</span>
            <span>Finite capacity scheduling for SYSPRO &middot; v2.0</span>
          </footer>
        </div>
      </main>
    </div>
  );
};

/** Background Gantt motif for the hero panel: [x, width, accent] per bar. */
const GANTT_ROWS: Array<Array<[number, number, boolean]>> = [
  [[20, 140, false], [180, 90, true], [300, 210, false], [560, 120, false]],
  [[60, 200, false], [290, 70, false], [390, 150, true], [600, 170, false]],
  [[0, 110, false], [130, 160, false], [330, 120, false], [480, 100, true], [610, 150, false]],
  [[90, 120, true], [240, 230, false], [500, 80, false], [610, 120, false]],
  [[30, 180, false], [240, 90, false], [360, 170, true], [560, 210, false]],
  [[10, 90, false], [130, 120, false], [280, 140, false], [450, 160, false], [640, 120, true]],
  [[70, 160, false], [260, 110, true], [400, 200, false], [630, 140, false]],
  [[40, 120, false], [190, 150, false], [370, 90, false], [490, 190, true]],
];

export default LoginPage;
