import type { DockerEngineStatus } from '@emberline/protocol';

/** Shown with an unreachable engine: a host that cannot run it can switch it off. */
const UNREACHABLE_HINT = "If this host can't run it (privileged containers, overlay), set EMBERLINE_DOCKER_ENGINE=0.";

/** The Dashboard's quiet line about the Docker engine sidecar; null when core does not report it. */
export function dockerEngineLine(docker: DockerEngineStatus | undefined): string | null {
  if (!docker) return null;
  if (!docker.enabled) return 'Docker engine: off';
  if (!docker.checked) return 'Docker engine: checking…';
  if (docker.available) return `Docker engine: on (${docker.version ?? 'unknown version'})`;
  return `Docker engine: unreachable${docker.error ? ` — ${docker.error}` : ''}. ${UNREACHABLE_HINT}`;
}
