import { readdir, stat } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import { type ClaudeRoot, claudeRoots, projectsDirOf, qualifyProjectId } from "./claude-roots.ts";
import type { AgentMeta } from "./events.ts";
import type { SessionTree } from "./parser.ts";
import { decodeProjectLabel, type ProjectRefMatch, resolveProjectRef } from "./project-labels.ts";

export interface ProjectInfo {
  /** Globally unique id: the encoded directory name qualified by its root's
   *  slug (`<rootSlug>~<name>`), uniformly for every root — see
   *  `qualifyProjectId`. Storage identity, not something to show or to expect
   *  a user to type: `projectDisplayName` renders it, `findProject` accepts a
   *  bare name back. */
  id: string;
  /** Best-effort human label (authoritative path comes from session cwd). */
  label: string;
  dir: string;
  /** The Claude data directory this project was discovered under. */
  root: string;
  sessionCount: number;
}

export type { AgentMeta } from "./events.ts";

export interface SessionInfo {
  /** Session file basename without extension (usually a uuid). */
  id: string;
  projectId: string;
  path: string;
  /** The Claude data directory this session was discovered under. */
  root: string;
  /** Size and mtime folded across the parent file *and* its subagent
   * transcripts, so the indexer's (size, mtime) skip notices growth that
   * happened only inside `subagents/`. */
  sizeBytes: number;
  mtimeMs: number;
  /** This session's `<id>/subagents/*.jsonl`, sorted; empty under the older
   * inline-sidechain layout. `sessionTree` turns it into a reader argument. */
  subagentPaths: string[];
  /**
   * Whether `path` still exists on disk.
   *
   * False for an **orphaned** session: the main transcript was deleted (a
   * cleanup, a `rm` of one `.jsonl`) while `<id>/subagents/` was left behind.
   * The subagent spend is real and was previously invisible, so the session is
   * still discovered — `path` remains its identity even though nothing is
   * there to read, which keeps the row key stable if the file ever returns.
   */
  parentExists: boolean;
  /** `agentId` → what its `.meta.json` declared. Absent entries just mean the
   * burst falls back to prompt-matching for its type. */
  agentMeta: Map<string, AgentMeta>;
}

/**
 * The reader's view of a session's files. The single place that decides which
 * file is the parent, so every consumer feeds `streamSessionTree` /
 * `parseSessionTree` the same thing.
 *
 * An orphaned session contributes no `parent`: its main transcript is gone and
 * only the subagent work survives.
 */
export function sessionTree(
  info: Pick<SessionInfo, "path" | "subagentPaths" | "parentExists">,
): SessionTree {
  return {
    ...(info.parentExists ? { parent: info.path } : {}),
    subagents: info.subagentPaths,
  };
}

/** Everything the readers and the analyzer need to process one session. */
export type SessionSource = Pick<
  SessionInfo,
  "path" | "subagentPaths" | "agentMeta" | "parentExists"
>;

/**
 * Build a `SessionSource` for a session known only by its file path — the CLI
 * accepts a bare `.jsonl` path, and the web API resolves an id to one. The
 * subagent directory sits beside the file, named for the session id, so it is
 * derivable without re-walking the project.
 */
export async function sessionSourceAt(path: string): Promise<SessionSource> {
  const sub = await readSubagents(join(dirname(path), basename(path, ".jsonl")));
  // Probed rather than assumed: the caller may be pointing at an orphan whose
  // parent is gone, and reading that tree should yield the surviving subagent
  // work instead of throwing on the missing file.
  const parentExists = await Bun.file(path)
    .exists()
    .catch(() => false);
  return { path, subagentPaths: sub.paths, agentMeta: sub.meta, parentExists };
}

/** The `agentId` a subagent transcript's filename encodes. */
function agentIdOf(file: string): string {
  return basename(file, ".jsonl").replace(/^agent-/, "");
}

