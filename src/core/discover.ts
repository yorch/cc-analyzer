import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import {
  type ClaudeRoot,
  claudeRoots,
  decodeProjectLabel,
  projectIdParts,
  projectsDirOf,
  qualifyProjectId,
  rootSlug,
} from "./paths.ts";

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
export async function scanRoots(): Promise<RootScan[]> {
  const scans: RootScan[] = [];
  for (const root of claudeRoots()) {
    scans.push({ root, readable: await isDir(projectsDirOf(root.path)) });
  }
  return scans;
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
export async function listProjects(): Promise<ProjectInfo[]> {
  const projects: ProjectInfo[] = [];
  for (const root of claudeRoots()) {
    projects.push(...(await listProjectsIn(root)));
  }
  projects.sort((a, b) => b.sessionCount - a.sessionCount);
  return projects;
}

/**
 * Resolve a (possibly root-qualified) project id back to its directory.
 *
 * The slug identifies the root, so a qualified id keeps working even as roots
 * are added; an unqualified id belongs to the primary root.
 */
function locateProject(projectId: string): { dir: string; root: string } | undefined {
  const { slug, dirName } = projectIdParts(projectId);
  const roots = claudeRoots();
  const root = slug === null ? roots[0] : roots.find((r) => rootSlug(r.path) === slug);
  if (!root) return undefined;
  return { dir: join(projectsDirOf(root.path), dirName), root: root.path };
}

/** List session files within a project. */
export async function listSessions(projectId: string): Promise<SessionInfo[]> {
  const located = locateProject(projectId);
  if (!located) return [];

  let files: string[];
  try {
    files = await readdir(located.dir);
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(located.dir, file);
    const s = await stat(path).catch(() => null);
    if (!s) continue;
    sessions.push({
      id: basename(file, ".jsonl"),
      projectId,
      path,
      root: located.root,
      sizeBytes: s.size,
      mtimeMs: s.mtimeMs,
    });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

/** All session files across every project of every configured root. */
export async function listAllSessions(): Promise<SessionInfo[]> {
  const projects = await listProjects();
  const all: SessionInfo[] = [];
  for (const project of projects) {
    all.push(...(await listSessions(project.id)));
  }
  return all;
}

/** Find a session by its id (basename) across every project of every root. */
export async function findSessionById(id: string): Promise<SessionInfo | undefined> {
  const projects = await listProjects();
  for (const project of projects) {
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
