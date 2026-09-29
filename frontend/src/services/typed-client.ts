/**
 * Typed API client generated from backend/openapi.yaml.
 *
 * Usage:
 *   import { typedClient } from './typed-client';
 *   const { data, error } = await typedClient.GET('/health');
 *
 * Re-generate types whenever the spec changes:
 *   npm run generate-types          (from the frontend directory)
 */

import createClient, { type Middleware } from 'openapi-fetch';
import type { paths } from '../api-types';

// ── Base URL ──────────────────────────────────────────────────────────────────
// Vite builds: vite.config.ts defines process.env.REACT_APP_API_URL = VITE_API_URL at build time.
// Jest / CRA builds: falls back to window.location.origin or the dev default.
const API_BASE_URL: string =
  process.env.REACT_APP_API_URL ||
  (typeof window !== 'undefined' ? `${window.location.origin}/api` : 'http://localhost:3000/api');

// ── Token injection ───────────────────────────────────────────────────────────
// setTypedClientTokenProvider() is called from api.ts's setTokenProvider() so
// AuthContext doesn't need a second call site.
let _tokenProvider: () => string | null = () => null;

export function setTypedClientTokenProvider(fn: () => string | null): void {
  _tokenProvider = fn;
}

const authMiddleware: Middleware = {
  async onRequest({ request }) {
    const token = _tokenProvider();
    if (token) {
      request.headers.set('Authorization', `Bearer ${token}`);
    }
    return request;
  },
  async onResponse({ response }) {
    if (response.status === 401) {
      // Mirror the Axios interceptor: broadcast so AuthContext can clear state.
      if (typeof window !== 'undefined') {
        window.dispatchEvent(new CustomEvent('aps:unauthorized'));
      }
    }
    return response;
  },
};

// ── Client ────────────────────────────────────────────────────────────────────
export const typedClient = createClient<paths>({ baseUrl: API_BASE_URL });
typedClient.use(authMiddleware);
