import { Box, Text, useInput } from "ink";
import { type ReactNode, useState } from "react";

export interface FilterableListProps<T> {
  items: T[];
  /** Text used to match an item against the filter query. */
  filterText: (item: T) => string;
  renderItem: (item: T, selected: boolean) => ReactNode;
  onSelect: (item: T) => void;
  /** Called on Escape when the filter is empty (navigate back). */
  onBack: () => void;
  pageSize?: number;
  isActive?: boolean;
  /** Current sort indicator (e.g. "cost ↓"); shown in the header when provided. */
  sortLabel?: string;
  /** Tab cycles the sort field. */
  onCycleSort?: () => void;
  /** Shift-Tab flips the sort direction. */
  onReverseSort?: () => void;
}

/**
 * A scrolling list with an inline substring filter. Printable keys build the
 * query, arrows move, enter selects, backspace edits the query, and Escape
 * clears the query (or calls onBack when it is already empty). Vim j/k are not
 * used for navigation here so those letters can be typed into the filter.
 */
export function FilterableList<T>({
  items,
  filterText,
  renderItem,
  onSelect,
  onBack,
  pageSize = 15,
  isActive = true,
  sortLabel,
  onCycleSort,
  onReverseSort,
}: FilterableListProps<T>) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);

  const q = query.toLowerCase();
  const filtered = q ? items.filter((i) => filterText(i).toLowerCase().includes(q)) : items;
  const activeCursor = Math.min(cursor, Math.max(0, filtered.length - 1));

  const reset = () => {
    setCursor(0);
    setOffset(0);
  };

  useInput(
    (input, key) => {
      if (key.escape) {
        if (query) {
          setQuery("");
          reset();
        } else onBack();
        return;
      }
      if (key.return) {
        const item = filtered[activeCursor];
        if (item !== undefined) onSelect(item);
        return;
      }
      if (key.downArrow || key.upArrow) {
        const next = Math.max(
          0,
          Math.min(activeCursor + (key.downArrow ? 1 : -1), filtered.length - 1),
        );
        setCursor(next);
        if (next < offset) setOffset(next);
        else if (next >= offset + pageSize) setOffset(next - pageSize + 1);
        return;
      }
      if (key.tab) {
        if (key.shift) onReverseSort?.();
        else onCycleSort?.();
        return;
      }
      if (key.backspace || key.delete) {
        setQuery((cur) => cur.slice(0, -1));
        reset();
        return;
      }
      if (input && !key.ctrl && !key.meta && !key.tab) {
        setQuery((cur) => cur + input);
        reset();
      }
    },
    { isActive },
  );

  const visible = filtered.slice(offset, offset + pageSize);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color="cyan">/ </Text>
        {query ? <Text>{query}</Text> : <Text dimColor>type to filter</Text>}
        <Text dimColor>
          {"  "}
          {filtered.length}/{items.length}
        </Text>
        {sortLabel && (
          <Text dimColor>
            {"  "}· sort: <Text color="cyan">{sortLabel}</Text> (tab)
          </Text>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Text dimColor>(no matches)</Text>
        ) : (
          visible.map((item, i) => {
            const realIndex = offset + i;
            return (
              <Box key={realIndex}>{renderItem(item, realIndex === activeCursor && isActive)}</Box>
            );
          })
        )}
      </Box>
    </Box>
  );
}
