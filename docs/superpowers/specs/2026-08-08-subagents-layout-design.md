# Subagent transcript layout: discovery, attribution, and surfacing

Date: 2026-08-08

## Problem

Claude Code moved subagent transcripts out of the parent session file. They now
live in a per-session subdirectory:

```
<claudeRoot>/projects/<project>/<sessionId>/subagents/agent-<agentId>.jsonl
<claudeRoot>/projects/<project>/<sessionId>/subagents/agent-<agentId>.meta.json
```

`listSessionsIn()` (`src/core/discover.ts`) does a single non-recursive `readdir`
and keeps only top-level `.jsonl`, so these files are invisible to cc-analyzer.

Measured on this machine (2026-08-08):

- 5,543 subagent transcripts, 1.2 GB — about 16% of all session data.
- ~89,000 API calls, 6.6 billion cache-read tokens, 321M cache-write tokens.
- For one verified session (`e317521f`, project `claude-skills`): cc-analyzer
  reported $44.90 against `claude /usage`'s $52.24. Folding in its 4 subagent
  files moves cache-write from 1.56M to 1.96M against `/usage`'s 2.0M, and
  cache-read from 49.25M to 51.68M against 54.3M.

Two consequences beyond the cost gap:

1. Every `isSidechain`-derived metric silently reads **zero** for sessions on the
   new layout — the sidechain cost split, `sidechainBursts`, and the subagent
   type list. They are not visibly broken; they report "no subagents".
2. `ParseCoverage` cannot detect this. It counts bad lines in files it reads;
   unread files produce no parse errors. Format drift at the *filesystem* layer
   has no counter.

### Not in scope

`/usage` also reports haiku background usage (session titling, web search) that
carries **no `usage` field** in the transcript — the 63 `ai-title` events in the
verified session have only `{aiTitle, sessionId, type}`. That spend exists solely
in Claude Code's internal accounting and is unreachable from the JSONL.
`~/.claude/stats-cache.json` once held it but has been stale since 2026-02-21.
This is a permanent blind spot and the spec does not attempt to close it.

A residual gap also remains after folding in subagents (opus output 190.8K
observed vs 255.9K reported; ~$1.90). Its source is unidentified. It is recorded
here rather than explained away.

## Key enabling facts

Subagent events are directly attributable — no heuristics needed:

- `sessionId` is the **parent** session's id.
- `isSidechain: true` on every event.
- `agentId` matches the filename, giving exact chain identity.
- The sibling `.meta.json` carries `{agentType, spawnDepth}` — authoritative
  subagent type, which today is only inferred by prompt matching.

The two layouts are **mutually exclusive**: across 400 sampled sessions holding a
`subagents/` directory, every one had zero inline sidechain usage. Merging cannot
double-count sessions recorded under the old inline layout.

## Approach

Merge the subagent event streams into the parent's, ordered by timestamp.

Because the events already carry `isSidechain: true` and the parent's
`sessionId`, every existing sidechain metric begins working with no change to the
analyzer's accounting. A timestamp merge (rather than appending files) is what
keeps turn attribution correct: a subagent call must land in the turn that was
open when it happened, or `turnDepths`, `skillTurnCosts`, per-turn cost, and the
session charts all shift onto the last turn.

Rejected alternatives:

- **Append subagent files after the parent.** Simplest, but misattributes every
  subagent call to the final turn.
- **Analyze subagent files separately and add aggregates to the parent row.**
  Leaves the parser untouched but duplicates the accumulator, cannot produce
  bursts or turn attribution, and leaves the detail views wrong.

## Components

### 1. Discovery — `src/core/discover.ts`

`SessionInfo` gains:

- `subagentPaths: string[]` — the session's `subagents/*.jsonl`, sorted.
- `agentMeta: Map<string, AgentMeta>` — `agentId` → `{agentType, spawnDepth}`
  parsed from the sibling `.meta.json` files.

`sizeBytes` and `mtimeMs` become the **fold across parent + subagents**, so a
change to any subagent file re-indexes the parent session. Without this, the
indexer's `(size, mtime)` skip would miss subagent-only growth.

Every read is wrapped: a missing `subagents/` dir, an unreadable file, or
malformed `.meta.json` shrinks the result instead of throwing. This matches
`inventory.ts`'s posture toward user-written files whose shape moves between
Claude Code releases.

### 2. Parsing — `src/core/parser.ts`

Two additions, both built on the existing `parseLineOutcome` and `readLines` so
their behavior cannot drift from the single-file readers:

- `streamSessionTree(paths): AsyncGenerator<SessionEvent, ParseCoverage>` — a
  k-way merge over the per-file streams, ordered by `timestamp`. Events without a
  timestamp keep their file-relative position. Memory stays O(k) — one buffered
  event per file — preserving the constant-memory property the indexer needs.
