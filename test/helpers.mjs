export const TODAY = '2026-11-20';

/**
 * @param {Record<string, unknown>} fields
 * @returns {string}
 */
export function ruleYaml(fields) {
  const lines = ['rules:'];
  let first = true;
  for (const [k, v] of Object.entries(fields)) {
    const prefix = first ? '  - ' : '    ';
    first = false;
    lines.push(`${prefix}${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
  }
  return lines.join('\n') + '\n';
}

export const GOOD_RULE = Object.freeze({
  id: 'S2-DEP-VENDOR',
  dune_rule: 2,
  engine: 'depcruise',
  scope: 'apps/**',
  instead: 'use the platform adapters',
  owner: 'team-core',
});

/**
 * @param {Record<string, unknown>[]} entries
 * @returns {string}
 */
export function exceptionsYaml(entries) {
  if (entries.length === 0) return 'exceptions: []\n';
  const lines = ['exceptions:'];
  for (const e of entries) {
    let first = true;
    for (const [k, v] of Object.entries(e)) {
      lines.push(`${first ? '  - ' : '    '}${k}: ${typeof v === 'string' ? JSON.stringify(v) : String(v)}`);
      first = false;
    }
  }
  return lines.join('\n') + '\n';
}

/**
 * Deterministic shuffle driven by fast-check generated keys.
 * @template T
 * @param {T[]} items
 * @param {number[]} keys
 * @returns {T[]}
 */
export function permute(items, keys) {
  return items
    .map((v, i) => ({ v, k: keys[i % Math.max(1, keys.length)] ?? 0, i }))
    .sort((a, b) => a.k - b.k || b.i - a.i)
    .map((p) => p.v);
}
