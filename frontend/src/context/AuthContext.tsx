import React, { createContext, useContext, useState, useEffect, useLayoutEffect, useCallback, useRef } from 'react';
import { setTokenProvider, setRefreshHandler, API_BASE_URL as API } from '../services/api';

/** Seconds until a JWT expires (0 if unreadable/expired). No signature check — only used to decide when to refresh. */
const secondsUntilExpiry = (token: string | null): number => {
  if (!token) return 0;
  try {
    const payload = JSON.parse(atob(token.split('.')[1].replace(/-/g, '+').replace(/_/g, '/')));
    return Math.max(0, Number(payload.exp) - Date.now() / 1000);
  } catch {
    return 0;
  }
};

/** Refresh when less than this is left on the access token. */
const REFRESH_MARGIN_S = 30 * 60;

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
  refreshSession: () => Promise<string | null>;
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

  // Mirrors state.accessToken for callbacks/listeners that must see the
  // CURRENT token without re-subscribing (the old 401 listener captured the
  // initial null token and therefore never signed anyone out).
  const tokenRef = useRef<string | null>(null);

  const setToken = (access: string, user: AuthUser) => {
    tokenRef.current = access;
    setState({ user, accessToken: access, loading: false });
  };

  const clearState = () => {
    tokenRef.current = null;
    setState({ user: null, accessToken: null, loading: false });
  };

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

  /** Get a fresh access token. Returns it, or null (and signs out) if the session can't be renewed. */
  const refreshSession = useCallback(async (): Promise<string | null> => {
    const authMode = localStorage.getItem(AUTH_MODE_KEY);
    // NTLM users: silently re-authenticate via Windows credentials
    if (authMode === 'ntlm') {
      try {
        const res = await fetch(`${API}/auth/ntlm`, {
          credentials: 'include',
          headers: { 'X-Requested-With': 'XMLHttpRequest' },
        });
        if (res.status === 503) { setNtlmAvailable(false); }
        if (!res.ok) { localStorage.removeItem(AUTH_MODE_KEY); clearState(); return null; }
        const data = await res.json();
        setToken(data.accessToken, data.user);
        return data.accessToken as string;
      } catch {
        localStorage.removeItem(AUTH_MODE_KEY);
        clearState();
        return null;
      }
    }
    // Local users: use refresh token
    const rt = localStorage.getItem(REFRESH_KEY);
    if (!rt) { clearState(); return null; }
    try {
      const res = await fetch(`${API}/auth/refresh`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ refreshToken: rt }),
      });
      if (!res.ok) { localStorage.removeItem(REFRESH_KEY); clearState(); return null; }
      const data = await res.json();
      localStorage.setItem(REFRESH_KEY, data.refreshToken);
      setToken(data.accessToken, data.user);
      return data.accessToken as string;
    } catch { clearState(); return null; }
  }, []);

  // Try to restore session on mount
  useEffect(() => { refreshSession(); }, []); // eslint-disable-line

  // Keep the token fresh. A fixed 7-hour timer missed laptops that slept past
  // the 8-hour expiry; instead check every 5 minutes and whenever the tab
  // becomes visible again, and refresh when under 30 minutes remain.
  useEffect(() => {
    if (!state.accessToken) return;
    const refreshIfNearExpiry = () => {
      if (tokenRef.current && secondsUntilExpiry(tokenRef.current) < REFRESH_MARGIN_S) {
        refreshSession();
      }
    };
    const timer = setInterval(refreshIfNearExpiry, 5 * 60 * 1000);
    const onVisible = () => { if (document.visibilityState === 'visible') refreshIfNearExpiry(); };
    document.addEventListener('visibilitychange', onVisible);
    window.addEventListener('focus', refreshIfNearExpiry);
    return () => {
      clearInterval(timer);
      document.removeEventListener('visibilitychange', onVisible);
      window.removeEventListener('focus', refreshIfNearExpiry);
    };
  }, [state.accessToken, refreshSession]);

  // Let the API client refresh + replay a request that got a 401.
  useLayoutEffect(() => {
    setRefreshHandler(refreshSession);
  }, [refreshSession]);

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
      if (!tokenRef.current) return; // no active session, nothing to clear
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
