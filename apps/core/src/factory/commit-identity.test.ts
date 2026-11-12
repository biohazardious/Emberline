import { DEFAULT_COMMIT_IDENTITY } from '@emberline/protocol';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import { type Db, openDb } from '../db/index.js';
import { writeRepositorySettings } from '../db/project-settings.js';
import { projects } from '../db/schema.js';
import {
  commitIdentityFor,
  gitIdentityArgs,
  gitIdentityEnv,
  runCommit,
  runOutputSubject,
  stripAttributionTrailers,
  SUBJECT_MAX,
} from './commit-identity.js';
import { getFactorySettings, updateFactorySettings } from './settings.js';

describe('runOutputSubject', () => {
  it('names a ticket run after its ticket, typed by persona', () => {
    const ticket = { label: 'EL-4', ticketKey: 'EL-4', ticketTitle: 'Split the big pages' };
    expect(runOutputSubject({ ...ticket, persona: 'coder' })).toBe('feat(EL-4): Split the big pages');
    expect(runOutputSubject({ ...ticket, persona: 'ui_ux' })).toBe('feat(EL-4): Split the big pages');
    expect(runOutputSubject({ ...ticket, persona: 'qa' })).toBe('test(EL-4): Split the big pages');
    expect(runOutputSubject({ ...ticket, persona: 'product_owner' })).toBe('docs(EL-4): Split the big pages');
  });

  it('collapses whitespace, trims and drops attribution trailers', () => {
    expect(
      runOutputSubject({
        label: 'EL-5',
        ticketKey: 'EL-5',
        ticketTitle: '  Fix   the\nboard\n\nCo-Authored-By: Claude <noreply@anthropic.com>\n',
      }),
    ).toBe('feat(EL-5): Fix the board');
  });

  it('caps the subject at 72 characters on a word boundary', () => {
    const title = 'Make the review page keyboard friendly and virtualise the long file list for big diffs';
    const subject = runOutputSubject({ label: 'EL-6', ticketKey: 'EL-6', ticketTitle: title });
    expect(subject.length).toBeLessThanOrEqual(SUBJECT_MAX);
    expect(subject).toBe('feat(EL-6): Make the review page keyboard friendly and virtualise the…');
    // One long word is cut where it has to be.
    const long = runOutputSubject({ label: 'EL-7', ticketKey: 'EL-7', ticketTitle: 'x'.repeat(100) });
    expect(long).toHaveLength(SUBJECT_MAX);
    expect(long.endsWith('x…')).toBe(true);
    // Exactly 72 is kept whole.
    const exact = 'y'.repeat(SUBJECT_MAX - 'feat(EL-8): '.length);
    expect(runOutputSubject({ label: 'EL-8', ticketKey: 'EL-8', ticketTitle: exact })).toBe(
      `feat(EL-8): ${exact}`,
    );
  });

  it('uses the run title without a ticket, and the old subject without any title', () => {
    expect(runOutputSubject({ label: 'abcd1234', runTitle: 'Tidy the README' })).toBe(
      'feat: Tidy the README',
    );
    expect(runOutputSubject({ label: 'abcd1234', runTitle: '  ' })).toBe(
      'feat(abcd1234): factory run output',
    );
    expect(runOutputSubject({ label: 'EL-9', ticketKey: 'EL-9', ticketTitle: '' })).toBe(
      'feat(EL-9): factory run output',
    );
  });
});

describe('stripAttributionTrailers', () => {
  it('removes Co-Authored-By lines in any case and keeps the rest', () => {
    expect(
      stripAttributionTrailers(
        'feat: x\n\nBody line.\n\nCo-Authored-By: Claude <noreply@anthropic.com>\nco-authored-by: Bot <b@b>\n',
      ),
    ).toBe('feat: x\n\nBody line.');
    expect(stripAttributionTrailers('fix: y')).toBe('fix: y');
  });
});