/**
 * A session's subagent transcripts and their declared metadata.
 *
 * Claude Code keeps these in `<projectDir>/<sessionId>/subagents/`. Everything
 * here is best-effort and never throws: this is user-adjacent data whose shape
 * moves between Claude Code releases, so a missing directory, an unreadable
 * file, or malformed JSON shrinks the result rather than failing the scan — the
 * same posture `inventory.ts` takes toward config.
 */
async function readSubagents(
  sessionDir: string,
): Promise<{ paths: string[]; meta: Map<string, AgentMeta>; sizeBytes: number; mtimeMs: number }> {
  const empty = { paths: [], meta: new Map<string, AgentMeta>(), sizeBytes: 0, mtimeMs: 0 };
  const dir = join(sessionDir, "subagents");
  const files = await readdir(dir).catch(() => null);
  if (!files) return empty;

  const paths: string[] = [];
  const meta = new Map<string, AgentMeta>();
  let sizeBytes = 0;
  let mtimeMs = 0;

  for (const file of files.slice().sort()) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(dir, file);
    const s = await stat(path).catch(() => null);
    if (!s) continue;
    paths.push(path);
    sizeBytes += s.size;
    mtimeMs = Math.max(mtimeMs, s.mtimeMs);

    const raw = await Bun.file(join(dir, `${basename(file, ".jsonl")}.meta.json`))
      .json()
      .catch(() => null);
    if (raw && typeof raw === "object") {
      const { agentType, spawnDepth } = raw as Record<string, unknown>;
      meta.set(agentIdOf(file), {
        agentType: typeof agentType === "string" ? agentType : undefined,
        spawnDepth: typeof spawnDepth === "number" ? spawnDepth : undefined,
      });
    }
  }
  return { paths, meta, sizeBytes, mtimeMs };
}

async function isDir(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory();
  } catch {
    return false;
  }
}

/**
 * Whether a directory can actually be *listed*.
 *
 * Deliberately `readdir`, not `stat`: discovery enumerates with `readdir` and
 * swallows its errors, so a directory that stats fine but cannot be read (lost
 * permissions, a half-mounted volume) would otherwise look "configured and
 * empty" — and the indexer would prune every one of its rows, which is exactly
 * the data loss the readable/unreadable split exists to prevent. Probing with
 * the same call discovery makes keeps the two answers in agreement.
 */
async function canList(path: string): Promise<boolean> {
  try {
    await readdir(path);
    return true;
  } catch {
    return false;
  }
}

export interface RootScan {
  root: ClaudeRoot;
  /** Whether the root's `projects/` directory could be read this scan. */
  readable: boolean;
}

/**
 * Which configured roots are actually readable right now.
 *
 * A root can be legitimately absent for a moment — an unmounted volume, a synced
 * folder mid-setup — and callers that prune stale state need to tell that apart
 * from "the user removed this root", which is what makes deletion correct.
 */
export async function scanRoots(roots: ClaudeRoot[] = claudeRoots()): Promise<RootScan[]> {
  return await Promise.all(
    roots.map(async (root) => ({ root, readable: await canList(projectsDirOf(root.path)) })),
  );
}

/**
 * The rule deciding whether an indexed row survives a scan that no longer sees
 * its file, shared so `reindex()` and `inspectIndexStatus()` cannot disagree
 * about what `index --check` is counting.
 *
 * A row is retained when its root is configured but was unreadable this scan;
 * anything else (file deleted, or the root de-configured) is a real deletion.
 */
export function retainsMissingRows(scans: RootScan[]): (claudeDir: string) => boolean {
  const unreadable = new Set(scans.filter((s) => !s.readable).map((s) => s.root.path));
  return (claudeDir) => unreadable.has(claudeDir);
}

