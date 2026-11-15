/** A run's agent as people read it; small on its own so lists can name agents without the inspector. */
export function formatAgentDisplayName(agent?: string | null): string {
  switch (agent) {
    case 'antigravity':
      return 'Google Antigravity (agy)';
    // Old runs keep the agent they ran on; Gemini CLI is no longer a provider.
    case 'gemini':
      return 'Gemini CLI (removed)';
    case 'codex':
      return 'OpenAI Codex';
    case 'copilot':
      return 'GitHub Copilot';
    case 'aider':
      return 'Aider';
    default:
      return 'Claude';
  }
}
