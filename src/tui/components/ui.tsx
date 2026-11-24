import { Box, Text, useInput, useStdout } from "ink";
import { useState } from "react";
import { palette, role } from "../theme.ts";

/** A consistent bottom hint bar; `? help` is appended automatically. */
export function Footer({ hints }: { hints: string }) {
  return (
    <Box marginTop={1}>
      <Text color={role.muted}>
        {hints} · <Text color={palette.amberDim}>?</Text> help · ctrl-c quit
      </Text>
    </Box>
  );
}

/** A consistent loading line. */
export function Loading({ label }: { label: string }) {
  return <Text color={role.muted}>{label}…</Text>;
}

/** A consistent empty-state line. */
export function Empty({ label }: { label: string }) {
  return <Text color={role.muted}>{label}</Text>;
}

/** A consistent "showing X–Y / N" indicator; hidden when everything fits. */
export function ScrollRange({
  offset,
  size,
  total,
}: {
  offset: number;
  size: number;
  total: number;
}) {
  if (total <= size) return null;
  return (
    <Text color={role.muted}>
      {offset + 1}–{Math.min(offset + size, total)} / {total}
    </Text>
  );
}

const HELP_SECTIONS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Global",
    keys: [
      ["?", "toggle this help"],
      ["ctrl-c", "quit"],
    ],
  },
  {
    title: "Navigation",
    keys: [
      ["esc", "focus the nav rail (from a list)"],
      ["↑/↓ (in rail)", "switch view"],
      ["1-6 (in rail)", "jump to a view"],
      ["↵ / → (in rail)", "focus the list"],
    ],
  },
  {
    title: "Lists (portfolio / projects / sessions / insights)",
    keys: [
      ["type", "filter"],
      ["tab / shift-tab", "cycle sort / flip direction"],
      ["↑/↓ · j/k", "move · updates the preview"],
      ["↵", "open (drill in)"],
      ["space", "expand (where the row supports it)"],
    ],
  },
  {
    title: "Trends",
    keys: [
      ["tab / 1 / 2 / 3", "burn / heatmap / calendar panel"],
      ["m", "cycle metric"],
      ["g", "cycle granularity (burn)"],
    ],
  },
  {
    title: "Tools",
    keys: [
      ["tab / 1 / 2 / 3", "tools / skills / subagents"],
      ["s", "cycle sort (tools / skills)"],
      ["↑/↓ · j/k", "move · skills: pick one for the adoption detail"],
    ],
  },
  {
    title: "Session detail",
    keys: [
      ["1 / 2 / 3 / 4 / 5 / 6", "turns / charts / transcript / summary / claude / export"],
      ["u / c / t / s / a / e", "turns / charts / transcript / summary / claude / export"],
      ["→ / tab", "focus steps (turns mode)"],
      ["o / O", "cycle turn sort / flip direction (turns mode)"],
      ["r / m", "run / switch model (claude mode)"],
      ["esc (while running)", "cancel the Claude run (leaving the tab cancels it too)"],
      ["f / r / t / w", "format / redact / transcript / write (export mode)"],
      ["↑/↓ · j/k", "move"],
      ["↵ / space", "expand row"],
      ["g / G", "jump to top / bottom"],
    ],
  },
  {
    title: "Session search",
    keys: [
      ["/", "open session by ID or .jsonl path"],
      ["type", "enter ID or path"],
      ["↵", "open session"],
      ["esc", "cancel"],
    ],
  },
  {
    title: "Session charts legend",
    keys: [
      ["▼", "context compaction"],
      ["▲", "flagged turn (interrupted/correction/thrash)"],
      ["braille rows", "the plotted series (context, burn, …)"],
    ],
  },
];

type HelpLine = { kind: "title" | "key" | "gap"; text: string; desc?: string };

/** The cheatsheet flattened to lines so it can be windowed to the terminal height. */
const HELP_LINES: HelpLine[] = HELP_SECTIONS.flatMap((sec, i) => [
  ...(i > 0 ? [{ kind: "gap" as const, text: "" }] : []),
  { kind: "title" as const, text: sec.title },
  ...sec.keys.map(([k, desc]) => ({ kind: "key" as const, text: k, desc })),
]);

/** Frame rows the overlay spends on chrome: border (2) + padding (2) + title (1)
 *  + footer (2) + the App's own padding (2). */
const HELP_CHROME_ROWS = 9;

/**
 * A modal keybinding cheatsheet pinned to the terminal height: it shows a window
 * of the sheet and ↑/↓/PgUp/PgDn scroll it, so a short terminal never overflows
 * the frame. Any other key closes it.
 */
export function HelpOverlay({
  isActive,
  onClose,
  rows,
}: {
  isActive: boolean;
  onClose: () => void;
  /** Terminal height; falls back to the live size. */
  rows?: number;
}) {
  const { stdout } = useStdout();
  const termRows = rows ?? stdout?.rows ?? 24;
  const size = Math.max(3, termRows - HELP_CHROME_ROWS);
  const maxOffset = Math.max(0, HELP_LINES.length - size);
  const [offset, setOffset] = useState(0);
  const at = Math.min(offset, maxOffset);
  useInput(
    (_input, key) => {
      if (key.downArrow) return setOffset(Math.min(maxOffset, at + 1));
      if (key.upArrow) return setOffset(Math.max(0, at - 1));
      if (key.pageDown) return setOffset(Math.min(maxOffset, at + size));
      if (key.pageUp) return setOffset(Math.max(0, at - size));
      onClose();
    },
    { isActive },
  );
  const visible = HELP_LINES.slice(at, at + size);
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.amber} padding={1}>
      <Text bold color={role.heading}>
        Keybindings
      </Text>
      {visible.map((l, i) => {
        const key = `${at + i}`;
        if (l.kind === "gap") return <Text key={key}> </Text>;
        if (l.kind === "title")
          return (
            <Text key={key} bold color={role.body}>
              {l.text}
            </Text>
          );
        return (
          <Text key={key}>
            <Text color={palette.amberDim}>{l.text.padEnd(22)}</Text>
            <Text color={role.muted}>{l.desc}</Text>
          </Text>
        );
      })}
      <Box marginTop={1}>
        <Text color={role.muted}>
          {maxOffset > 0
            ? `↑/↓ PgUp/PgDn scroll (${at + 1}-${at + visible.length}/${HELP_LINES.length}) · `
            : ""}
          any other key closes
        </Text>
      </Box>
    </Box>
  );
}