/** Projects under one root's `projects/` directory. */
async function listProjectsIn(root: ClaudeRoot): Promise<ProjectInfo[]> {
  const dirPath = projectsDirOf(root.path);
  let entries: string[];
  try {
    entries = await readdir(dirPath);
  } catch {
    return [];
  }

  const projects: ProjectInfo[] = [];
  for (const name of entries) {
    const dir = join(dirPath, name);
    if (!(await isDir(dir))) continue;
    const files = await readdir(dir).catch(() => [] as string[]);
    const sessionCount = files.filter((f) => f.endsWith(".jsonl")).length;
    projects.push({
      id: qualifyProjectId(root, name),
      label: decodeProjectLabel(name),
      dir,
      root: root.path,
      sessionCount,
    });
  }
  return projects;
}

/** Projects of every root, undeduplicated (one entry per root's directory). */
async function listProjectsRaw(roots: ClaudeRoot[]): Promise<ProjectInfo[]> {
  const perRoot = await Promise.all(roots.map(listProjectsIn));
  return perRoot.flat();
}

/**
 * List all projects across every configured Claude root, each with a session count.
 *
 * With archive roots configured the counts are those of the sessions the
 * portfolio actually shows (see `dedupeSessions`): a copy dropped as redundant
 * is not counted in its project, live or archived, and an archive project with
 * no surviving session is left out. Redundancy is provable containment, so when
 * a backup diverged from (or outgrew) its live session both copies survive and
 * both projects count the session, exactly as the index holds two rows for it.
 */
export async function listProjects(roots: ClaudeRoot[] = claudeRoots()): Promise<ProjectInfo[]> {
  const projects = await listProjectsRaw(roots);
  if (!roots.some((r) => r.source === "archive")) {
    return projects.sort((a, b) => b.sessionCount - a.sessionCount);
  }
  const kept = (await sessionsOf(projects, roots)).sessions;
  const survivors = new Map<string, number>();
  const anySurvivor = new Set<string>();
  for (const s of kept) {
    anySurvivor.add(s.projectId);
    if (s.parentExists) survivors.set(s.projectId, (survivors.get(s.projectId) ?? 0) + 1);
  }
  const bySource = new Map(roots.map((r) => [r.path, r.source]));
  return (
    projects
      .map((p) => ({ ...p, sessionCount: survivors.get(p.id) ?? 0 }))
      // Keep an archive project while ANY session survives, orphans included: an
      // orphan-only project still has an indexed row and must stay reachable.
      .filter((p) => bySource.get(p.root) !== "archive" || anySurvivor.has(p.id))
      .sort((a, b) => b.sessionCount - a.sessionCount)
  );
}

