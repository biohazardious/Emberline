import { DOCKER_ENGINE_UNREACHABLE_HINT, type DockerEngineStatus, withHint } from '@emberline/protocol';

/** The Dashboard's quiet line about the Docker engine sidecar; null when core does not report it. */
export function dockerEngineLine(docker: DockerEngineStatus | undefined): string | null {
  if (!docker) return null;
  if (!docker.enabled) return 'Docker engine: off';
  if (!docker.checked) return 'Docker engine: checking…';
  if (docker.available) return `Docker engine: on (${docker.version ?? 'unknown version'})`;
  return withHint(`Docker engine: unreachable${docker.error ? ` — ${docker.error}` : ''}`, DOCKER_ENGINE_UNREACHABLE_HINT);
}
