/**
 * How core's git reaches a project's remote (spec Part 2): an http(s) address under a forge account
 * goes through the git gateway with that account; an ssh address through the gateway with the
 * project's chosen SSH key, or not at all (`ssh_key_missing`: the operation fails before anything
 * runs; core's own git has no ssh credentials since the uid split); an http(s) address without an
 * account goes straight to it (public repositories).
 */
import { isNotNull } from 'drizzle-orm';
import type { Db } from '../db/index.js';
import { projects, sshKeys } from '../db/schema.js';
import { badRequest, HttpError } from '../errors.js';
import { gitCredentialForRemote } from '../forge/account-store.js';
import { type GatewayCredential, type GitGateway, MISSING_KEY } from '../git-gateway/gateway.js';
import type { GatewayRemote } from '../git-gateway/remote-git.js';
import { parseSshRemote } from '../git-gateway/ssh-upstream.js';
import { isSupportedRemoteUrl } from '../repository/git.js';
import { keyForProject } from './store.js';

/** The project fields the key choice reads. */
export interface KeyedProject {
  id: string;
  sshKeyChoice: 'shared' | 'own';
}

const UNREACHABLE_SSH =
  'Emberline reaches an ssh address with its SSH key only by host name, such as git@host:owner/repo.git or ssh://git@host:2222/owner/repo.git (an IPv6 address is not supported).';

/** Whether git would reach `url` over ssh (`ssh://…` or scp-like `host:path`). */
export function isSshAddress(url: string): boolean {
  return isSupportedRemoteUrl(url) && !/^https?:\/\//i.test(url.trim());
}

/** The refusal for an ssh address whose chosen key does not exist. */
export const sshKeyMissing = () => new HttpError(409, 'ssh_key_missing', MISSING_KEY);

/**
 * What the gateway reaches `url` with for `project`: the account (http), the chosen SSH key bound
 * by its id (ssh; never the other key, Ruling 19), `'ssh_key_missing'` when that key does not
 * exist, or null for an http(s) address without an account (git goes straight to it). An ssh
 * address the gateway cannot reach by host name is refused (400). May throw the account's own
 * `forge_account_unchecked`.
 */
export function gatewayCredentialFor(
  db: Db,
  project: KeyedProject,
  url: string,
): GatewayCredential | null | 'ssh_key_missing' {
  const http = gitCredentialForRemote(db, url);
  if (http) return { kind: 'http', http };
  if (!isSshAddress(url)) return null;
  if (!parseSshRemote(url)) throw badRequest(UNREACHABLE_SSH);
  const key = keyForProject(db, project);
  if (!key) return 'ssh_key_missing';
  return { kind: 'ssh', keyId: key.keyId, keyScope: key.scope === 'shared' ? 'shared' : key.scope.projectId };
}

/** {@link gatewayCredentialFor} as the remote the git commands take; a missing key throws 409 `ssh_key_missing`. */
export function gatewayRemoteFor(
  db: Db,
  gateway: GitGateway,
  project: KeyedProject,
  url: string,
): GatewayRemote | null {
  const credential = gatewayCredentialFor(db, project, url);
  if (credential === 'ssh_key_missing') throw sshKeyMissing();
  return credential ? { gateway, projectId: project.id, url, credential } : null;
}

/**
 * The projects whose repository (projects.repoUrl) is an ssh address and whose chosen key does not
 * exist: every page names them until a key is created (spec, upgrade from ~/.ssh in the runner).
 */
export function sshKeyMissingProjects(db: Db): { projectId: string; name: string }[] {
  const scopes = new Set(
    db
      .select({ scope: sshKeys.scope })
      .from(sshKeys)
      .all()
      .map((row) => row.scope),
  );
  return db
    .select({
      id: projects.id,
      name: projects.name,
      repoUrl: projects.repoUrl,
      choice: projects.sshKeyChoice,
    })
    .from(projects)
    .where(isNotNull(projects.repoUrl))
    .all()
    .filter((row) => isSshAddress(row.repoUrl!) && !scopes.has(row.choice === 'own' ? row.id : 'shared'))
    .map((row) => ({ projectId: row.id, name: row.name }));
}
