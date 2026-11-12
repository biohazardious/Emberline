/** Who Emberline's commits are made as: its own (merges, snapshots, adopt) and the agents' in a run. */
import { z } from 'zod';

/** The identity used when none is configured (the one every Emberline before 0.8.0 used). */
export const DEFAULT_COMMIT_IDENTITY = {
  name: 'Emberline AI Factory',
  email: 'factory@emberline.local',
} as const;

/** A line break or another control character: git would cut the name there, or reject it. */
function hasControlCharacter(value: string): boolean {
  for (const ch of value) {
    const code = ch.charCodeAt(0);
    if (code < 0x20 || code === 0x7f) return true;
  }
  return false;
}

export const CommitIdentity = z.object({
  name: z
    .string()
    .trim()
    .min(1, 'enter a name')
    .max(100, 'use at most 100 characters')
    .refine((v) => !hasControlCharacter(v) && !/[<>]/.test(v), 'use no line breaks, < or >'),
  email: z
    .string()
    .trim()
    .max(254, 'use at most 254 characters')
    .refine(
      (v) => !hasControlCharacter(v) && /^[^\s<>@]+@[^\s<>@]+$/.test(v),
      'enter an email address such as factory@example.com',
    ),
});
export type CommitIdentity = z.infer<typeof CommitIdentity>;
