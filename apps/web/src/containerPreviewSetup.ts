import type { ContainerPreviewOptionsResponse, ContainerPreviewService } from '@emberline/protocol';

export const CONTAINER_PREVIEW_TITLE = 'Container preview';
export const USE_CONTAINER_PREVIEW_LABEL = 'Use container preview';
/** `#container-preview` on the Settings page scrolls to the box. */
export const CONTAINER_PREVIEW_ANCHOR = 'container-preview';
export const CONTAINER_PREVIEW_DIFF_DELAY_MS = 300;

export interface ContainerPreviewDraft {
  service: string;
  port: number | null;
}

/** Core sets `file` exactly when the box belongs on the page (spec §2); `available` says whether it can save. */
export function containerPreviewBoxShown(o: ContainerPreviewOptionsResponse | undefined): boolean {
  return Boolean(o?.file);
}

/** Spec defaults: the service named `web`, else the first service with a port; its first port. */
export function defaultContainerPreviewChoice(
  services: readonly ContainerPreviewService[],
): ContainerPreviewDraft | null {
  const pick =
    services.find((s) => s.name === 'web') ?? services.find((s) => s.ports.length > 0) ?? services[0];
  return pick ? { service: pick.name, port: pick.ports[0] ?? null } : null;
}

export function choiceForService(
  services: readonly ContainerPreviewService[],
  name: string,
): ContainerPreviewDraft {
  return { service: name, port: services.find((s) => s.name === name)?.ports[0] ?? null };
}

export function parsePort(text: string): number | null {
  if (!/^\d{1,5}$/.test(text.trim())) return null;
  const port = Number(text.trim());
  return port >= 1 && port <= 65535 ? port : null;
}

export const PORT_PROBLEM = 'Enter a port from 1 to 65535.';

/** Why the typed port cannot be used, or null when it can. */
export function portProblem(text: string): string | null {
  return parsePort(text) === null ? PORT_PROBLEM : null;
}

export function containerPreviewSaveEnabled(v: {
  draft: ContainerPreviewDraft | null;
  diffReady: boolean;
  busy: boolean;
}): boolean {
  return Boolean(v.draft?.service) && v.draft?.port != null && v.diffReady && !v.busy;
}

export function containerPreviewIntro(file: string): string {
  return `Preview this project with a service of ${file} in the Docker engine instead of a command. Emberline publishes the container port itself.`;
}

export function declaredPortsLine(service: string, ports: readonly number[]): string {
  if (ports.length === 0) return `${service} declares no port. Enter the one its app listens on.`;
  return `${service} declares ${ports.length === 1 ? 'port' : 'ports'} ${ports.join(', ')}.`;
}

export function containerPreviewSettingsHref(projectId: string): string {
  return `/projects/${projectId}/settings#${CONTAINER_PREVIEW_ANCHOR}`;
}
