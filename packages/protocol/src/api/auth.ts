/** API contracts: auth. */
import { z } from 'zod';

export const AuthState = z.object({
  setupRequired: z.boolean(),
  authenticated: z.boolean(),
});
export type AuthState = z.infer<typeof AuthState>;

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
