import { CSRF_HEADER, type TicketExportFormat, TicketStatus } from '@emberline/protocol';
import { ApiRequestError } from './api';
import { getSessionKey } from './sessionKey';

export interface BoardExportRequest {
  projectId: string;
  format: TicketExportFormat;
  /** Columns to export; every column (or none picked) exports the whole board. */
  statuses: readonly TicketStatus[];
}

export function boardExportUrl({ projectId, format, statuses }: BoardExportRequest): string {
  const params = new URLSearchParams({ format });
  const picked = TicketStatus.options.filter((s) => statuses.includes(s));
  if (picked.length > 0 && picked.length < TicketStatus.options.length)
    params.set('status', picked.join(','));
  return `/api/projects/${encodeURIComponent(projectId)}/tickets/export?${params.toString()}`;
}

/** The file name core chose (`filename*` first, then the ASCII `filename`), else `fallback`. */
export function fileNameFromDisposition(header: string | null, fallback: string): string {
  if (!header) return fallback;
  const encoded = /filename\*=UTF-8''([^;]+)/i.exec(header)?.[1];
  if (encoded) {
    try {
      return decodeURIComponent(encoded.trim());
    } catch (error) {
      if (!(error instanceof URIError)) throw error;
    }
  }
  return /filename="([^"]+)"/i.exec(header)?.[1] ?? fallback;
}

async function errorOf(res: Response): Promise<ApiRequestError> {
  if (res.status === 401) window.dispatchEvent(new Event('emberline:unauthorized'));
  const text = await res.text();
  let body: Record<string, unknown> = {};
  try {
    const parsed: unknown = text ? JSON.parse(text) : undefined;
    if (parsed && typeof parsed === 'object') body = parsed as Record<string, unknown>;
  } catch (error) {
    if (!(error instanceof SyntaxError)) throw error;
  }
  const code = typeof body.error === 'string' ? body.error : 'http_error';
  const message = typeof body.message === 'string' ? body.message : res.statusText || `HTTP ${res.status}`;
  return new ApiRequestError(res.status, code, message, body);
}

/** Fetches the export and hands it to the browser as a download; resolves to the saved file name. */
export async function downloadBoardExport(request: BoardExportRequest): Promise<string> {
  const headers: Record<string, string> = {};
  const key = getSessionKey();
  if (key) headers[CSRF_HEADER] = key;
  const res = await fetch(boardExportUrl(request), { headers, credentials: 'same-origin' });
  if (!res.ok) throw await errorOf(res);
  const fileName = fileNameFromDisposition(
    res.headers.get('content-disposition'),
    `tickets.${request.format}`,
  );
  const url = URL.createObjectURL(await res.blob());
  try {
    const link = document.createElement('a');
    link.href = url;
    link.download = fileName;
    link.rel = 'noopener';
    document.body.append(link);
    link.click();
    link.remove();
  } finally {
    setTimeout(() => URL.revokeObjectURL(url), 0);
  }
  return fileName;
}
