/**
 * Fake Gitea for make e2e (see apps/core/src/test-fake-forge.ts, the unit-test twin).
 * REST under /api/v1 and git smart HTTP through `git http-backend` (CGI). Two debug routes without
 * auth (the e2e network only): GET /_e2e/head/<owner>/<name> reports the commit of refs/heads/main
 * in a repository; POST /_e2e/commit/<owner>/<name> adds a commit on it, as a push from elsewhere.
 */
import { execFileSync, spawn } from 'node:child_process';
import { existsSync, mkdirSync } from 'node:fs';
import { createServer } from 'node:http';
import path from 'node:path';

const username = process.env.FAKE_FORGE_USER ?? 'alice';
const token = process.env.FAKE_FORGE_TOKEN ?? 'forge-secret-token';
const port = Number.parseInt(process.env.FAKE_FORGE_PORT ?? '3000', 10);
const root = '/tmp/fake-forge';
const orgs = ['acme'];
mkdirSync(root, { recursive: true });

function bare(owner, name) {
  const dir = path.join(root, owner, `${name}.git`);
  if (!existsSync(dir)) {
    mkdirSync(path.dirname(dir), { recursive: true });
    execFileSync('git', ['init', '-q', '--bare', '-b', 'main', dir]);
  }
  return dir;
}

function backend(req, res, pathInfo, query, user) {
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
  const out = [];
  child.stdout.on('data', (chunk) => out.push(chunk));
  child.on('close', () => {
    const all = Buffer.concat(out);
    const split = all.indexOf('\r\n\r\n');
    const head = split < 0 ? '' : all.subarray(0, split).toString('latin1');
    const body = split < 0 ? all : all.subarray(split + 4);
    let status = 200;
    const headers = {};
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

function userOf(header) {
  if (!header) return null;
  if (header === `token ${token}` || header === `Bearer ${token}`) return username;
  const m = /^Basic (.+)$/.exec(header);
  if (!m) return null;
  const decoded = Buffer.from(m[1], 'base64').toString('utf8');
  const user = decoded.slice(0, decoded.indexOf(':'));
  const pass = decoded.slice(decoded.indexOf(':') + 1);
  return pass === token && [username, 'x-access-token', 'oauth2'].includes(user) ? username : null;
}

const json = (res, status, body) => {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
};
const readBody = (req) =>
  new Promise((resolve) => {
    let text = '';
    req.on('data', (chunk) => (text += chunk));
    req.on('end', () => resolve(text));
  });

createServer((req, res) => {
  void (async () => {
    const url = new URL(req.url ?? '/', 'http://fake');
    const head = /^\/_e2e\/head\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'GET' && head) {
      if (head[1].includes('..') || head[2].includes('..')) return json(res, 400, { message: 'bad name' });
      const dir = path.join(root, head[1], `${head[2]}.git`);
      let main = null;
      if (existsSync(dir)) {
        try {
          main =
            execFileSync('git', ['--git-dir', dir, 'rev-parse', '--verify', '--quiet', 'refs/heads/main'], {
              encoding: 'utf8',
            }).trim() || null;
        } catch {
          main = null;
        }
      }
      return json(res, 200, { main });
    }
    const outside = /^\/_e2e\/commit\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && outside) {
      if (outside[1].includes('..') || outside[2].includes('..'))
        return json(res, 400, { message: 'bad name' });
      const dir = path.join(root, outside[1], `${outside[2]}.git`);
      const g = (args, env) =>
        execFileSync('git', ['--git-dir', dir, ...args], {
          encoding: 'utf8',
          env: { ...process.env, ...env },
        }).trim();
      const parent = g(['rev-parse', 'refs/heads/main']);
      const who = {
        GIT_AUTHOR_NAME: 'outside',
        GIT_AUTHOR_EMAIL: 'o@e',
        GIT_COMMITTER_NAME: 'outside',
        GIT_COMMITTER_EMAIL: 'o@e',
      };
      const commit = g(
        ['commit-tree', g(['rev-parse', `${parent}^{tree}`]), '-p', parent, '-m', 'pushed from elsewhere'],
        who,
      );
      g(['update-ref', 'refs/heads/main', commit, parent]);
      return json(res, 200, { main: commit });
    }
    const git = /^\/(.+\.git)\/(?:info\/refs|git-upload-pack|git-receive-pack)$/.exec(url.pathname);
    if (git) {
      const user = userOf(req.headers.authorization);
      if (!user) {
        res.writeHead(401, { 'www-authenticate': 'Basic realm="fake"' }).end();
        return;
      }
      if (!existsSync(path.join(root, git[1]))) {
        res.writeHead(404).end();
        return;
      }
      backend(req, res, url.pathname, url.search.slice(1), user);
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
        orgs.map((name) => ({ name, username: name })),
      );
    const create =
      req.method === 'POST' ? /^\/api\/v1\/(?:user|orgs\/([^/]+))\/repos$/.exec(url.pathname) : null;
    if (create) {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { message: 'invalid JSON' });
      }
      const owner = create[1] ?? username;
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
}).listen(port, '0.0.0.0', () => console.log(`fake forge on :${port}`));
