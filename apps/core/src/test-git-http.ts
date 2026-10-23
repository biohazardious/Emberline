/**
 * Test-only git smart-HTTP server (`git http-backend` over CGI), with push enabled and no auth.
 * It serves a real transport so the no-account read/push paths, which refuse a local-path origin,
 * can be exercised with real git. Nothing here is used outside tests.
 */
import { spawn } from 'node:child_process';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import type { AddressInfo } from 'node:net';

function backend(req: IncomingMessage, res: ServerResponse, root: string): void {
  const url = new URL(req.url ?? '/', 'http://x');
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method ?? 'GET',
      PATH_INFO: url.pathname,
      QUERY_STRING: url.search.replace(/^\?/, ''),
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      ...(req.headers['content-length'] ? { CONTENT_LENGTH: String(req.headers['content-length']) } : {}),
      REMOTE_USER: 'tester',
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  req.pipe(child.stdin);
  child.stdin.on('error', () => undefined);
  const out: Buffer[] = [];
  child.stdout.on('data', (chunk: Buffer) => out.push(chunk));
  child.on('close', () => {
    const all = Buffer.concat(out);
    const split = all.indexOf('\r\n\r\n');
    const head = split < 0 ? '' : all.subarray(0, split).toString('latin1');
    const body = split < 0 ? all : all.subarray(split + 4);
    let status = 200;
    const headers: Record<string, string> = {};
    for (const line of head.split('\r\n')) {
      const i = line.indexOf(':');
      if (i < 0) continue;
      const key = line.slice(0, i).trim();
      const value = line.slice(i + 1).trim();
      if (key.toLowerCase() === 'status') status = Number.parseInt(value, 10);
      else headers[key] = value;
    }
    res.writeHead(status, headers);
    res.end(body);
  });
}

/** Serves `<root>` (a directory of bare repos) over smart HTTP; `url(name)` is `http://…/<name>`. */
export async function startGitHttp(root: string): Promise<{
  url: (repo: string) => string;
  close: () => Promise<void>;
}> {
  const server = createServer((req, res) => backend(req, res, root));
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: (repo) => `http://127.0.0.1:${port}/${repo}`,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
