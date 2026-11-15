import { EventEmitter } from 'node:events';
import { randomUUID } from 'node:crypto';
import { type AgentId, type Notice, PROVIDER_REGISTRY } from '@emberline/protocol';
import { type Db, getSetting, setSetting } from '../db/index.js';

const NOTICES_KEY = 'inbox.notices';
const FABLE_SHOWN_KEY = 'notices.fableShown';
/** Dismissed notices are kept so they do not come back; only this many of them. */
const KEPT_DISMISSED = 200;

/** Where the notices point: both the provider models and the persona routes live on this tab. */
const SETTINGS_LINK = '/settings?tab=providers';

/** What is stored: a notice closed because the list read again keeps no memory of its failure. */
interface StoredNotice extends Notice {
  recovered?: boolean;
}

interface NoticeServiceEvents {
  change: [notices: Notice[]];
}

/** Inbox notices: new models, an unread model list, and the one-time Fable notice. Stored in settings. */
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
      title: `${PROVIDER_REGISTRY[agent].shortLabel} has ${n} new ${n === 1 ? 'model' : 'models'}`,
      text: models.map((m) => m.label).join(', '),
      link: SETTINGS_LINK,
    });
  }

  /** One notice per provider until a read succeeds again. */
  readFailed(agent: AgentId, cliVersion: string | null, reason: string): void {
    const provider = PROVIDER_REGISTRY[agent].shortLabel;
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

  /** Once, after the upgrade: the routes that name Fable ran on Opus until now. */
  fableNowFable(routes: string[]): void {
    if (getSetting<boolean>(this.db, FABLE_SHOWN_KEY)) return;
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

  private add(fields: Pick<Notice, 'kind' | 'key' | 'title' | 'text' | 'link'>): void {
    const all = this.load();
    const existing = all.find((n) => n.key === fields.key);
    // A failure closed by a recovery may happen again and is news again; anything else is a repeat.
    if (existing && !existing.recovered) return;
    const kept = all.filter((n) => n !== existing);
    kept.unshift({
      id: randomUUID(),
      ...fields,
      createdAt: new Date().toISOString(),
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
