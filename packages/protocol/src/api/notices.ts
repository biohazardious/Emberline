/** API contracts: Inbox notices, the second kind of Inbox item besides runs. */
import { z } from 'zod';

export const NoticeKind = z.enum(['new_models', 'models_unread', 'fable_now_fable']);
export type NoticeKind = z.infer<typeof NoticeKind>;

/** A note for the Inbox that needs no action; it is never counted in the topbar's "need you". */
export const Notice = z.object({
  id: z.string(),
  kind: NoticeKind,
  title: z.string(),
  text: z.string(),
  /** An in-app path the notice points to (Settings), or none. */
  link: z.string().nullable(),
  createdAt: z.string(),
  dismissedAt: z.string().nullable(),
  /** Same key, same notice: a dismissed notice does not come back for the same models or failure. */
  key: z.string(),
});
export type Notice = z.infer<typeof Notice>;