/** Session files in an already-located project directory. */
export async function listSessionsIn(project: {
  id: string;
  dir: string;
  root: string;
}): Promise<SessionInfo[]> {
  let files: string[];
  try {
    files = await readdir(project.dir);
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  const seen = new Set<string>();
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(project.dir, file);
    const s = await stat(path).catch(() => null);
    if (!s) continue;
    const id = basename(file, ".jsonl");
    seen.add(id);
    const sub = await readSubagents(join(project.dir, id));
    sessions.push({
      id,
      projectId: project.id,
      path,
      root: project.root,
      sizeBytes: s.size + sub.sizeBytes,
      mtimeMs: Math.max(s.mtimeMs, sub.mtimeMs),
      subagentPaths: sub.paths,
      agentMeta: sub.meta,
      parentExists: true,
    });
  }

  // Orphans: a `<id>/subagents/` directory whose `<id>.jsonl` is gone. Deleting
  // one session file does not remove the subagent transcripts beside it, and
  // that leftover work is real spend — invisible until it is enumerated here,
  // because the loop above can only find sessions that still have a parent.
  for (const name of files) {
    if (seen.has(name)) continue;
    const dir = join(project.dir, name);
    if (!(await isDir(dir))) continue;
    const sub = await readSubagents(dir);
    if (sub.paths.length === 0) continue;
    sessions.push({
      id: name,
      projectId: project.id,
      // The absent parent, not one of the surviving files: this is the row's
      // identity, and keeping it stable means a restored `.jsonl` re-attaches
      // to the same row instead of forking a second one.
      path: join(project.dir, `${name}.jsonl`),
      root: project.root,
      sizeBytes: sub.sizeBytes,
      mtimeMs: sub.mtimeMs,
      subagentPaths: sub.paths,
      agentMeta: sub.meta,
      parentExists: false,
    });
  }

  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

/** A resolved project reference, or why it could not be resolved. */
export type ProjectLookup =
  | { status: "found"; project: ProjectInfo }
  | { status: "ambiguous"; candidates: ProjectInfo[] }
  | { status: "unknown" };

/**
 * Resolve what a user typed to exactly one project.
 *
 * Stored ids are always root-qualified, but nobody should have to type a hash:
 * a bare encoded name resolves when only one root holds that project, and is
 * reported as ambiguous — never silently picked — when several do. This is the
 * lenient half that makes uniform qualification liveable, and it is also what
 * keeps a bookmark or script written against an older unqualified id working.
 */
export async function findProject(
  ref: string,
  roots: ClaudeRoot[] = claudeRoots(),
): Promise<ProjectLookup> {
  const projects = await listProjects(roots);
  const match: ProjectRefMatch = resolveProjectRef(
    ref,
    projects.map((p) => p.id),
  );
  if (match.status === "unknown") return { status: "unknown" };
  if (match.status === "ambiguous") {
    const byId = new Map(projects.map((p) => [p.id, p]));
    return {
      status: "ambiguous",
      candidates: match.candidates.map((id) => byId.get(id)).filter((p): p is ProjectInfo => !!p),
    };
  }
  const project = projects.find((p) => p.id === match.id);
  return project ? { status: "found", project } : { status: "unknown" };
}

/**
 * List session files within a project, by id or bare name.
 *
 * An unresolvable or ambiguous reference yields no sessions; callers that want
 * to explain *why* (the CLI does) should use `findProject` directly.
 */
export async function listSessions(
  projectId: string,
  roots: ClaudeRoot[] = claudeRoots(),
): Promise<SessionInfo[]> {
  const found = await findProject(projectId, roots);
  if (found.status !== "found") return [];
  if (!roots.some((r) => r.source === "archive")) return await listSessionsIn(found.project);
  // Same dedupe `projects` counts with: a dropped copy is not part of the portfolio.
  const id = found.project.id;
  return (await scanSessions(roots)).sessions.filter((s) => s.projectId === id);
}

export interface DedupedSessions {
  /** The sessions to show, in their original order. */
  sessions: SessionInfo[];
  /** Dropped session path → the paths of the copies that shadow it. */
  shadowed: Map<string, string[]>;
}

/** Dedupe key: the same encoded project directory name and session id. */
const sessionKey = (s: SessionInfo): string => `${basename(dirname(s.path))}\0${s.id}`;
/** The same key for an indexed row, which only stores the session's path. */
export const sessionRowKey = (path: string): string =>
  `${basename(dirname(path))}\0${basename(path, ".jsonl")}`;

/** How much of a file's end is compared when deciding whether it is a prefix of another. */
export const TAIL_WINDOW_BYTES = 64 * 1024;

async function readWindow(path: string, start: number, length: number): Promise<Uint8Array> {
  return new Uint8Array(
    await Bun.file(path)
      .slice(start, start + length)
      .arrayBuffer(),
  );
}

/**
 * Whether everything in file `loser` is already in file `winner`: the winner is
 * at least as large and holds the same bytes at the loser's last
 * `min(size, TAIL_WINDOW_BYTES)` offsets. Transcripts are append-only, so a
 * true prefix has an identical tail window at the same offsets. A FORK is
 * always detected, however early it happened: it changes every byte after the
 * fork point, including the shorter copy's tail (the callers' copies diverge
 * from their common prefix onward). What the check cannot see is an EQUAL-LENGTH
 * in-place edit located entirely BEFORE the tail window (e.g. a different
 * 4-byte head with an identical 70 KiB tail reads as covered); append-only
 * transcripts do not do that. Only windows are read, never whole files. An
 * empty loser is contained in anything that can be read; any I/O error answers
 * `false` (never drop on doubt).
 */
export async function fileCoveredBy(loser: string, winner: string): Promise<boolean> {
  try {
    const [l, w] = await Promise.all([stat(loser), stat(winner)]);
    if (!w.isFile() || !l.isFile()) return false;
    if (l.size === 0) return true;
    if (w.size < l.size) return false;
    const length = Math.min(l.size, TAIL_WINDOW_BYTES);
    const start = l.size - length;
    const [a, b] = await Promise.all([
      readWindow(loser, start, length),
      readWindow(winner, start, length),
    ]);
    return a.length === length && b.length === length && Buffer.compare(a, b) === 0;
  } catch {
    return false;
  }
}

/**
 * Whether session copy `loser` is provably contained in `winner`: every file of
 * the loser (its parent transcript when it has one, each subagent transcript
 * matched by BASENAME) exists in the winner and is covered by it
 * (`fileCoveredBy`). A loser orphan has no parent file to find, so it only needs
 * its subagent files covered; a winner holding a parent the loser lacks does
 * not prevent redundancy.
 */
export async function isRedundant(loser: SessionInfo, winner: SessionInfo): Promise<boolean> {
  const pairs: [string, string][] = [];
  if (loser.parentExists) {
    if (!winner.parentExists) return false;
    pairs.push([loser.path, winner.path]);
  }
  const winnerSubs = new Map(winner.subagentPaths.map((p) => [basename(p), p]));
  for (const sub of loser.subagentPaths) {
    const match = winnerSubs.get(basename(sub));
    if (!match) return false;
    pairs.push([sub, match]);
  }
  for (const [l, w] of pairs) if (!(await fileCoveredBy(l, w))) return false;
  return true;
}

/** Decides whether `loser` is contained in `winner` (injectable so the rule is unit-testable). */
export type CoversFn = (loser: SessionInfo, winner: SessionInfo) => Promise<boolean>;

/**
 * Collapse copies of one session to the copies the portfolio should show.
 *
 * A session is identified by `(encoded project directory name, session id)`:
 * Claude Code session ids are UUIDs and the directory name is a deterministic
 * encoding of the cwd, so the pair names one session no matter which machine
 * or archive holds a copy. Nothing here needs to know which machine is "this
 * computer", so an identity mistake cannot hide a session.
 *
 * THE RULE: a copy is dropped only when it is provably redundant, i.e. its
 * content is contained in another copy (`isRedundant`). Transcripts are
 * append-only, so a true prefix (a backup of an older state, a truncated live
 * file, an emptied one) is contained in the longer copy, while a copy that
 * DIVERGED (two computers continued one session) or that keeps a subagent file
 * the other lost holds calls the other lacks. Those are all kept: hiding a copy
 * silently loses real API calls, whereas keeping both only repeats the shared
 * base, and the `usage_keys` ledger at index time single-counts every API call.
 * Cost is therefore never double-counted by a kept copy; activity metrics such
 * as turns and steps can repeat the shared base across the kept rows. The ledger
 * can briefly UNDER-count (a call is counted by nobody) while a file that holds
 * claims is unreadable or has just shed content; the next run re-analyzes the
 * session's other copies (`reanalyze_keys`) and `index --check` reports it
 * meanwhile. So when in doubt, keep.
 *
 * Copies are examined least-preferred first, each against the copies still
 * standing, so identical copies collapse onto the preferred one and a truncated
 * copy is dropped in favor of the complete one. Preference: (1) parent
 * transcript present, (2) live (non-archive) over archive, (3) larger
 * `sizeBytes`, (4) newer `mtimeMs`, (5) smaller root path (it embeds the
 * machine id), so the choice is deterministic. Two NON-archive copies of one
 * session are never dropped against each other (continuation or copied files:
 * the ledger already handles them).
 *
 * `retainedLive` holds keys of live rows kept because their root is unreadable
 * right now: they count as live copies that cannot be inspected, so every
 * archived copy of the key stays hidden instead of doubling the session while
 * the root is away.
 *
 * Only key groups with an archive copy and at least two copies do any I/O: a
 * few bounded window reads per file (`TAIL_WINDOW_BYTES`).
 */
export async function dedupeSessions(
  sessions: SessionInfo[],
  roots: ClaudeRoot[],
  retainedLive: ReadonlySet<string> = new Set(),
  covers: CoversFn = isRedundant,
): Promise<DedupedSessions> {
  const archiveRoots = new Set(roots.filter((r) => r.source === "archive").map((r) => r.path));
  if (archiveRoots.size === 0) return { sessions, shadowed: new Map() };
  const groups = new Map<string, SessionInfo[]>();
  for (const s of sessions) {
    const key = sessionKey(s);
    const group = groups.get(key);
    if (group) group.push(s);
    else groups.set(key, [s]);
  }
  const isLive = (s: SessionInfo) => !archiveRoots.has(s.root);
  const prefer = (a: SessionInfo, b: SessionInfo): number =>
    Number(b.parentExists) - Number(a.parentExists) ||
    Number(isLive(b)) - Number(isLive(a)) ||
    b.sizeBytes - a.sizeBytes ||
    b.mtimeMs - a.mtimeMs ||
    (a.root < b.root ? -1 : a.root > b.root ? 1 : 0);
  const keep = new Set<SessionInfo>();
  const shadowed = new Map<string, string[]>();
  for (const [key, group] of groups) {
    let standing: SessionInfo[];
    if (!group.some((s) => !isLive(s))) {
      standing = group;
    } else if (retainedLive.has(key)) {
      standing = group.filter(isLive);
    } else {
      standing = [...group].sort(prefer);
      for (const copy of [...standing].reverse()) {
        for (const other of standing) {
          if (other === copy || (isLive(copy) && isLive(other))) continue;
          if (await covers(copy, other)) {
            standing = standing.filter((s) => s !== copy);
            break;
          }
        }
      }
    }
    for (const s of standing) keep.add(s);
    const winners = group.filter((s) => keep.has(s)).map((s) => s.path);
    for (const s of group) if (!keep.has(s)) shadowed.set(s.path, winners);
  }
  return { sessions: sessions.filter((s) => keep.has(s)), shadowed };
}

/** A row of the sessions table as far as session planning needs it. */
export interface IndexedSessionRef {
  claude_dir: string;
}

export interface SessionPlan extends DedupedSessions {
  /**
   * Surviving files that must be re-analyzed even though their (size, mtime)
   * are unchanged: a row about to be pruned shares their session key, or their
   * key is owed from an earlier run (`debtKeys`, the `reanalyze_keys` table). The
   * cross-file usage ledger may have handed that row the calls both copies
   * carry, so the survivor's unchanged row holds fewer calls than it should
   * (or $0) and nothing else would ever revisit it. This covers a shadowed copy
   * that still has a row, a live file deleted under its archived copy, and a
   * root de-configured under a survivor alike.
   */
  reingest: Set<string>;
  /** Indexed paths this run deletes (absent from the scan and not retained). */
  pruned: Set<string>;
}

/**
 * The one planning seam `reindex()` and `inspectIndexStatus()` share, so
 * `index --check` predicts exactly what `index` does. `existing` maps indexed
 * path → row; `retained` is `retainsMissingRows`' predicate.
 *
 * Rows retained because their (non-archive) root is unreadable count as live
 * copies when deduping, so an unmounted or unlistable live root does not make
 * its own archived backups win and double the sessions.
 */
export async function planSessions(
  roots: ClaudeRoot[],
  existing: Map<string, IndexedSessionRef>,
  retained: (claudeDir: string) => boolean,
  debtKeys: ReadonlySet<string> = new Set(),
): Promise<SessionPlan> {
  const archiveRoots = new Set(roots.filter((r) => r.source === "archive").map((r) => r.path));
  const retainedLive = new Set<string>();
  for (const [path, row] of existing) {
    if (retained(row.claude_dir) && !archiveRoots.has(row.claude_dir)) {
      retainedLive.add(sessionRowKey(path));
    }
  }
  const deduped = await sessionsOf(await listProjectsRaw(roots), roots, retainedLive);
  const current = new Set(deduped.sessions.map((s) => s.path));
  const pruned = new Set<string>();
  const prunedKeys = new Set<string>();
  for (const [path, row] of existing) {
    if (current.has(path) || retained(row.claude_dir)) continue;
    pruned.add(path);
    prunedKeys.add(sessionRowKey(path));
  }
  const reingest = new Set<string>();
  for (const s of deduped.sessions) {
    const key = sessionKey(s);
    if (prunedKeys.has(key) || debtKeys.has(key)) reingest.add(s.path);
  }
  return { ...deduped, reingest, pruned };
}

async function sessionsOf(
  projects: ProjectInfo[],
  roots: ClaudeRoot[],
  retainedLive?: ReadonlySet<string>,
): Promise<DedupedSessions> {
  // Each project is an independent directory walk; the id-based `listSessions`
  // would re-resolve the root per project, so go straight to the located dir.
  const perProject = await Promise.all(projects.map(listSessionsIn));
  return await dedupeSessions(perProject.flat(), roots, retainedLive);
}

/**
 * All session files across every project of every configured root, with
 * archived copies of a session already present elsewhere removed (see
 * `dedupeSessions`). This is the one seam the indexer, `index --check`, and
 * the archiver share, so they cannot disagree about which files count.
 */
export async function listAllSessions(roots: ClaudeRoot[] = claudeRoots()): Promise<SessionInfo[]> {
  return (await scanSessions(roots)).sessions;
}

/** `listAllSessions` plus what was shadowed (for callers that heal rows that lose a copy). */
export async function scanSessions(roots: ClaudeRoot[] = claudeRoots()): Promise<DedupedSessions> {
  return await sessionsOf(await listProjectsRaw(roots), roots);
}

/**
 * Find a session by its id (basename) across every project of every root.
 *
 * Resolves through the deduped session list, so an id opens a copy the indexer
 * shows, never one it dropped as redundant. When several copies survive (a
 * diverged backup, a live session whose archive keeps a subagent file the live
 * tree lost), a live copy is preferred over an archived one, then the project
 * holding more files on disk (the raw, un-deduped `sessionCount` of its
 * directory, an arbitrary-but-stable tie-break), then configured root order.
 * Orphans (no parent transcript) are never returned: there is no main chain to open.
 */
export async function findSessionById(
  id: string,
  roots: ClaudeRoot[] = claudeRoots(),
): Promise<SessionInfo | undefined> {
  const projects = await listProjectsRaw(roots);
  const { sessions } = await sessionsOf(projects, roots);
  const archiveRoots = new Set(roots.filter((r) => r.source === "archive").map((r) => r.path));
  const rank = new Map(projects.map((p, i) => [p.id, [p.sessionCount, -i] as const]));
  const order = (s: SessionInfo) => rank.get(s.projectId) ?? [0, 0];
  return sessions
    .filter((s) => s.id === id && s.parentExists)
    .sort(
      (a, b) =>
        Number(archiveRoots.has(a.root)) - Number(archiveRoots.has(b.root)) ||
        order(b)[0] - order(a)[0] ||
        order(b)[1] - order(a)[1],
    )[0];
}
