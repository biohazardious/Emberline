/**
 * Fake Gitea for make e2e (see apps/core/src/test-fake-forge.ts, the unit-test twin).
 * REST under /api/v1 (repositories and releases) and git smart HTTP through `git http-backend` (CGI).
 * Debug routes without auth (the e2e network only): GET /_e2e/head/<owner>/<name> reports the commit of
 * refs/heads/main (`main`), of every branch (`heads`, by name) and of every tag (`tags`, the commit an
 * annotated tag points to) in a repository; POST /_e2e/commit/<owner>/<name> adds a commit on main, as
 * a push from elsewhere (the JSON body may name its `branch`, which starts at `from`'s tip when it is
 * new, `subject`, a top-level `file` with its `content`, and a lightweight `tag` on the new commit);
 * GET /_e2e/releases lists the releases created through the API.
 * POST /_e2e/hold makes fetches (git-upload-pack) wait, GET /_e2e/held counts the waiting ones and
 * POST /_e2e/release lets them through: a clone that is running while the test looks around.
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

/** The releases created through POST /api/v1/repos/<owner>/<repo>/releases, in order. */
const releases = [];

/** Fetches waiting for /_e2e/release while /_e2e/hold is on. */
let holding = false;
const held = [];

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
      const heads = {};
      const tags = {};
      if (existsSync(dir)) {
        const refs = execFileSync(
          'git',
          [
            '--git-dir',
            dir,
            'for-each-ref',
            // %(*objectname): the commit an annotated tag points to (empty for a branch).
            '--format=%(objectname) %(*objectname) %(refname)',
            'refs/heads',
            'refs/tags',
          ],
          { encoding: 'utf8' },
        );
        for (const line of refs.split('\n').filter(Boolean)) {
          const [sha, peeled, ref] = line.split(' ');
          if (ref.startsWith('refs/heads/')) heads[ref.slice('refs/heads/'.length)] = sha;
          else tags[ref.slice('refs/tags/'.length)] = peeled || sha;
        }
      }
      return json(res, 200, { main: heads.main ?? null, heads, tags });
    }
    const outside = /^\/_e2e\/commit\/([^/]+)\/([^/]+)$/.exec(url.pathname);
    if (req.method === 'POST' && outside) {
      if (outside[1].includes('..') || outside[2].includes('..'))
        return json(res, 400, { message: 'bad name' });
      const dir = path.join(root, outside[1], `${outside[2]}.git`);
      let ask = {};
      try {
        ask = JSON.parse((await readBody(req)) || '{}');
      } catch {
        return json(res, 400, { message: 'invalid JSON' });
      }
      const branch = `refs/heads/${ask.branch ?? 'main'}`;
      const g = (args, env, input) =>
        execFileSync('git', ['--git-dir', dir, ...args], {
          encoding: 'utf8',
          env: { ...process.env, ...env },
          ...(input === undefined ? {} : { input }),
        }).trim();
      const plainName = /^[\w.-]+$/;
      if (ask.from !== undefined && !plainName.test(ask.from)) return json(res, 400, { message: 'bad from' });
      if (ask.tag !== undefined && !plainName.test(ask.tag)) return json(res, 400, { message: 'bad tag' });
      let exists = true;
      try {
        g(['rev-parse', '--verify', '--quiet', branch]);
      } catch {
        exists = false;
      }
      // A new branch starts at `from`'s tip; a `from` the repository lacks is the caller's mistake.
      let parent;
      try {
        parent = g([
          'rev-parse',
          '--verify',
          '--quiet',
          exists ? branch : `refs/heads/${ask.from ?? 'main'}`,
        ]);
      } catch {
        return json(res, 400, { message: `no branch ${ask.from ?? 'main'} to start ${ask.branch} from` });
      }
      const who = {
        GIT_AUTHOR_NAME: 'outside',
        GIT_AUTHOR_EMAIL: 'o@e',
        GIT_COMMITTER_NAME: 'outside',
        GIT_COMMITTER_EMAIL: 'o@e',
      };
      const subject = ask.subject ?? 'pushed from elsewhere';
      let tree = g(['rev-parse', `${parent}^{tree}`]);
      if (typeof ask.file === 'string' && /^[\w.-]+$/.test(ask.file)) {
        const blob = g(['hash-object', '-w', '--stdin'], {}, ask.content ?? '');
        const kept = g(['ls-tree', tree])
          .split('\n')
          .filter((line) => line && line.split('\t')[1] !== ask.file);
        tree = g(['mktree'], {}, `${[...kept, `100644 blob ${blob}\t${ask.file}`].join('\n')}\n`);
      }
      const commit = g(['commit-tree', tree, '-p', parent, '-m', subject], who);
      g(['update-ref', branch, commit, exists ? parent : '']);
      if (ask.tag !== undefined) g(['update-ref', `refs/tags/${ask.tag}`, commit, '']);
      return json(res, 200, { main: commit });
    }
    if (req.method === 'POST' && url.pathname === '/_e2e/hold') {
      holding = true;
      return json(res, 200, { holding });
    }
    if (req.method === 'GET' && url.pathname === '/_e2e/held') return json(res, 200, { held: held.length });
    if (req.method === 'GET' && url.pathname === '/_e2e/releases') return json(res, 200, { releases });
    if (req.method === 'POST' && url.pathname === '/_e2e/release') {
      holding = false;
      for (const go of held.splice(0)) go();
      return json(res, 200, { holding });
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
      const go = () => backend(req, res, url.pathname, url.search.slice(1), user);
      if (holding && req.method === 'POST' && url.pathname.endsWith('/git-upload-pack')) held.push(go);
      else go();
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
    // Gitea's releases API, as core's forge service calls it (apps/core/src/test-fake-forge.ts is the twin).
    const release =
      req.method === 'POST' ? /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/releases$/.exec(url.pathname) : null;
    if (release) {
      let body;
      try {
        body = JSON.parse(await readBody(req));
      } catch {
        return json(res, 400, { message: 'invalid JSON' });
      }
      const [, owner, repo] = release;
      if (releases.some((r) => r.owner === owner && r.repo === repo && r.tag_name === body.tag_name))
        return json(res, 409, { message: 'release tag already exists' });
      releases.push({ owner, repo, tag_name: body.tag_name, name: body.name, body: body.body });
      return json(res, 201, { html_url: `http://forge:3000/${owner}/${repo}/releases/tag/${body.tag_name}` });
    }
    const byTag =
      req.method === 'GET'
        ? /^\/api\/v1\/repos\/([^/]+)\/([^/]+)\/releases\/tags\/([^/]+)$/.exec(url.pathname)
        : null;
    if (byTag) {
      const [, owner, repo, tag] = byTag;
      const found = releases.find(
        (r) => r.owner === owner && r.repo === repo && r.tag_name === decodeURIComponent(tag),
      );
      if (!found) return json(res, 404, { message: 'not found' });
      return json(res, 200, {
        html_url: `http://forge:3000/${owner}/${repo}/releases/tag/${found.tag_name}`,
      });
    }
    json(res, 404, { message: 'not found' });
  })();
}).listen(port, '0.0.0.0', () => console.log(`fake forge on :${port}`));
