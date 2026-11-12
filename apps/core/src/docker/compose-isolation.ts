/**
 * One compose stack per worktree: every run's preview starts under its own project name
 * (`emberline-<run8>-preview`), so compose names its containers, volumes and networks after that
 * project. A name the compose file fixes (a `container_name`, a volume or network `name:`, an
 * `external` one) is shared by every worktree's stack: the second preview would collide with the
 * first, or two branches would write the same database volume. Such a file is refused before
 * `up`, naming each fixed name and where it is set.
 */
import { COMPOSE_SERVICE_NAME } from '@emberline/protocol';
import { z } from 'zod';
import { clipText } from '../text/control-chars.js';

/** Fixed names listed in one error; the rest are counted. */
const MAX_LISTED = 5;
const NAME_MAX_CHARS = 80;

const NamedResource = z.object({ name: z.string().optional(), external: z.unknown().optional() }).nullable();

/** The parts of `docker compose config --format json` the check reads; anything else is ignored. */
const ResolvedCompose = z.object({
  services: z.record(z.string(), z.object({ container_name: z.unknown().optional() })),
  volumes: z.record(z.string(), NamedResource).optional(),
  networks: z.record(z.string(), NamedResource).optional(),
});

export type ComposeStackInspection = { ok: true; services: string[] } | { ok: false; error: string };

/** Why one resource's name is not the project's own, or null when compose derived it from `project`. */
function fixedResourceName(
  kind: 'volume' | 'network',
  key: string,
  def: z.infer<typeof NamedResource>,
  project: string,
): string | null {
  const quoted = (text: string) => JSON.stringify(clipText(text, NAME_MAX_CHARS));
  if (def?.external !== undefined && def.external !== false && def.external !== null) {
    return `${kind} ${quoted(key)} is external (${quoted(def.name ?? key)})`;
  }
  const name = def?.name;
  // compose writes the derived name into the resolved config: `<project>_<key>`.
  if (name === undefined || name === `${project}_${key}`) return null;
  return `${kind} ${quoted(key)} has the fixed name ${quoted(name)}`;
}

/** Every fixed name in the resolved config, in file order: services, then volumes, then networks. */
export function fixedComposeNames(config: z.infer<typeof ResolvedCompose>, project: string): string[] {
  const found: string[] = [];
  for (const [service, def] of Object.entries(config.services)) {
    const name = def.container_name;
    if (typeof name === 'string' && name !== '') {
      found.push(
        `service ${JSON.stringify(clipText(service, NAME_MAX_CHARS))} sets container_name ${JSON.stringify(clipText(name, NAME_MAX_CHARS))}`,
      );
    }
  }
  for (const [key, def] of Object.entries(config.volumes ?? {})) {
    const why = fixedResourceName('volume', key, def, project);
    if (why) found.push(why);
  }
  for (const [key, def] of Object.entries(config.networks ?? {})) {
    const why = fixedResourceName('network', key, def, project);
    if (why) found.push(why);
  }
  return found;
}

/** The refusal: the file, each fixed name (at most {@link MAX_LISTED}, then a count), and what to do. */
export function fixedNamesError(file: string, fixed: readonly string[], project: string): string {
  const listed = fixed.slice(0, MAX_LISTED).join('; ');
  const more = fixed.length > MAX_LISTED ? `; and ${fixed.length - MAX_LISTED} more` : '';
  return (
    `${file} fixes names that every worktree's preview would share: ${listed}${more}. ` +
    `Remove them so compose names each stack after its own project (${project}).`
  );
}

/**
 * Reads `config --format json` for `project`: the service names (only those compose accepts as
 * names), or why the stack cannot run as a per-worktree preview.
 */
export function inspectComposeStack(stdout: string, project: string, file: string): ComposeStackInspection {
  let json: unknown;
  try {
    json = JSON.parse(stdout);
  } catch {
    return { ok: false, error: `docker compose config did not print the configuration of ${file}` };
  }
  const parsed = ResolvedCompose.safeParse(json);
  if (!parsed.success) {
    return { ok: false, error: `docker compose config printed no services for ${file}` };
  }
  const fixed = fixedComposeNames(parsed.data, project);
  if (fixed.length > 0) return { ok: false, error: fixedNamesError(file, fixed, project) };
  return {
    ok: true,
    services: Object.keys(parsed.data.services).filter((name) => COMPOSE_SERVICE_NAME.test(name)),
  };
}
