import { eq } from 'drizzle-orm';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/index.js';
import { projects } from '../db/schema.js';
import { HttpError } from '../errors.js';
import { GitGateway } from '../git-gateway/gateway.js';
import { seedForgeAccount } from '../test-utils.js';
import { gatewayCredentialFor, gatewayRemoteFor, sshKeyMissingProjects } from './remote.js';
import { deleteKey, generateKey, keyForProject } from './store.js';

let opened: ReturnType<typeof openDb>;
let db: Db;
const project = (id = 'p1') => db.select().from(projects).where(eq(projects.id, id)).get()!;
const addProject = (id: string, repoUrl: string | null, choice: 'shared' | 'own' = 'shared') =>
  db
    .insert(projects)
    .values({
      id,
      name: `Name ${id}`,
      slug: id,
      path: `/workspaces/${id}`,
      repoUrl,
      sshKeyChoice: choice,
      createdAt: new Date(),
    })
    .run();

beforeEach(() => {
  opened = openDb(':memory:');
  db = opened.db;
  addProject('p1', 'git@github.com:alice/app.git');
});
afterEach(() => opened.close());

describe('gatewayCredentialFor', () => {
  it('https under an account: the account (http); https without one: direct (null)', () => {
    seedForgeAccount(db, {
      provider: 'gitea',
      serverUrl: 'https://git.example',
      token: 't0k',
      username: 'a',
    });
    expect(gatewayCredentialFor(db, project(), 'https://git.example/alice/app.git')).toEqual({
      kind: 'http',
      http: { serverUrl: 'https://git.example', username: 'a', token: 't0k' },
    });
    expect(gatewayCredentialFor(db, project(), 'https://other.example/alice/app.git')).toBeNull();
    expect(gatewayCredentialFor(db, project(), 'http://other.example/alice/app.git')).toBeNull();
  });

  it("an ssh address: the chosen key, bound by its id; none: 'ssh_key_missing'", () => {
    for (const url of ['git@github.com:alice/app.git', 'ssh://git@github.com/alice/app.git'])
      expect(gatewayCredentialFor(db, project(), url)).toBe('ssh_key_missing');
    generateKey(db, 'shared');
    const shared = keyForProject(db, project())!.keyId;
    expect(gatewayCredentialFor(db, project(), 'git@github.com:alice/app.git')).toEqual({
      kind: 'ssh',
      keyId: shared,
      keyScope: 'shared',
    });
    db.update(projects).set({ sshKeyChoice: 'own' }).where(eq(projects.id, 'p1')).run();
    // Ruling 19: the chosen own key missing never falls back to the shared key.
    expect(gatewayCredentialFor(db, project(), 'git@github.com:alice/app.git')).toBe('ssh_key_missing');
    generateKey(db, { projectId: 'p1', slug: 'p1' });
    expect(gatewayCredentialFor(db, project(), 'ssh://git@github.com/alice/app.git')).toEqual({
      kind: 'ssh',
      keyId: keyForProject(db, project())!.keyId,
      keyScope: 'p1',
    });
    deleteKey(db, { projectId: 'p1' });
    expect(gatewayCredentialFor(db, project(), 'git@github.com:alice/app.git')).toBe('ssh_key_missing');
  });

  it('an ssh address Emberline cannot reach with its key (an IPv6 literal) is refused, not tried', () => {
    generateKey(db, 'shared');
    expect(() => gatewayCredentialFor(db, project(), 'ssh://git@[::1]/app.git')).toThrow(HttpError);
  });
});

describe('gatewayRemoteFor', () => {
  it("throws ssh_key_missing with the spec's copy; null for a direct remote", () => {
    const gateway = new GitGateway({ baseUrl: 'http://core:7420', runnerHosts: ['ops'], db });
    const error = (() => {
      try {
        gatewayRemoteFor(db, gateway, project(), 'git@github.com:alice/app.git');
      } catch (e) {
        return e;
      }
      return null;
    })();
    expect(error).toBeInstanceOf(HttpError);
    expect(error).toMatchObject({
      statusCode: 409,
      code: 'ssh_key_missing',
      message: "Create a key in Settings → SSH key, or in this project's settings.",
    });
    expect(gatewayRemoteFor(db, gateway, project(), 'https://example.com/a.git')).toBeNull();
    generateKey(db, 'shared');
    expect(gatewayRemoteFor(db, gateway, project(), 'git@github.com:alice/app.git')).toMatchObject({
      gateway,
      projectId: 'p1',
      url: 'git@github.com:alice/app.git',
      credential: { kind: 'ssh', keyScope: 'shared' },
    });
    gateway.dispose();
  });
});

describe('sshKeyMissingProjects (the banner)', () => {
  it('names the projects with an ssh repository whose chosen key is missing', () => {
    addProject('p2', 'https://github.com/alice/web.git');
    addProject('p3', null);
    addProject('p4', 'ssh://git@git.example:2222/srv/app.git', 'own');
    expect(sshKeyMissingProjects(db)).toEqual([
      { projectId: 'p1', name: 'Name p1' },
      { projectId: 'p4', name: 'Name p4' },
    ]);
    generateKey(db, 'shared');
    expect(sshKeyMissingProjects(db)).toEqual([{ projectId: 'p4', name: 'Name p4' }]);
    generateKey(db, { projectId: 'p4', slug: 'p4' });
    expect(sshKeyMissingProjects(db)).toEqual([]);
  });
});

describe('GitGateway.issue with an SSH key', () => {
  it("binds only the shared key or the grant's own project's key", () => {
    addProject('p2', null);
    generateKey(db, { projectId: 'p2', slug: 'p2' });
    const other = keyForProject(db, { id: 'p2', sshKeyChoice: 'own' })!.keyId;
    const gateway = new GitGateway({ baseUrl: 'http://core:7420', runnerHosts: ['ops'], db });
    const grant = (keyScope: string) => ({
      projectId: 'p1',
      upstreamUrl: 'git@github.com:alice/app.git',
      credential: { kind: 'ssh' as const, keyId: other, keyScope },
      service: 'git-upload-pack' as const,
    });
    expect(() => gateway.issue(grant('p2'))).toThrow(/shared key or its own project's key/);
    expect(gateway.size).toBe(0);
    expect(gateway.issue(grant('p1')).capability).toEqual(expect.any(String));
    gateway.dispose();
  });
});
