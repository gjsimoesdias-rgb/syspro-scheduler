/**
 * Readable message from anything thrown — an axios error with a server body
 * ({ error: '…' } or { error: { message } } or zod { details: [{ message }] }),
 * an Error, or a string. For `catch (err)` blocks, where err is `unknown`.
 */
export function errorMessage(err: unknown, fallback = 'Something went wrong'): string {
  const e = err as {
    message?: unknown;
    response?: { data?: { error?: unknown; details?: Array<{ message?: unknown }> } };
  } | null;
  const body = e?.response?.data?.error;
  if (typeof body === 'string' && body) return body;
  const nested = (body as { message?: unknown } | null | undefined)?.message;
  if (typeof nested === 'string' && nested) return nested;
  const detail = e?.response?.data?.details?.[0]?.message;
  if (typeof detail === 'string' && detail) return detail;
  if (typeof e?.message === 'string' && e.message) return e.message;
  if (typeof err === 'string' && err) return err;
  return fallback;
}

/** HTTP status of an axios error, if any. */
export const errorStatus = (err: unknown): number | undefined =>
  (err as { response?: { status?: number } } | null)?.response?.status;
