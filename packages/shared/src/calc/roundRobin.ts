export interface PickResult {
  /** Chosen staff id, or null if the pool is empty. */
  assignee: string | null;
  /** New pointer value (index of the chosen staff + 1, modulo pool size). */
  nextPointer: number;
  /** True if nobody was eligible and the next person in plain order was used (alert the Manager). */
  noneEligible: boolean;
}

/**
 * Spec 10.4. `order` is the pool's ordered staff; `pointer` the index of the next person.
 * With skipAbsent, ineligible staff are skipped. If nobody is eligible, take the next in normal order.
 */
export function pickAssignee(
  order: readonly string[],
  pointer: number,
  isEligible: (id: string) => boolean,
  skipAbsent: boolean,
): PickResult {
  const n = order.length;
  if (n === 0) return { assignee: null, nextPointer: 0, noneEligible: false };
  const start = ((pointer % n) + n) % n;
  if (skipAbsent) {
    for (let i = 0; i < n; i++) {
      const idx = (start + i) % n;
      const id = order[idx];
      if (id !== undefined && isEligible(id)) return { assignee: id, nextPointer: (idx + 1) % n, noneEligible: false };
    }
  }
  const id = order[start];
  return { assignee: id ?? null, nextPointer: (start + 1) % n, noneEligible: skipAbsent };
}
