import { z } from 'zod';

/** A public SSH key as the API shows it; the private key never leaves core. */
export const SshKeyPublic = z.object({
  publicKey: z.string(),
  fingerprint: z.string(),
  createdAt: z.coerce.date(),
  algorithm: z.literal('ed25519'),
});
export type SshKeyPublic = z.infer<typeof SshKeyPublic>;

export const SshKeyResponse = z.object({ key: SshKeyPublic.nullable() });
export type SshKeyResponse = z.infer<typeof SshKeyResponse>;

export const SshKeyChoice = z.enum(['shared', 'own']);
export type SshKeyChoice = z.infer<typeof SshKeyChoice>;

export const ProjectSshKeyResponse = z.object({
  choice: SshKeyChoice,
  key: SshKeyPublic.nullable(),
  shared: SshKeyPublic.nullable(),
});
export type ProjectSshKeyResponse = z.infer<typeof ProjectSshKeyResponse>;

export const SetSshKeyChoiceRequest = z.object({ choice: SshKeyChoice });
export type SetSshKeyChoiceRequest = z.infer<typeof SetSshKeyChoiceRequest>;

export const TrustedHostKey = z.object({
  host: z.string(),
  port: z.number().int(),
  keyType: z.string(),
  key: z.string(),
  fingerprint: z.string(),
  trustedAt: z.coerce.date(),
});
export type TrustedHostKey = z.infer<typeof TrustedHostKey>;

export const TrustedHostKeysResponse = z.object({ hosts: z.array(TrustedHostKey) });
export type TrustedHostKeysResponse = z.infer<typeof TrustedHostKeysResponse>;

export const TrustHostKeyRequest = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  keyType: z.string().min(1),
  key: z.string().min(1),
  fingerprint: z.string().min(1),
});
export type TrustHostKeyRequest = z.infer<typeof TrustHostKeyRequest>;

export const RemoveHostKeyRequest = z.object({
  host: z.string().min(1),
  port: z.number().int().min(1).max(65535),
  keyType: z.string().min(1),
});
export type RemoveHostKeyRequest = z.infer<typeof RemoveHostKeyRequest>;