describe('git identity', () => {
  it('sets user, author and committer on the command line', () => {
    expect(gitIdentityArgs({ name: 'Ada', email: 'ada@example.com' })).toEqual([
      '-c',
      'user.name=Ada',
      '-c',
      'user.email=ada@example.com',
      '-c',
      'author.name=Ada',
      '-c',
      'author.email=ada@example.com',
      '-c',
      'committer.name=Ada',
      '-c',
      'committer.email=ada@example.com',
    ]);
    expect(gitIdentityArgs()).toContain(`user.email=${DEFAULT_COMMIT_IDENTITY.email}`);
  });

  it('gives agent sessions the author and committer environment', () => {
    expect(gitIdentityEnv({ name: 'Ada', email: 'ada@example.com' })).toEqual({
      GIT_AUTHOR_NAME: 'Ada',
      GIT_AUTHOR_EMAIL: 'ada@example.com',
      GIT_COMMITTER_NAME: 'Ada',
      GIT_COMMITTER_EMAIL: 'ada@example.com',
    });
  });
});

describe('commitIdentityFor', () => {
  let db: Db;
  let close: () => void;
  beforeEach(() => {
    ({ db, close } = openDb(':memory:'));
    db.insert(projects)
      .values({ id: 'p1', name: 'p1', slug: 'p1', path: '/w/p1', createdAt: new Date() })
      .run();
  });
  afterEach(() => close());

  it('is the default until the factory sets one, then the project may override it', () => {
    expect(commitIdentityFor(db, 'p1')).toEqual(DEFAULT_COMMIT_IDENTITY);
    expect(getFactorySettings(db).commitIdentity).toEqual(DEFAULT_COMMIT_IDENTITY);
    updateFactorySettings(db, { commitIdentity: { name: ' Factory ', email: 'f@example.com' } });
    expect(getFactorySettings(db).commitIdentity).toEqual({ name: 'Factory', email: 'f@example.com' });
    expect(commitIdentityFor(db, 'p1')).toEqual({ name: 'Factory', email: 'f@example.com' });
    expect(commitIdentityFor(db, null)).toEqual({ name: 'Factory', email: 'f@example.com' });
    writeRepositorySettings(db, 'p1', { commitIdentity: { name: 'Own', email: 'own@example.com' } });
    expect(commitIdentityFor(db, 'p1')).toEqual({ name: 'Own', email: 'own@example.com' });
    expect(commitIdentityFor(db, 'unknown')).toEqual({ name: 'Factory', email: 'f@example.com' });
  });

  it('refuses names and emails git would cut or reject', () => {
    for (const commitIdentity of [
      { name: 'Two\nLines', email: 'a@example.com' },
      { name: 'A <b>', email: 'a@example.com' },
      { name: '', email: 'a@example.com' },
      { name: 'x'.repeat(101), email: 'a@example.com' },
      { name: 'Ada', email: 'not an email' },
      { name: 'Ada', email: 'a@b\r@c' },
      { name: 'Ada', email: `${'a'.repeat(250)}@b.cd` },
    ]) {
      expect(() => updateFactorySettings(db, { commitIdentity })).toThrow();
    }
    expect(getFactorySettings(db).commitIdentity).toEqual(DEFAULT_COMMIT_IDENTITY);
  });

  it("names a run's commit after its ticket and uses the project's identity", () => {
    writeRepositorySettings(db, 'p1', { commitIdentity: { name: 'Own', email: 'own@example.com' } });
    const run = { id: 'abcdef123456', projectId: 'p1', persona: 'qa' as const, title: 'EL-1 Cover login' };
    expect(runCommit(db, run, { key: 'EL-1', title: 'Cover login' })).toEqual({
      identity: { name: 'Own', email: 'own@example.com' },
      subject: 'test(EL-1): Cover login',
    });
    expect(runCommit(db, { ...run, persona: 'coder', title: 'Quick fix' }, null).subject).toBe(
      'feat: Quick fix',
    );
  });
});
