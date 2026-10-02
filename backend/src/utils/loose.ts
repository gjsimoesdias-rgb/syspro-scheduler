/**
 * Input from the client or a JSON blob: an object whose fields are not
 * trusted yet. Read fields as `unknown` and convert them explicitly
 * (String(x), Number(x), Array.isArray(x)) instead of typing input as any.
 */
export type Loose = Record<string, unknown>;

/** `v` as a Loose object ({} when it isn't an object). */
export const asObj = (v: unknown): Loose =>
  (v !== null && typeof v === 'object' && !Array.isArray(v) ? (v as Loose) : {});

/** `v` as an array of unknowns ([] when it isn't an array). */
export const asArr = (v: unknown): unknown[] => (Array.isArray(v) ? v : []);
