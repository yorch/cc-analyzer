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

/** List all projects across every configured Claude root, each with a session count. */
export async function listProjects(roots: ClaudeRoot[] = claudeRoots()): Promise<ProjectInfo[]> {
  const perRoot = await Promise.all(roots.map(listProjectsIn));
  return perRoot.flat().sort((a, b) => b.sessionCount - a.sessionCount);
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
  return found.status === "found" ? await listSessionsIn(found.project) : [];
}

/** All session files across every project of every configured root. */
export async function listAllSessions(roots: ClaudeRoot[] = claudeRoots()): Promise<SessionInfo[]> {
  const projects = await listProjects(roots);
  // Each project is an independent directory walk; the id-based `listSessions`
  // would re-resolve the root per project, so go straight to the located dir.
  const perProject = await Promise.all(projects.map(listSessionsIn));
  return perProject.flat();
}

/** Find a session by its id (basename) across every project of every root. */
export async function findSessionById(
  id: string,
  roots: ClaudeRoot[] = claudeRoots(),
): Promise<SessionInfo | undefined> {
  for (const project of await listProjects(roots)) {
    const path = join(project.dir, `${id}.jsonl`);
    const s = await stat(path).catch(() => null);
    if (s) {
      const sub = await readSubagents(join(project.dir, id));
      return {
        id,
        projectId: project.id,
        path,
        root: project.root,
        sizeBytes: s.size + sub.sizeBytes,
        mtimeMs: Math.max(s.mtimeMs, sub.mtimeMs),
        subagentPaths: sub.paths,
        agentMeta: sub.meta,
        parentExists: true,
      };
    }
  }
  return undefined;
}
