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
