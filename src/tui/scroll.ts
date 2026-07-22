/**
 * Keep `cursor` within the visible window `[offset, offset + size)` and return
 * the adjusted offset. Shared by every scrollable pane (lists, turns, steps,
 * transcript) so they scroll identically: the cursor never leaves the viewport,
 * and the list only moves once the cursor reaches an edge.
 */
export function scrollOffset(cursor: number, offset: number, size: number): number {
  if (cursor < offset) return cursor;
  if (cursor >= offset + size) return cursor - size + 1;
  return offset;
}

/**
 * Clamp a stored cursor + window offset to a (possibly shrunk) list length, so
 * a stale offset can't slice past the end and render real rows as empty. Used
 * wherever a list reuses cursor/offset state across changing data.
 */
export function clampWindow(
  cursor: number,
  offset: number,
  size: number,
  length: number,
): { cursor: number; offset: number } {
  return {
    cursor: Math.min(cursor, Math.max(0, length - 1)),
    offset: Math.min(offset, Math.max(0, length - size)),
  };
}