- `parseSessionTree(paths): Promise<ParseResult>` — the array counterpart for the
  interactive consumers.

`ParseCoverage` sums across all files in the tree, so a corrupt subagent file is
counted and surfaced exactly like a corrupt parent file.

### 3. Events — `src/core/events.ts`

Add `agentId: z.string().optional()` to `baseMeta`. The schemas are
`looseObject`, so the field already survives parsing; this makes it typed and
reachable.

### 4. Analyzer — `src/core/analyze.ts`

- Chain identity prefers `agentId` when present (exact), falling back to today's
  `parentUuid` walk for the inline layout.
- `SidechainBurst` gains `agentId?: string` and `spawnDepth?: number`.
- Naming order becomes: authoritative `agentType` from the meta map → today's
  prompt match → the count-zip fallback → undefined.

The meta map is handed in through `AnalyzeOptions`, **not** read from disk by the
analyzer. `analyze.ts` stays filesystem-free and streaming; discovery owns I/O.

`groupSidechainBursts()` in `chart-series.ts` keeps its shape; it gains the
authoritative type as input rather than new logic.

### 5. Indexer — `src/core/indexer.ts`, `src/core/db.ts`

`SCHEMA_VERSION` 16 → 17, forcing the rebuild that backfills subagent spend
across all history. The incremental path would otherwise leave existing rows
permanently wrong — the same reasoning that drove v9 and v10.

`reindex()` passes the merged stream and the meta map. Subagent calls are claimed
in `usage_keys` like any other call, so cross-file de-duplication is unchanged.

Subagent files are **never** indexed as sessions of their own; they fold into the
parent row.

### 6. Frontends

The four single-file call sites move to the tree reader:

- `src/cli/index.ts:483` and `:545` (`analyze`, `doctor`)
- `src/web/api.ts:374`
- `src/tui/screens/SessionDetailScreen.tsx:78`

Then per-subagent drill-down, off the enriched bursts:

- **Web** — the session view gains a subagent breakdown (type, agentId, calls,
  cost, duration), grouped by type with per-burst detail.
- **TUI** — `SessionDetailScreen`'s existing subagents panel gains the same
  per-burst rows.
- **CLI** — the existing "Subagent bursts" table in `analyze` picks up the exact
  type and `spawnDepth` with no structural change.

`doctor` reads the tree so session health covers subagent files.

## Error handling

Every new filesystem read is wrapped and degrades to an empty result. Specific
cases:

- No `subagents/` dir → `subagentPaths: []`; behavior identical to today.
- Unreadable subagent file → skipped, counted in `ParseCoverage.parseErrors`.
- Malformed `.meta.json` → that agent has no meta; naming falls back to prompt
  matching.
- Subagent file whose `sessionId` disagrees with the parent → still merged (the
  directory is the authority), but `doctor` reports it, consistent with how it
  already treats mixed session ids.

## Testing

A new fixture session directory under `test/fixtures/`: a parent `.jsonl` plus
two subagent transcripts and their `.meta.json`.

Cases:

1. **Merge ordering** — interleaved timestamps come out sorted.
2. **Turn attribution** — a subagent call lands in the turn open at its
   timestamp, not the last turn.
3. **Totals** — session cost and `sidechainCost` include subagent spend; API call
   count is parent + subagents.
4. **Authoritative naming** — `subagentType` comes from `.meta.json` when
   present; prompt matching still applies when it is absent.
5. **No double count** — an inline-sidechain fixture with no `subagents/` dir
   produces byte-identical analysis to today.
6. **Tolerance** — missing dir, unreadable file, and malformed meta each degrade
   without throwing.
7. **Change detection** — touching a subagent file marks the parent for reindex.

## Rollout

Schema v17 triggers a full rebuild on first run after upgrade. On a portfolio of
~9,200 sessions / 6.3 GB plus 1.2 GB of newly-read subagent data this is a
multi-minute operation.

Costs will rise for subagent-heavy sessions — the verified session moves from
$44.90 to roughly $50, and this machine's portfolio total rises by order $3k. The
new numbers are the correct ones. The repository has no CHANGELOG, so this is
disclosed in the PR description and the wiki/site docs rather than in-product.

## Documentation

Per project convention, the same branch updates:

- `AGENTS.md` / `CLAUDE.md` — the discovery and sidechain architecture notes,
  which currently describe subagent data as inline `isSidechain` events.
- `README.md`, `wiki/`, `site/` — wherever session discovery or subagent cost is
  described.
- Command help text where `analyze`/`doctor` behavior changes.
