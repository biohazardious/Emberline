/**
 * Test-only fake Gitea: REST under /api/v1 and git smart HTTP through `git http-backend` (CGI),
 * with `token <t>`, `Bearer <t>` or Basic `<user>:<t>` auth. Records every request's
 * Authorization header so tests can prove where credentials went.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync, mkdtempSync, rmSync } from 'node:fs';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';
import { tmpdir } from 'node:os';
import path from 'node:path';

export interface FakeForgeRequest {
  method: string;
  path: string;
  authorization: string | undefined;
}

export interface FakeForge {
  url: string;
  root: string;
  seen: FakeForgeRequest[];
  redirectTo: string | null;
  canCreate: boolean;
  orgs: string[];
  bare(owner: string, name: string): string;
  close(): Promise<void>;
}

function backend(
  req: IncomingMessage,
  res: ServerResponse,
  root: string,
  pathInfo: string,
  query: string,
  user: string,
): void {
  const child = spawn('git', ['http-backend'], {
    env: {
      PATH: process.env.PATH ?? '/usr/bin:/bin',
      GIT_CONFIG_NOSYSTEM: '1',
      GIT_CONFIG_GLOBAL: '/dev/null',
      GIT_PROJECT_ROOT: root,
      GIT_HTTP_EXPORT_ALL: '1',
      REQUEST_METHOD: req.method ?? 'GET',
      PATH_INFO: pathInfo,
      QUERY_STRING: query,
      CONTENT_TYPE: req.headers['content-type'] ?? '',
      ...(req.headers['content-length'] ? { CONTENT_LENGTH: String(req.headers['content-length']) } : {}),
      ...(req.headers['content-encoding']
        ? { HTTP_CONTENT_ENCODING: String(req.headers['content-encoding']) }
        : {}),
      // Set: receive-pack (push) is enabled.
      REMOTE_USER: user,
      REMOTE_ADDR: '127.0.0.1',
    },
  });
  req.pipe(child.stdin);
  child.stdin.on('error', () => undefined); // http-backend may exit before reading everything
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

export async function startFakeForge(
  options: { username?: string; token?: string } = {},
): Promise<FakeForge> {
  const username = options.username ?? 'alice';
  const token = options.token ?? 'forge-secret-token';
  const root = mkdtempSync(path.join(tmpdir(), 'fake-forge-'));
  const bare = (owner: string, name: string) => {
    const dir = path.join(root, owner, `${name}.git`);
    if (!existsSync(dir)) {
      mkdirSync(path.dirname(dir), { recursive: true });
      execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
    }
    return dir;
  };
  const userOf = (header: string | undefined): string | null => {
    if (!header) return null;
    if (header === `token ${token}` || header === `Bearer ${token}`) return username;
    const m = /^Basic (.+)$/.exec(header);
    if (!m) return null;
    const decoded = Buffer.from(m[1]!, 'base64').toString('utf8');
    const user = decoded.slice(0, decoded.indexOf(':'));
    const pass = decoded.slice(decoded.indexOf(':') + 1);
    return pass === token && [username, 'x-access-token', 'oauth2'].includes(user) ? username : null;
  };
  const json = (res: ServerResponse, status: number, body: unknown) => {
    res.writeHead(status, { 'content-type': 'application/json' });
    res.end(JSON.stringify(body));
  };
  const readBody = (req: IncomingMessage) =>
    new Promise<string>((resolve) => {
      let text = '';
      req.on('data', (chunk) => (text += chunk));
      req.on('end', () => resolve(text));
    });
  const forge: FakeForge = {
    url: '',
    root,
    seen: [],
    redirectTo: null,
    canCreate: true,
    orgs: ['acme'],
    bare,
    close: async () => undefined,
  };
  const server = createServer((req, res) => {
    void (async () => {
      const url = new URL(req.url ?? '/', 'http://fake');
      forge.seen.push({
        method: req.method ?? 'GET',
        path: url.pathname,
        authorization: req.headers.authorization,
      });
      const git = /^\/(.+\.git)\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
      if (git) {
        if (forge.redirectTo) {
          res.writeHead(302, { location: `${forge.redirectTo}${url.pathname}${url.search}` }).end();
          return;
        }
        const user = userOf(req.headers.authorization);
        if (!user) {
          res.writeHead(401, { 'www-authenticate': 'Basic realm="fake"' }).end();
          return;
        }
        if (!existsSync(path.join(root, git[1]!))) {
          res.writeHead(404).end();
          return;
        }
        backend(req, res, root, url.pathname, url.search.slice(1), user);
        return;
      }
      const user = userOf(req.headers.authorization);
      if (!user) return json(res, 401, { message: 'token is required' });
      if (req.method === 'GET' && url.pathname === '/api/v1/user')
        return json(res, 200, { login: username, username });
      if (req.method === 'GET' && url.pathname === '/api/v1/user/orgs')
        return json(
          res,
          200,
          forge.orgs.map((name) => ({ name, username: name })),
        );
      const create =
        req.method === 'POST' ? /^\/api\/v1\/(?:user|orgs\/([^/]+))\/repos$/.exec(url.pathname) : null;
      if (create) {
        let body: { name: string };
        try {
          body = JSON.parse(await readBody(req)) as { name: string };
        } catch {
          return json(res, 400, { message: 'invalid JSON' });
        }
        const owner = create[1] ?? username;
        if (!forge.canCreate)
          return json(res, 403, {
            message: 'token does not have at least one of required scope(s): [write:repository]',
          });
        if (existsSync(path.join(root, owner, `${body.name}.git`)))
          return json(res, 409, { message: 'The repository with the same name already exists.' });
        bare(owner, body.name);
        // A Gitea behind a proxy often reports its internal ROOT_URL: Emberline must not use it.
        return json(res, 201, {
          full_name: `${owner}/${body.name}`,
          clone_url: `http://localhost:1/${owner}/${body.name}.git`,
          html_url: `http://localhost:1/${owner}/${body.name}`,
        });
      }
      json(res, 404, { message: 'not found' });
    })();
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', () => resolve()));
  forge.url = `http://127.0.0.1:${(server.address() as { port: number }).port}`;
  forge.close = async () => {
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    rmSync(root, { recursive: true, force: true });
  };
  return forge;
}
