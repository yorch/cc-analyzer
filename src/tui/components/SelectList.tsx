import { Box, Text, useInput } from "ink";
import { type ReactNode, useState } from "react";

export interface SelectListProps<T> {
  items: T[];
  /** Render one row; `selected` is true for the highlighted row. */
  renderItem: (item: T, selected: boolean) => ReactNode;
  onSelect: (item: T, index: number) => void;
  /** Visible rows before scrolling. */
  pageSize?: number;
  /** Whether this list currently owns keyboard focus. */
  isActive?: boolean;
}

/** A keyboard-navigable, scrolling list (arrows / j-k, enter to select). */
export function SelectList<T>({
  items,
  renderItem,
  onSelect,
  pageSize = 15,
  isActive = true,
}: SelectListProps<T>) {
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);

  useInput(
    (input, key) => {
      if (items.length === 0) return;
      let next = cursor;
      if (key.downArrow || input === "j") next = Math.min(cursor + 1, items.length - 1);
      else if (key.upArrow || input === "k") next = Math.max(cursor - 1, 0);
      else if (input === "g") next = 0;
      else if (input === "G") next = items.length - 1;
      else if (key.return) {
        const item = items[cursor];
        if (item !== undefined) onSelect(item, cursor);
        return;
      } else return;

      setCursor(next);
      if (next < offset) setOffset(next);
      else if (next >= offset + pageSize) setOffset(next - pageSize + 1);
    },
    { isActive },
  );

  if (items.length === 0) return <Text dimColor>(nothing to show)</Text>;

  const visible = items.slice(offset, offset + pageSize);
  return (
    <Box flexDirection="column">
      {visible.map((item, i) => {
        const realIndex = offset + i;
        return <Box key={realIndex}>{renderItem(item, realIndex === cursor && isActive)}</Box>;
      })}
      {items.length > pageSize && (
        <Text dimColor>
          {"  "}
          {cursor + 1}/{items.length}
        </Text>
      )}
    </Box>
  );
}
