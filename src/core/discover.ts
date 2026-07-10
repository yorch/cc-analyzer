import { readdir, stat } from "node:fs/promises";
import { basename, join } from "node:path";
import { decodeProjectLabel, projectsDir } from "./paths.ts";

export interface ProjectInfo {
  /** Encoded directory name; the stable id for the project. */
  id: string;
  /** Best-effort human label (authoritative path comes from session cwd). */
  label: string;
  dir: string;
  sessionCount: number;
}

export interface SessionInfo {
  /** Session file basename without extension (usually a uuid). */
  id: string;
  projectId: string;
  path: string;
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

/** List all projects under `~/.claude/projects`, each with a session count. */
export async function listProjects(): Promise<ProjectInfo[]> {
  const root = projectsDir();
  let entries: string[];
  try {
    entries = await readdir(root);
  } catch {
    return [];
  }

  const projects: ProjectInfo[] = [];
  for (const id of entries) {
    const dir = join(root, id);
    if (!(await isDir(dir))) continue;
    const files = await readdir(dir).catch(() => [] as string[]);
    const sessionCount = files.filter((f) => f.endsWith(".jsonl")).length;
    projects.push({ id, label: decodeProjectLabel(id), dir, sessionCount });
  }
  projects.sort((a, b) => b.sessionCount - a.sessionCount);
  return projects;
}

/** List session files within a project. */
export async function listSessions(projectId: string): Promise<SessionInfo[]> {
  const dir = join(projectsDir(), projectId);
  let files: string[];
  try {
    files = await readdir(dir);
  } catch {
    return [];
  }

  const sessions: SessionInfo[] = [];
  for (const file of files) {
    if (!file.endsWith(".jsonl")) continue;
    const path = join(dir, file);
    const s = await stat(path).catch(() => null);
    if (!s) continue;
    sessions.push({
      id: basename(file, ".jsonl"),
      projectId,
      path,
      sizeBytes: s.size,
      mtimeMs: s.mtimeMs,
    });
  }
  sessions.sort((a, b) => b.mtimeMs - a.mtimeMs);
  return sessions;
}

/** All session files across all projects. */
export async function listAllSessions(): Promise<SessionInfo[]> {
  const projects = await listProjects();
  const all: SessionInfo[] = [];
  for (const project of projects) {
    all.push(...(await listSessions(project.id)));
  }
  return all;
}

/** Find a session by its id (basename) across every project. */
export async function findSessionById(id: string): Promise<SessionInfo | undefined> {
  const projects = await listProjects();
  for (const project of projects) {
    const path = join(project.dir, `${id}.jsonl`);
    const s = await stat(path).catch(() => null);
    if (s) {
      return { id, projectId: project.id, path, sizeBytes: s.size, mtimeMs: s.mtimeMs };
    }
  }
  return undefined;
}
