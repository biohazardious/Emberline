import { DOCKER_ENGINE_UNREACHABLE_HINT, type DockerEngineStatus, dockerEngineOffText, withHint } from '@emberline/protocol';

/** The Dashboard's quiet line about the Docker engine sidecar; null when core does not report it. */
export function dockerEngineLine(docker: DockerEngineStatus | undefined): string | null {
  if (!docker) return null;
  if (!docker.enabled) return docker.reason === 'switched_off' ? 'Docker engine: off' : 'Docker engine: not configured';
  if (!docker.checked) return 'Docker engine: checking…';
  if (docker.available) return `Docker engine: on (${docker.version ?? 'unknown version'})`;
  return withHint(`Docker engine: unreachable${docker.error ? ` — ${docker.error}` : ''}`, DOCKER_ENGINE_UNREACHABLE_HINT);
}

/** The Dashboard line's tooltip: why an engine that is not on is off, else what it is. */
export function dockerEngineTitle(docker: DockerEngineStatus): string {
  if (!docker.enabled) return dockerEngineOffText(docker);
  return 'Isolated Docker engine for agents and previews (on by default; EMBERLINE_DOCKER_ENGINE=0 turns it off)';
}

/** The Docker page's empty state without an engine: switched off, or not configured (an old compose file). */
export function dockerEngineOffState(docker: DockerEngineStatus): { title: string; text: string } {
  return {
    title: docker.reason === 'switched_off' ? 'The Docker engine is off.' : 'The Docker engine is missing.',
    text: dockerEngineOffText(docker),
  };
}
