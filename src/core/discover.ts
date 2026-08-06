import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { type ClaudeRoot, claudeRoots, projectsDirOf, qualifyProjectId } from "./claude-roots.ts";
import { decodeProjectLabel, type ProjectRefMatch, resolveProjectRef } from "./project-labels.ts";

export interface ProjectInfo {
  /** Globally unique id: the encoded directory name, root-qualified when the
   *  project lives outside the primary Claude root. */
  id: string;
  /** Best-effort human label (authoritative path comes from session cwd). */
  label: string;
  dir: string;
  /** The Claude data directory this project was discovered under. */
  root: string;
  sessionCount: number;
}

export interface SessionInfo {
  /** Session file basename without extension (usually a uuid). */
  id: string;
  projectId: string;
  path: string;
  /** The Claude data directory this session was discovered under. */
  root: string;
  sizeBytes: number;
  mtimeMs: number;
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
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(project.dir, file);
    const s = await stat(path).catch(() => null);
    if (!s) continue;
    sessions.push({
      id: basename(file, ".jsonl"),
      projectId: project.id,
      path,
      root: project.root,
      sizeBytes: s.size,
      mtimeMs: s.mtimeMs,
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
      return {
        id,
        projectId: project.id,
        path,
        root: project.root,
        sizeBytes: s.size,
        mtimeMs: s.mtimeMs,
      };
    }
  }
  return undefined;
}
