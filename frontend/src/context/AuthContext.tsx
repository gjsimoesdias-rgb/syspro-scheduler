import React, { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback } from 'react';
import { setTokenProvider } from '../services/api';

const API = process.env.REACT_APP_API_URL || 'http://localhost:3000/api';

export type UserRole = 'super_admin' | 'company_admin' | 'planner' | 'viewer' | 'Reviewer' | 'Approver';

export interface AuthUser {
  id: number;
  username: string;
  email: string;
  role: UserRole;
  fullName: string | null;
  companyId: number | null;
  companyName: string | null;
}

interface AuthState {
  user: AuthUser | null;
  accessToken: string | null;
  loading: boolean;
}

interface AuthContextValue extends AuthState {
  login: (username: string, password: string) => Promise<void>;
  loginWithNtlm: () => Promise<void>;
  logout: () => Promise<void>;
  refreshSession: () => Promise<void>;
  isRole: (...roles: UserRole[]) => boolean;
  authHeader: () => Record<string, string>;
  ntlmAvailable: boolean;
}

const AuthContext = createContext<AuthContextValue | null>(null);

const REFRESH_KEY = 'scheduler_refresh_token';
const AUTH_MODE_KEY = 'scheduler_auth_mode'; // 'ntlm' | 'local'

export const AuthProvider: React.FC<{ children: React.ReactNode }> = ({ children }) => {
  const [state, setState] = useState<AuthState>({ user: null, accessToken: null, loading: true });
  // Whether the server has NTLM configured (learned on first attempted NTLM call)
  const [ntlmAvailable, setNtlmAvailable] = useState(true);

  const setToken = (access: string, user: AuthUser) =>
    setState({ user, accessToken: access, loading: false });

  const clearState = () =>
    setState({ user: null, accessToken: null, loading: false });

  const login = useCallback(async (username: string, password: string) => {
    const res = await fetch(`${API}/auth/login`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ username, password }),
    });
    if (!res.ok) {
      const err = await res.json().catch(() => ({}));
      throw new Error(err.error || 'Login failed');
    }
    const data = await res.json();
    localStorage.setItem(REFRESH_KEY, data.refreshToken);
    localStorage.setItem(AUTH_MODE_KEY, 'local');
    setToken(data.accessToken, data.user);
  }, []);

  const loginWithNtlm = useCallback(async () => {
    const res = await fetch(`${API}/auth/ntlm`, {
      credentials: 'include',
      headers: { 'X-Requested-With': 'XMLHttpRequest' },
    });
    if (res.status === 503) {
      setNtlmAvailable(false);
      throw new Error('Windows authentication is not configured on this server.');
    }
    if (!res.ok) throw new Error('Windows authentication failed');
    const data = await res.json();
    localStorage.setItem(AUTH_MODE_KEY, 'ntlm');
    setToken(data.accessToken, data.user);
  }, []);

  const logout = useCallback(async () => {
    const rt = localStorage.getItem(REFRESH_KEY);
    if (rt) {
      await fetch(`${API}/auth/logout`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      }).catch(() => {});
    }
    localStorage.removeItem(REFRESH_KEY);
    localStorage.removeItem(AUTH_MODE_KEY);
    clearState();
  }, []);

  const refreshSession = useCallback(async () => {    const authMode = localStorage.getItem(AUTH_MODE_KEY);
    // NTLM users: silently re-authenticate via Windows credentials
    if (authMode === 'ntlm') {
      try {
        const res = await fetch(`${API}/auth/ntlm`, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (res.status === 503) { setNtlmAvailable(false); }
        if (!res.ok) { localStorage.removeItem(AUTH_MODE_KEY); clearState(); return; }
        const data = await res.json();
        setToken(data.accessToken, data.user);
        return;
      } catch {
        localStorage.removeItem(AUTH_MODE_KEY);
        clearState();
        return;
      }
    }
    // Local users: use refresh token
    const rt = localStorage.getItem(REFRESH_KEY);
    if (!rt) { clearState(); return; }
    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) { localStorage.removeItem(REFRESH_KEY); clearState(); return; }
      const data = await res.json();
      localStorage.setItem(REFRESH_KEY, data.refreshToken);
      setToken(data.accessToken, data.user);
    } catch { clearState(); }
  }, []);

  // Try to restore session on mount
  useEffect(() => { refreshSession(); }, []); // eslint-disable-line

  // Auto-refresh every 7 hours
  useEffect(() => {
    if (!state.accessToken) return;
    const timer = setInterval(refreshSession, 7 * 60 * 60 * 1000);
    return () => clearInterval(timer);
  }, [state.accessToken, refreshSession]);

  // Wire access token into the axios client in api.ts.
  // useLayoutEffect runs before any passive useEffect in child components,
  // so the token is always available when child effects fire data requests.
  useLayoutEffect(() => {
    setTokenProvider(() => state.accessToken);
  }, [state.accessToken]);

  // Handle 401 responses broadcast by the axios interceptor.
  // Only log out when there is an active session — prevents stale in-flight
  // requests from the previous render from clearing a freshly-restored token.
  useEffect(() => {
    const handler = () => {
      if (!state.accessToken) return; // no active session, nothing to clear
      localStorage.removeItem(REFRESH_KEY);
      localStorage.removeItem(AUTH_MODE_KEY);
      clearState();
    };
    window.addEventListener('aps:unauthorized', handler);
    return () => window.removeEventListener('aps:unauthorized', handler);
  }, []); // eslint-disable-line

  const isRole = useCallback((...roles: UserRole[]) =>
    !!state.user && roles.includes(state.user.role), [state.user]);

  const authHeader = useCallback((): Record<string, string> =>
    state.accessToken ? { Authorization: `Bearer ${state.accessToken}` } : {}, [state.accessToken]);

  return (
    <AuthContext.Provider value={{ ...state, login, loginWithNtlm, logout, refreshSession, isRole, authHeader, ntlmAvailable }}>
      {children}
    </AuthContext.Provider>
  );
};

export function useAuth(): AuthContextValue {
  const ctx = useContext(AuthContext);
  if (!ctx) throw new Error('useAuth must be used inside AuthProvider');
  return ctx;
}
