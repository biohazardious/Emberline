/** The warnings core logs at start about settings that were ignored or cannot work together. */
import { catchAllRanges, parseCidrList } from './auth/cidr.js';
import {
  type CoreConfig,
  invalidPreviewPortVars,
  parseAllowedHosts,
  previewPortRangesOverlap,
} from './config.js';
import { previewFrameTooLong, previewPortList } from './security-headers.js';

export interface StartupWarning {
  /** Structured fields for the log line; none for a plain message. */
  data?: Record<string, unknown>;
  message: string;
}

/** What `env` and the loaded `config` say wrong about allowed hosts, container networks and preview ports. */
export function startupWarnings(
  env: NodeJS.ProcessEnv,
  config: Pick<CoreConfig, 'containerNetworks' | 'previewPorts'>,
): StartupWarning[] {
  const out: StartupWarning[] = [];
  const { ignored: ignoredHosts } = parseAllowedHosts(env.EMBERLINE_ALLOWED_HOSTS ?? '');
  if (ignoredHosts.length > 0) {
    out.push({
      data: { ignored: ignoredHosts },
      message: 'EMBERLINE_ALLOWED_HOSTS: ignoring entries that are not host names',
    });
  }
  const { invalid: invalidNetworks } = parseCidrList(env.EMBERLINE_CONTAINER_NETWORKS ?? '');
  if (invalidNetworks.length > 0) {
    out.push({
      data: { ignored: invalidNetworks },
      message: 'EMBERLINE_CONTAINER_NETWORKS: ignoring entries that are not CIDR ranges (like 100.64.0.0/10)',
    });
  }
  const catchAll = catchAllRanges(config.containerNetworks ?? []);
  if (catchAll.length > 0) {
    out.push({
      data: { ranges: catchAll },
      message:
        "EMBERLINE_CONTAINER_NETWORKS: a /0 range takes in every address, so only core's own networks limit which addresses count as Emberline's containers. List your Docker address pool instead (like 100.64.0.0/10).",
    });
  }
  const invalidPorts = invalidPreviewPortVars(env);
  if (invalidPorts.length > 0) {
    out.push({
      data: { variables: invalidPorts },
      message: 'preview ports: not a port range (like 4300-4324); using the default',
    });
  }
  const { runner, docker } = config.previewPorts;
  if (previewPortRangesOverlap(config.previewPorts)) {
    out.push({
      data: { runner, docker },
      message:
        'EMBERLINE_PREVIEW_PORTS_RUNNER and EMBERLINE_PREVIEW_PORTS_DOCKER overlap: the runner and the docker engine cannot both publish them',
    });
  }
  if (previewPortList(config.previewPorts) === null) {
    out.push({
      data: { runner, docker },
      message:
        'More than 100 preview ports are configured, so the frame policy allows every port on the preview host.',
    });
  } else if (previewFrameTooLong(undefined, config.previewPorts, env.EMBERLINE_PREVIEW_HOST)) {
    // Without EMBERLINE_PREVIEW_HOST the host is the one each page is requested on: the first page
    // that falls back says so (security-headers.ts).
    out.push({
      data: { previewHost: env.EMBERLINE_PREVIEW_HOST, runner, docker },
      message:
        'Listing the preview ports for EMBERLINE_PREVIEW_HOST would make the frame policy longer than 3 KB, so it allows every port on the preview host.',
    });
  }
  return out;
}
