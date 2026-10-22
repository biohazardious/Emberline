import { describe, expect, it } from 'vitest';
import { isPermissionNotification } from './index.js';

describe('isPermissionNotification', () => {
  it('trusts notification_type when present, else the message text', () => {
    expect(isPermissionNotification({ notification_type: 'permission_prompt' })).toBe(true);
    expect(isPermissionNotification({ notification_type: 'idle_prompt', message: 'permission?' })).toBe(
      false,
    );
    expect(isPermissionNotification({ message: 'Claude needs your Permission' })).toBe(true);
    expect(isPermissionNotification({ message: 'idle' })).toBe(false);
    expect(isPermissionNotification({})).toBe(false);
  });
});
