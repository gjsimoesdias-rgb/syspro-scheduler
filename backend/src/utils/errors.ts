/**
 * Helpers for `catch (err)` blocks, where err is `unknown` (strict mode):
 * anything can be thrown, not only Error objects.
 */

/** The error's message, or `fallback` when there is none. */
export function errorMessage(err: unknown, fallback = 'Unexpected error'): string {
  if (err instanceof Error && err.message) return err.message;
  if (typeof err === 'string' && err) return err;
  const msg = (err as { message?: unknown } | null)?.message;
  return typeof msg === 'string' && msg ? msg : fallback;
}

/** An HTTP status carried by the error (`status` or `statusCode`), if any. */
export function errorStatus(err: unknown): number | undefined {
  const e = err as { status?: unknown; statusCode?: unknown } | null;
  const n = Number(e?.status ?? e?.statusCode);
  return Number.isInteger(n) && n >= 100 && n < 600 ? n : undefined;
}

/** A string `code` property (e.g. 'ESOCKET', 'MASTER_CHANGED'), if any. */
export function errorCode(err: unknown): string | undefined {
  const code = (err as { code?: unknown } | null)?.code;
  return typeof code === 'string' ? code : undefined;
}
