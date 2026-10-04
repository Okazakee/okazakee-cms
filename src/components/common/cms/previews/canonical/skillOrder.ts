/**
 * Canonical skill ordering inside a category — the mirror of
 * `okazakee-ws/src/utils/skillOrder.ts`.
 *
 * The public site sorts `skills.position` (NULL last, id tiebreak) before
 * rendering the grid; the CMS preview applies the exact same comparator so a
 * draft never disagrees with what the site will publish. Keep both copies in
 * sync: nullish last, ascending position, then ascending id as the stable
 * tiebreak.
 */
export function sortSkillsByPosition<
  T extends {
    id: number;
    position: number | null;
  },
>(skills: readonly T[]): T[] {
  return [...skills].sort((a, b) => {
    const left = a.position ?? null;
    const right = b.position ?? null;
    if (left !== null && right !== null && left !== right) return left - right;
    if (left !== null && right === null) return -1;
    if (left === null && right !== null) return 1;
    return a.id - b.id;
  });
}
