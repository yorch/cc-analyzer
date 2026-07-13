import { Box, Text } from "ink";
import {
  formatCount,
  formatRelativeTime,
  formatTokens,
  formatUSD,
  truncate,
} from "../../cli/format.ts";
import type { IndexedProject, IndexedSession, SessionWithProject } from "../../core/queries.ts";
import { type CacheMetrics, cacheVerdict } from "../../core/stats.ts";
import { palette, role, VERDICT_COLOR } from "../theme.ts";

/** A padded `label   value` line, shared by the preview panes. */
function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <Text>
      <Text color={role.muted}>{label.padEnd(12)}</Text>
      {children}
    </Text>
  );
}

function cacheShare(io: number, cache: number): string {
  const total = io + cache;
  if (total === 0) return "—";
  return `${Math.round((cache / total) * 100)}%`;
}

/** Detail-pane summary for a selected project. */
export function ProjectPreview({ project }: { project: IndexedProject | undefined }) {
  if (!project) return <Text color={role.muted}>(no selection)</Text>;
  return (
    <Box flexDirection="column">
      <Text bold color={role.heading}>
        {truncate(project.projectPath ?? project.projectId, 48)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Field label="spend">
          <Text color={role.cost}>{formatUSD(project.cost)}</Text>
        </Field>
        <Field label="sessions">
          <Text color={role.body}>{formatCount(project.sessions)}</Text>
        </Field>
        <Field label="tokens">
          <Text color={role.body}>{formatTokens(project.ioTokens, project.cacheTokens)}</Text>
        </Field>
        <Field label="cache">
          <Text color={palette.green}>{cacheShare(project.ioTokens, project.cacheTokens)}</Text>
          <Text color={role.muted}> of tokens</Text>
        </Field>
        <Field label="last active">
          <Text color={role.body}>{formatRelativeTime(project.lastActivityMs)}</Text>
        </Field>
      </Box>
      <Box marginTop={1}>
        <Text color={role.muted}>↵ browse this project's sessions</Text>
      </Box>
    </Box>
  );
}

/** Detail-pane summary for a selected session. */
export function SessionPreview({
  session,
}: {
  session: IndexedSession | SessionWithProject | undefined;
}) {
  if (!session) return <Text color={role.muted}>(no selection)</Text>;
  const projectPath = "projectPath" in session ? session.projectPath : null;
  return (
    <Box flexDirection="column">
      <Text bold color={role.heading}>
        {truncate(session.title ?? session.sessionId ?? "(untitled)", 48)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        {projectPath ? (
          <Field label="project">
            <Text color={role.body}>{truncate(projectPath, 40)}</Text>
          </Field>
        ) : null}
        <Field label="cost">
          <Text color={role.cost}>{formatUSD(session.cost)}</Text>
          {session.costEstimated ? <Text color={role.muted}> (est)</Text> : null}
        </Field>
        <Field label="tokens">
          <Text color={role.body}>{formatTokens(session.ioTokens, session.cacheTokens)}</Text>
        </Field>
        <Field label="cache">
          <Text color={palette.green}>{cacheShare(session.ioTokens, session.cacheTokens)}</Text>
          <Text color={role.muted}> of tokens</Text>
        </Field>
        <Field label="turns">
          <Text color={role.body}>
            {session.turns} · {session.apiCalls} calls · {session.toolCalls} tools
          </Text>
        </Field>
        {session.startTime ? (
          <Field label="started">
            <Text color={role.body}>{session.startTime.slice(0, 16).replace("T", " ")}</Text>
          </Field>
        ) : null}
        <Field label="modified">
          <Text color={role.body}>{formatRelativeTime(session.mtimeMs)}</Text>
        </Field>
      </Box>
      <Box marginTop={1}>
        <Text color={role.muted}>↵ open full session</Text>
      </Box>
    </Box>
  );
}

/** Detail-pane cache breakdown for a selected project or session. */
export function CachePreview({
  title,
  row,
  hint,
}: {
  title: string;
  row: CacheMetrics | undefined;
  hint: string;
}) {
  if (!row) return <Text color={role.muted}>(no selection)</Text>;
  const verdict = cacheVerdict(row.ratio);
  const pct = (c: number) =>
    row.totalCost > 0 ? `${Math.round((c / row.totalCost) * 100)}%` : "—";
  const money = (label: string, cost: number, extra: string) => (
    <Field label={label}>
      <Text color={role.body}>{formatUSD(cost).padStart(9)}</Text>
      <Text color={role.muted}>
        {"  "}
        {pct(cost).padStart(4)} {extra}
      </Text>
    </Field>
  );
  return (
    <Box flexDirection="column">
      <Text bold color={role.heading}>
        {truncate(title, 48)}
      </Text>
      <Box marginTop={1} flexDirection="column">
        <Field label="verdict">
          <Text color={VERDICT_COLOR[verdict]}>● {verdict}</Text>
          <Text color={role.muted}> · {row.ratio.toFixed(1)}× read:write</Text>
        </Field>
        <Field label="waste">
          <Text color={role.cost}>{formatUSD(row.waste)}</Text>
          <Text color={role.muted}> un-amortized</Text>
        </Field>
        <Box marginTop={1} flexDirection="column">
          {money("cache-write", row.writeCost, `${formatCount(row.writeTokens)} tok`)}
          {money("cache-read", row.readCost, `${formatCount(row.readTokens)} tok`)}
          {money("input", row.inputCost, "")}
          {money("output", row.outputCost, "")}
        </Box>
      </Box>
      <Box marginTop={1}>
        <Text color={role.muted}>{hint}</Text>
      </Box>
    </Box>
  );
}
