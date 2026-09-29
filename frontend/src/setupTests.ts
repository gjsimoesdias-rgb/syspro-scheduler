/**
 * Vitest setup — runs before every test file.
 * `globals: true` in vite.config.ts exposes describe/it/expect/vi globally,
 * so jest-dom's expect.extend() finds the global expect at import time.
 */
import '@testing-library/jest-dom';
