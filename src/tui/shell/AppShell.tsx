import { Box, Text } from "ink";
import type { ReactNode } from "react";
import { VERSION } from "../../core/version.ts";
import { palette } from "../theme.ts";
import { type LayoutMode, layoutMode } from "../useTermSize.ts";

export interface NavEntry {
  key: string;
  label: string;
  icon: string;
  /** Placeholder entries render dimmed and are not yet wired to a view. */
  soon?: boolean;
}

interface Props {
  /** Location line, e.g. "portfolio ▸ projects". */
  breadcrumb: string;
  entries: NavEntry[];
  active: string;
  /** Context-specific key hints; `? help · ctrl-c quit` is appended. */
  keyHints: string;
  columns: number;
  /** Whether the nav rail (vs. the body) currently has input focus. */
  railFocused?: boolean;
  /** Optional band under the title bar (e.g. the portfolio lede). */
  lede?: ReactNode;
  children: ReactNode;
}

/** The persistent app chrome: title bar · breadcrumb · nav rail · key bar. */
export function AppShell({
  breadcrumb,
  entries,
  active,
  keyHints,
  columns,
  railFocused = false,
  lede,
  children,
}: Props) {
  const mode = layoutMode(columns);
  return (
    <Box flexDirection="column">
      <TitleBar breadcrumb={breadcrumb} />
      {lede}
      <Box marginTop={1}>
        {mode !== "narrow" && (
          <NavRail entries={entries} active={active} mode={mode} focused={railFocused} />
        )}
        <Box flexDirection="column" flexGrow={1}>
          {children}
        </Box>
      </Box>
      <KeyBar hints={keyHints} />
    </Box>
  );
}

function TitleBar({ breadcrumb }: { breadcrumb: string }) {
  return (
    <Box justifyContent="space-between">
      <Text bold color={palette.amber}>
        ◆ cc-analyzer <Text color={palette.ink3}>v{VERSION}</Text>
      </Text>
      <Text color={palette.ink3}>{breadcrumb}</Text>
    </Box>
  );
}

function NavRail({
  entries,
  active,
  mode,
  focused,
}: {
  entries: NavEntry[];
  active: string;
  mode: LayoutMode;
  focused: boolean;
}) {
  const compact = mode === "compact";
  return (
    <Box
      flexDirection="column"
      flexShrink={0}
      borderStyle="single"
      borderColor={focused ? palette.amber : palette.line}
      borderTop={false}
      borderBottom={false}
      borderLeft={false}
      paddingRight={1}
      marginRight={1}
    >
      {entries.map((e) => {
        const on = e.key === active;
        const fg = on ? palette.bg : e.soon ? palette.ink3 : palette.ink2;
        const marker = on && focused ? "❯" : " ";
        return (
          <Text key={e.key} color={fg} backgroundColor={on ? palette.amber : undefined}>
            {marker} {e.icon}
            {compact ? "" : ` ${e.label}`}
          </Text>
        );
      })}
    </Box>
  );
}

function KeyBar({ hints }: { hints: string }) {
  return (
    <Box marginTop={1}>
      <Text color={palette.ink3}>
        {hints} · <Text color={palette.amberDim}>?</Text> help · ctrl-c quit
      </Text>
    </Box>
  );
}
