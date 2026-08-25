import { Box, Text, useInput } from "ink";
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
      ["1 / 2 / 3 / 4 / 5", "turns / charts / transcript / summary / claude"],
      ["u / c / t / s / a", "turns / charts / transcript / summary / claude"],
      ["→ / tab", "focus steps (turns mode)"],
      ["r / m", "run / switch model (claude mode)"],
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

/** A modal keybinding cheatsheet; any key closes it. */
export function HelpOverlay({ isActive, onClose }: { isActive: boolean; onClose: () => void }) {
  useInput(() => onClose(), { isActive });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor={palette.amber} padding={1}>
      <Text bold color={role.heading}>
        Keybindings
      </Text>
      {HELP_SECTIONS.map((s) => (
        <Box key={s.title} flexDirection="column" marginTop={1}>
          <Text bold color={role.body}>
            {s.title}
          </Text>
          {s.keys.map(([k, desc]) => (
            <Text key={k}>
              <Text color={palette.amberDim}>{k.padEnd(18)}</Text>
              <Text color={role.muted}>{desc}</Text>
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text color={role.muted}>press any key to close</Text>
      </Box>
    </Box>
  );
}
