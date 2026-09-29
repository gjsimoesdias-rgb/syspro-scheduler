/// <reference types="vite/client" />

declare module '*.css';

// process.env is replaced by Vite's `define` at build time (#57).
// Declare a minimal shim so TypeScript doesn't complain.
declare const process: { env: Record<string, string | undefined> };
