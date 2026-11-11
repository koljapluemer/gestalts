/**
 * What an app grants its views beyond the strict sandbox: `grants` in `distribution.yml`, per view, out of what that
 * view's `plugin.yml` asks for in `permissions`. Pure, so the build's refusals can be tested.
 */

export const PERMISSIONS = ['same-origin', 'microphone'] as const;
export type Permission = (typeof PERMISSIONS)[number];

const isPermission = (p: unknown): p is Permission => typeof p === 'string' && (PERMISSIONS as readonly string[]).includes(p);

/** What the check needs of a plugin. */
export type Asking = { id: string; permissions?: unknown; npm: string[] };

/** The permissions a plugin asks for, refusing unknown ones and `microphone` without `same-origin`. */
export function asked(p: Asking): Permission[] {
  const list = p.permissions ?? [];
  if (!Array.isArray(list)) throw new Error(`${p.id}: \`permissions\` is a list`);
  for (const x of list) if (!isPermission(x)) throw new Error(`${p.id}: unknown permission ${String(x)} (known: ${PERMISSIONS.join(', ')})`);
  const perms = list as Permission[];
  if (perms.includes('microphone') && !perms.includes('same-origin')) throw new Error(`${p.id}: \`microphone\` needs \`same-origin\` too, as a sandboxed frame can't record`);
  return perms;
}

/** Each plugin's granted permissions, by id; throws on any grant the distribution can't give. */
export function grantsFor(grants: unknown, plugins: Asking[]): Map<string, Permission[]> {
  const out = new Map<string, Permission[]>(plugins.map((p) => [p.id, []]));
  for (const p of plugins) asked(p);
  if (grants === undefined) return out;
  if (!grants || typeof grants !== 'object' || Array.isArray(grants)) throw new Error('grants: a map of view id to its permissions');
  for (const [id, given] of Object.entries(grants)) {
    const p = plugins.find((x) => x.id === id);
    if (!p) throw new Error(`grants: ${id} is in no plugin of the distribution`);
    if (!Array.isArray(given)) throw new Error(`grants: ${id} needs a list`);
    const wants = asked(p);
    for (const g of given) {
      if (!isPermission(g)) throw new Error(`grants: ${id}: unknown permission ${String(g)}`);
      if (!wants.includes(g)) throw new Error(`grants: ${id} doesn't ask for ${g} (permissions in its plugin.yml)`);
    }
    const perms = given as Permission[];
    if (perms.includes('microphone') && !perms.includes('same-origin')) throw new Error(`grants: ${id}: \`microphone\` needs \`same-origin\` granted too`);
    // it runs as part of the app, so nothing it runs may come from elsewhere at run time
    if (perms.includes('same-origin') && p.npm.length) throw new Error(`grants: ${id} imports npm packages (${p.npm.join(', ')}), which load from esm.sh at run time`);
    out.set(id, [...new Set(perms)]);
  }
  return out;
}
