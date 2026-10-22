import { CSRF_HEADER } from '@emberline/protocol';

export class ApiRequestError extends Error {
  constructor(
    readonly status: number,
    readonly code: string,
    message: string,
    /** The rest of the error body (core spreads `details` into it), e.g. `blocking` or `canStartNew`. */
    readonly data: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = 'ApiRequestError';
  }
}

type Method = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

/** JSON fetch against core. Mutating requests carry the CSRF header core requires. */
export async function api<T>(path: string, method: Method = 'GET', body?: unknown): Promise<T> {
  const headers: Record<string, string> = {};
  if (method !== 'GET') headers[CSRF_HEADER] = '1';
  if (body !== undefined) headers['content-type'] = 'application/json';

  const res = await fetch(path, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
    credentials: 'same-origin',
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = text ? (JSON.parse(text) as unknown) : undefined;
  } catch {
    // Not JSON: a reverse proxy's error page. A failure still needs its status.
    if (res.ok) throw new Error('The server sent a reply Emberline could not read.');
    if (res.status === 401) window.dispatchEvent(new Event('emberline:unauthorized'));
    throw new ApiRequestError(res.status, 'http_error', res.statusText);
  }
  if (!res.ok) {
    const err = (json && typeof json === 'object' ? json : {}) as Record<string, unknown> & {
      error?: string;
      message?: string;
    };
    if (res.status === 401) window.dispatchEvent(new Event('emberline:unauthorized'));
    throw new ApiRequestError(res.status, err.error ?? 'http_error', err.message ?? res.statusText, err);
  }
  return json as T;
}

export const errorMessage = (error: unknown) => (error instanceof Error ? error.message : String(error));
