/** API contracts: auth. */
import { z } from 'zod';

export const AuthState = z.object({
  setupRequired: z.boolean(),
  authenticated: z.boolean(),
  /** Why a session cookie the browser holds no longer signs it in (e.g. its network address changed). */
  signedOut: z.string().optional(),
});
export type AuthState = z.infer<typeof AuthState>;

/** Why a session from before 0.5.0, or one whose key this browser lost, no longer signs it in. */
export const SESSION_KEY_MISSING_MESSAGE = 'signed out: Emberline now ties each sign-in to this browser';

/**
 * What setup, login and a password change answer. The browser keeps `sessionKey` (localStorage) and
 * sends it on every change and live connection; the cookie alone only authorises plain reads.
 */
export const SessionIssued = z.object({ ok: z.literal(true), sessionKey: z.string().min(1) });
export type SessionIssued = z.infer<typeof SessionIssued>;

export const MIN_PASSWORD_LENGTH = 10;

export const SetupBody = z.object({
  password: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
  /** One-time token from the core log (`make logs`), so only the server's operator can claim it. */
  setupToken: z.string().trim().min(1).max(256),
});
export type SetupBody = z.infer<typeof SetupBody>;

export const LoginBody = z.object({ password: z.string().min(1).max(1024) });
export type LoginBody = z.infer<typeof LoginBody>;

export const ChangePasswordBody = z.object({
  currentPassword: z.string().min(1).max(1024),
  newPassword: z.string().min(MIN_PASSWORD_LENGTH).max(1024),
});
export type ChangePasswordBody = z.infer<typeof ChangePasswordBody>;
