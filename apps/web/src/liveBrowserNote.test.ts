import { createElement } from 'react';
import { describe, expect, it } from 'vitest';
import { FollowingNote } from './components/LiveBrowserStudio';
import { FOLLOW_AGENT, LIVE_BROWSER_CAN_FOLLOW_NOTE, LIVE_BROWSER_FOLLOWING_NOTE } from './containerPreview';
import { renderStatic } from './staticRender';

const note = (snap: { canFollow?: boolean; following?: boolean } | null) =>
  renderStatic(createElement(FollowingNote, { snap, acting: false, onFollow: () => {} }));

describe('FollowingNote (B-11)', () => {
  it('keeps the Follow it button out of the live region', () => {
    const html = note({ canFollow: true, following: false });
    expect(html).toMatch(/<p[^>]*role="status"[^>]*>[^<]*<\/p>/); // no button inside the live region
    expect(html).toContain(`>${LIVE_BROWSER_CAN_FOLLOW_NOTE}</p>`);
    expect(html).toContain(`>${FOLLOW_AGENT}</button>`);
    expect(html).toContain('class="browser-following-row"');
  });

  it('while following: the note alone', () => {
    const html = note({ following: true });
    expect(html).toContain(LIVE_BROWSER_FOLLOWING_NOTE.replace("'", '&#x27;'));
    expect(html).not.toContain('<button');
  });

  it('nothing while no agent uses the browser', () => {
    expect(note({ following: false })).toBe('');
    expect(note(null)).toBe('');
  });
});
