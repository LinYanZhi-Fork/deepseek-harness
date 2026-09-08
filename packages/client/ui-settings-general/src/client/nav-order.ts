/**
 * User-order projection for the settings-section nav. Pure and framework-free:
 * the apply closure feeds it the plugin-ordered rows and the persisted user
 * order, and the shell renders exactly what it returns.
 */

/**
 * Apply the persisted user section order over the plugin-declared order.
 * Listed ids render first in the listed sequence (stale ids that no longer
 * have a registration are dropped, duplicates are collapsed); remaining rows
 * keep their plugin order and append after them, so a section that appears
 * after the user pinned their layout lands at the tail instead of displacing
 * a pinned position. An empty or absent user order returns the rows untouched.
 * @param rows - nav rows in plugin-declared order.
 * @param userOrder - persisted section ids in the user's preferred order.
 * @returns the merged nav rows.
 */
export function applyNavOrder<T extends { id: string }>(
  rows: readonly T[],
  userOrder: readonly string[],
): T[] {
  if (userOrder.length === 0) return [...rows]
  const byId = new Map(rows.map(row => [row.id, row]))
  const seen = new Set<string>()
  const head: T[] = []
  for (const id of userOrder) {
    if (seen.has(id)) continue
    seen.add(id)
    const row = byId.get(id)
    if (row !== undefined) head.push(row)
  }
  const tail = rows.filter(row => !seen.has(row.id))
  return [...head, ...tail]
}
