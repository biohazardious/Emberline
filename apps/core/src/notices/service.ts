import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { type AgentId, type Notice, PROVIDER_REGISTRY } from '@emberline/protocol';
import { type Db, getSetting, setSetting } from '../db/index.js';

const NOTICES_KEY = 'inbox.notices';
const FABLE_SHOWN_KEY = 'notices.fableShown';
const GEMINI_REMOVED_SHOWN_KEY = 'notices.geminiRemovedShown';
/** Dismissed notices are kept so they do not come back; only this many of them. */
const KEPT_DISMISSED = 200;

/** Where the notices point: both the provider models and the persona routes live on this tab. */
const SETTINGS_LINK = '/settings?tab=providers';
/** A new-models notice names this many models, then says how many more there are. */
const NAMED_MODELS = 10;

/** The provider's name as the notices say it: its label without the note in brackets ("Antigravity"). */
export function providerName(agent: AgentId): string {
  return PROVIDER_REGISTRY[agent].label.replace(/\s*\([^)]*\)\s*$/, '');
}

/** `A, B, C`, or with more than `max`: `A, B and 3 more`. */
function namedList(names: string[], max: number): string {
  if (names.length <= max) return names.join(', ');
  return `${names.slice(0, max).join(', ')} and ${names.length - max} more`;
}

/** What is stored: a notice closed because the list read again keeps no memory of its failure. */
interface StoredNotice extends Notice {
  recovered?: boolean;
}

interface NoticeServiceEvents {
  change: [notices: Notice[]];
}

/** Inbox notices: new models, an unread model list, and the one-time Fable and Gemini CLI notices. Stored in settings. */
export class NoticeService extends EventEmitter<NoticeServiceEvents> {
  constructor(private readonly db: Db) {
    super();
  }

  list(): Notice[] {
    return this.load().map(({ recovered: _recovered, ...notice }) => notice);
  }

  /** One notice per provider per discovery; the same models announced twice make one notice. */
  newModels(agent: AgentId, models: { id: string; label: string }[]): void {
    if (models.length === 0) return;
    const ids = [...new Set(models.map((m) => m.id))].sort();
    const n = ids.length;
    this.add({
      kind: 'new_models',
      key: `new_models:${agent}:${ids.join(',')}`,
      title: `${providerName(agent)} has ${n} new ${n === 1 ? 'model' : 'models'}`,
      text: namedList(
        models.map((m) => m.label),
        NAMED_MODELS,
      ),
      link: SETTINGS_LINK,
    });
  }

  /** One notice per provider until a read succeeds again. */
  readFailed(agent: AgentId, cliVersion: string | null, reason: string): void {
    const provider = providerName(agent);
    this.add({
      kind: 'models_unread',
      key: `models_unread:${agent}`,
      title: `Couldn't read ${provider}'s model list`,
      text: `Couldn't read ${provider}'s model list (${cliVersion ?? 'unknown version'}): ${reason}. The last list read stays; you can add a model by hand.`,
      link: SETTINGS_LINK,
    });
  }

  /** A read worked again: the open failure notice of that provider closes. */
  readRecovered(agent: AgentId): void {
    const key = `models_unread:${agent}`;
    const all = this.load();
    const now = new Date().toISOString();
    let changed = false;
    for (const n of all) {
      if (n.key !== key || n.recovered) continue;
      n.recovered = true;
      n.dismissedAt ??= now;
      changed = true;
    }
    if (changed) this.save(all);
  }

  /** Whether the Fable notice had its one chance already (shown, or skipped on a fresh install). */
  fableNoticeShown(): boolean {
    return getSetting<boolean>(this.db, FABLE_SHOWN_KEY) === true;
  }

  /** Once, after the upgrade: the routes that name Fable ran on Opus until now. */
  fableNowFable(routes: string[]): void {
    if (this.fableNoticeShown()) return;
    setSetting(this.db, FABLE_SHOWN_KEY, true);
    if (routes.length === 0) return;
    this.add({
      kind: 'fable_now_fable',
      key: 'fable_now_fable',
      title: 'Fable now runs as Fable',
      text: `Routes on Fable ran on Opus until now; they run on Fable from now on: ${routes.join(', ')}.`,
      link: SETTINGS_LINK,
    });
  }

  /** Whether the Gemini CLI notice had its one chance already. */
  geminiRemovedNoticeShown(): boolean {
    return getSetting<boolean>(this.db, GEMINI_REMOVED_SHOWN_KEY) === true;
  }

  /** Once, after the upgrade that removed Gemini CLI: where each route that used it went. */
  geminiRemoved(lines: string[], now = new Date()): void {
    if (this.geminiRemovedNoticeShown()) return;
    setSetting(this.db, GEMINI_REMOVED_SHOWN_KEY, true);
    const moved = lines.length > 0 ? ` What changed: ${lines.join('; ')}.` : '';
    this.add(
      {
        kind: 'gemini_removed',
        key: 'gemini_removed',
        title: 'Gemini CLI was removed',
        text: `Emberline no longer runs Gemini CLI; Antigravity stays.${moved} Old Gemini runs stay in the list; hand them off to another agent to carry on. Antigravity now needs its own Google sign-in; a Gemini API key no longer runs it. The Gemini API key stays for Aider.`,
        link: SETTINGS_LINK,
      },
      now,
    );
  }

  /** False when there is no such notice. */
  dismiss(id: string): boolean {
    const all = this.load();
    const notice = all.find((n) => n.id === id);
    if (!notice) return false;
    if (!notice.dismissedAt) {
      notice.dismissedAt = new Date().toISOString();
      this.save(all);
    }
    return true;
  }

  private add(fields: Pick<Notice, 'kind' | 'key' | 'title' | 'text' | 'link'>, now = new Date()): void {
    const all = this.load();
    const existing = all.find((n) => n.key === fields.key);
    // A failure closed by a recovery may happen again and is news again; anything else is a repeat.
    if (existing && !existing.recovered) return;
    const kept = all.filter((n) => n !== existing);
    kept.unshift({
      id: randomUUID(),
      ...fields,
      createdAt: now.toISOString(),
      dismissedAt: null,
    });
    this.save(kept);
  }

  private load(): StoredNotice[] {
    return getSetting<StoredNotice[]>(this.db, NOTICES_KEY) ?? [];
  }

  private save(all: StoredNotice[]): void {
    let dismissed = 0;
    const kept = all.filter((n) => !n.dismissedAt || ++dismissed <= KEPT_DISMISSED);
    setSetting(this.db, NOTICES_KEY, kept);
    this.emit('change', this.list());
  }
}
