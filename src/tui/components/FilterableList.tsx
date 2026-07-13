import { Box, Text, useInput } from "ink";
import { type ReactNode, useEffect, useState } from "react";
import { scrollOffset } from "../scroll.ts";
import { palette, role } from "../theme.ts";
import { usePageSize } from "../usePageSize.ts";
import { Empty, ScrollRange } from "./ui.tsx";

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
  /** Fires with the highlighted item as the cursor/filter moves (live preview). */
  onHighlight?: (item: T | undefined) => void;
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
  pageSize,
  isActive = true,
  sortLabel,
  onCycleSort,
  onReverseSort,
  onHighlight,
}: FilterableListProps<T>) {
  const [query, setQuery] = useState("");
  const [cursor, setCursor] = useState(0);
  const [offset, setOffset] = useState(0);
  const autoSize = usePageSize(9);
  const size = pageSize ?? autoSize;

  const q = query.toLowerCase();
  const filtered = q ? items.filter((i) => filterText(i).toLowerCase().includes(q)) : items;
  const activeCursor = Math.min(cursor, Math.max(0, filtered.length - 1));

  // Report the highlighted item to the parent for a live detail preview.
  const current = filtered[activeCursor];
  // biome-ignore lint/correctness/useExhaustiveDependencies: fire on real position/filter changes, not on onHighlight identity
  useEffect(() => {
    onHighlight?.(current);
  }, [current]);

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
        setOffset(scrollOffset(next, offset, size));
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
      if (input && input !== "?" && !key.ctrl && !key.meta && !key.tab) {
        setQuery((cur) => cur + input);
        reset();
      }
    },
    { isActive },
  );

  const visible = filtered.slice(offset, offset + size);
  return (
    <Box flexDirection="column">
      <Box>
        <Text color={role.accent}>/ </Text>
        {query ? (
          <Text color={role.body}>{query}</Text>
        ) : (
          <Text color={role.muted}>type to filter</Text>
        )}
        <Text color={role.muted}>
          {"  "}
          {filtered.length}/{items.length}
        </Text>
        {sortLabel && (
          <Text color={role.muted}>
            {"  "}· <Text color={palette.amberDim}>{sortLabel}</Text>
          </Text>
        )}
      </Box>
      <Box flexDirection="column" marginTop={1}>
        {visible.length === 0 ? (
          <Empty label="(no matches)" />
        ) : (
          visible.map((item, i) => {
            const realIndex = offset + i;
            return (
              <Box key={realIndex}>{renderItem(item, realIndex === activeCursor && isActive)}</Box>
            );
          })
        )}
      </Box>
      <ScrollRange offset={offset} size={size} total={filtered.length} />
    </Box>
  );
}
