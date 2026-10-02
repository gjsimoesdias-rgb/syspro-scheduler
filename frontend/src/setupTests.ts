/**
 * Vitest setup — runs before every test file.
 * `globals: true` in vite.config.ts exposes describe/it/expect/vi globally,
 * so jest-dom's expect.extend() finds the global expect at import time.
 */
import '@testing-library/jest-dom';

// Node 25+ ships a global `localStorage` that shadows jsdom's and, without
// --localstorage-file, has no methods. Give tests a working in-memory Storage.
if (typeof globalThis.localStorage?.clear !== 'function') {
  const data = new Map<string, string>();
  const storage: Storage = {
    get length() { return data.size; },
    clear: () => data.clear(),
    getItem: (k) => data.get(k) ?? null,
    key: (i) => Array.from(data.keys())[i] ?? null,
    removeItem: (k) => { data.delete(k); },
    setItem: (k, v) => { data.set(k, String(v)); },
  };
  Object.defineProperty(globalThis, 'localStorage', { value: storage, configurable: true, writable: true });
  if (typeof window !== 'undefined') Object.defineProperty(window, 'localStorage', { value: storage, configurable: true, writable: true });
}
