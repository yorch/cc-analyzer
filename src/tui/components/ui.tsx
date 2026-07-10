import { Box, Text, useInput } from "ink";

/** A consistent screen title with an optional dimmed subtitle line. */
export function ScreenHeader({ title, subtitle }: { title: string; subtitle?: string }) {
  return (
    <Box flexDirection="column">
      <Text bold color="cyan">
        {title}
      </Text>
      {subtitle !== undefined && (
        <Box marginBottom={1}>
          <Text dimColor>{subtitle}</Text>
        </Box>
      )}
    </Box>
  );
}

/** A consistent bottom hint bar; `? help` is appended automatically. */
export function Footer({ hints }: { hints: string }) {
  return (
    <Box marginTop={1}>
      <Text dimColor>
        {hints} · <Text color="cyan">?</Text> help · ctrl-c quit
      </Text>
    </Box>
  );
}

/** A consistent loading line. */
export function Loading({ label }: { label: string }) {
  return <Text dimColor>{label}…</Text>;
}

/** A consistent empty-state line. */
export function Empty({ label }: { label: string }) {
  return <Text dimColor>{label}</Text>;
}

const HELP_SECTIONS: { title: string; keys: [string, string][] }[] = [
  {
    title: "Global",
    keys: [
      ["?", "toggle this help"],
      ["esc", "back / up a screen"],
      ["ctrl-c", "quit"],
    ],
  },
  {
    title: "Dashboard",
    keys: [
      ["1-4 / tab", "switch panel"],
      ["↑/↓ · enter", "move · open (projects/sessions)"],
      ["p", "all projects"],
      ["/", "search all sessions"],
    ],
  },
  {
    title: "Lists (projects / sessions / search)",
    keys: [
      ["type", "filter"],
      ["tab / shift-tab", "cycle sort / flip direction"],
      ["↑/↓ · enter", "move · open"],
    ],
  },
  {
    title: "Session detail",
    keys: [
      ["1-3 / tab", "summary / turns / transcript"],
      ["↑/↓ · enter", "move · expand row"],
      ["g / G", "jump to top / bottom"],
    ],
  },
];

/** A modal keybinding cheatsheet; any key closes it. */
export function HelpOverlay({ isActive, onClose }: { isActive: boolean; onClose: () => void }) {
  useInput(() => onClose(), { isActive });
  return (
    <Box flexDirection="column" borderStyle="round" borderColor="cyan" padding={1}>
      <Text bold color="cyan">
        Keybindings
      </Text>
      {HELP_SECTIONS.map((s) => (
        <Box key={s.title} flexDirection="column" marginTop={1}>
          <Text bold>{s.title}</Text>
          {s.keys.map(([k, desc]) => (
            <Text key={k}>
              <Text color="cyan">{k.padEnd(16)}</Text>
              <Text dimColor>{desc}</Text>
            </Text>
          ))}
        </Box>
      ))}
      <Box marginTop={1}>
        <Text dimColor>press any key to close</Text>
      </Box>
    </Box>
  );
}
