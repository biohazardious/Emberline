import type { AgentId } from '@emberline/protocol';

/** Small colour mark that tells providers apart (theme tokens, no emoji). */
export function ProviderMark({ id }: { id: AgentId }) {
  return <span className={`provider-mark provider-mark-${id}`} aria-hidden />;
}
