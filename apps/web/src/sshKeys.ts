/** Pure helpers for Emberline's SSH keys in the web UI: addresses, the hints and the failure kinds. */
import type {
  HostKeyDetails,
  ImportStatusResponse,
  Project,
  ProjectSshKeyResponse,
  SshKeyPublic,
  SshRemoteProblem,
} from '@emberline/protocol';

/** Settings → SSH key (the tab, scrolled to the shared key). */
export const SSH_KEY_HREF = '/settings?tab=ssh_key#ssh-key';
/** Settings → SSH key → Trusted host keys. */
export const TRUSTED_HOSTS_HREF = '/settings?tab=ssh_key#trusted-host-keys';

/** Core's `ssh_key_missing` message, word for word (spec). */
export const MISSING_KEY_TEXT = "Create a key in Settings → SSH key, or in this project's settings.";
export const SHARED_KEY_LABEL = "Emberline's shared key";
export const OWN_KEY_LABEL = "This project's own key";
export const OWN_KEY_BUTTON = 'Use a key for this project only';

/** Where the shared key goes: the person's forge account or their own server. */
export const SHARED_KEY_HINT =
  'Add it to GitHub → Settings → SSH and GPG keys, GitLab → Preferences → SSH Keys, or your server. Every project that uses the shared key reaches its ssh repository with it.';

/**
 * Whether git reaches `raw` over ssh (`ssh://…` or scp-like `host:path`), as core decides it
 * (`isSshAddress` in core's ssh-keys/remote.ts): an https address, another scheme or a local path is not.
 */
export function isSshAddress(raw: string): boolean {
  const url = raw.trim();
  if (/^ssh:\/\//i.test(url)) return true;
  if (/^[a-z][a-z0-9+.-]*:\/\//i.test(url) || /^[a-z0-9+.-]+::/i.test(url)) return false;
  const slash = url.indexOf('/');
  const colon = url.indexOf(':');
  return colon > 0 && (slash < 0 || colon < slash);
}

/** `owner/repo` of an ssh address (`git@host:owner/repo.git`, `ssh://git@host:2222/owner/repo.git`), or null. */
export function repoPathOf(raw: string): string | null {
  const url = raw.trim();
  if (!isSshAddress(url)) return null;
  let path: string;
  if (/^ssh:\/\//i.test(url)) {
    const rest = url.slice('ssh://'.length);
    const slash = rest.indexOf('/');
    if (slash < 0) return null;
    path = rest.slice(slash + 1);
  } else {
    path = url.slice(url.indexOf(':') + 1);
  }
  path = path
    .replace(/^\/+/, '')
    .replace(/\/+$/, '')
    .replace(/\.git$/i, '');
  return path || null;
}

/** Where a project's own key goes: the repository's deploy keys, with write access (pushes need it). */
export function deployKeyHint(repoUrl: string | null | undefined): string {
  const repo = (repoUrl && repoPathOf(repoUrl)) ?? 'the repository';
  return `Add it to ${repo} → Settings → Deploy keys, tick "Allow write access" (GitLab: Settings → Repository → Deploy keys, "Grant write permissions to this key"). Only this project uses it.`;
}

/** A host key's server as people write it: the host, with the port when it is not 22. */
export const hostLabel = (h: Pick<HostKeyDetails, 'host' | 'port'>) =>
  h.port === 22 ? h.host : `${h.host}:${h.port}`;

/**
 * The ssh problem a failed clone or remote operation offers a fix for, or null. Only for an ssh
 * address: core says `auth_refused` for an https account's token too, and that keeps its plain message.
 */
export function sshProblemFor(
  repoUrl: string | null | undefined,
  code: string | null | undefined,
): SshRemoteProblem | null {
  if (!repoUrl || !isSshAddress(repoUrl)) return null;
  return code === 'ssh_key_missing' ||
    code === 'host_key_unknown' ||
    code === 'host_key_changed' ||
    code === 'auth_refused'
    ? code
    : null;
}

/** The host key an API error carries (`details.hostKey`), when it is a whole one. */
export function hostKeyOf(data: Record<string, unknown> | undefined): HostKeyDetails | null {
  const h = data?.hostKey as Partial<HostKeyDetails> | undefined;
  if (!h || typeof h !== 'object') return null;
  const { host, port, keyType, key, fingerprint } = h;
  if (
    typeof host !== 'string' ||
    typeof port !== 'number' ||
    typeof keyType !== 'string' ||
    typeof key !== 'string' ||
    typeof fingerprint !== 'string'
  )
    return null;
  return { host, port, keyType, key, fingerprint };
}

/** The key a project's ssh operations use now (its chosen one), or null when that key does not exist. */
export const keyInUse = (s: ProjectSshKeyResponse): SshKeyPublic | null =>
  s.choice === 'own' ? s.key : s.shared;

/** A key's creation date as the panels show it ("10 Nov 2026"); the API sends it as an ISO string. */
export function createdText(createdAt: Date | string): string {
  const d = new Date(createdAt);
  if (Number.isNaN(d.getTime())) return '';
  return d.toLocaleDateString('en-GB', { day: 'numeric', month: 'short', year: 'numeric' });
}

/** The ssh-key-missing banner's projects: the first `max` by name, and how many more there are. */
export function bannerProjects<T>(projects: readonly T[], max = 3): { shown: T[]; more: number } {
  return { shown: projects.slice(0, max), more: Math.max(0, projects.length - max) };
}

type ImportedProject = Pick<Project, 'id' | 'importSource' | 'repoUrl'>;

/** The import status of a project imported from an address (null for any other project: nothing to read). */
export const unfinishedImportUrl = (p: ImportedProject): string | null =>
  p.importSource === 'url' && p.repoUrl ? `/api/projects/${p.id}/import-status` : null;

/**
 * Whether an import is left unfinished in a way it can be finished outside the wizard (Ruling 23):
 * it waits for its own key, or its ssh clone failed (`import-clone` clones it again, keeping its key).
 */
export function unfinishedImport(
  p: ImportedProject,
  status: ImportStatusResponse | undefined,
): 'awaiting_key' | 'failed' | null {
  if (!status || !unfinishedImportUrl(p)) return null;
  if (status.status === 'awaiting_key') return 'awaiting_key';
  return status.status === 'failed' && isSshAddress(p.repoUrl ?? '') ? 'failed' : null;
}
