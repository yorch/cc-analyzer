import { copyFile, mkdir, readdir, realpath, stat } from "node:fs/promises";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ClaudeRoot } from "./claude-roots.ts";
import { listAllSessions, type SessionInfo } from "./discover.ts";
import { getArchiveMachineId, getArchivePath } from "./prefs.ts";

export interface ArchiveResult {
  copied: number;
  unchanged: number;
  committed: boolean;
  roots: string[];
}

async function git(repo: string, args: string[], check = true): Promise<string> {
  const proc = Bun.spawn(["git", ...args], { cwd: repo, stdout: "pipe", stderr: "pipe" });
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ]);
  if (check && code !== 0) throw new Error(stderr.trim() || `git ${args[0]} failed (${code})`);
  return stdout.trim();
}

async function canonicalPath(path: string): Promise<string> {
  const absolute = resolve(path);
  try {
    return await realpath(absolute);
  } catch {
    const parent = dirname(absolute);
    if (parent === absolute) return absolute;
    return join(await canonicalPath(parent), basename(absolute));
  }
}

async function ensureRepository(path: string): Promise<void> {
  await mkdir(path, { recursive: true });
  const inside = await git(path, ["rev-parse", "--is-inside-work-tree"], false);
  if (inside === "true") return;
  const entries = await readdir(path);
  if (entries.length > 0)
    throw new Error(`Archive path is not an empty directory or Git repository: ${path}`);
  await git(path, ["init", "--quiet"]);
}

async function digest(path: string): Promise<string> {
  const hash = new Bun.CryptoHasher("sha256");
  for await (const chunk of Bun.file(path).stream()) hash.update(chunk);
  return hash.digest("hex");
}

async function copyIfChanged(source: string, destination: string): Promise<boolean> {
  const sourceStat = await stat(source);
  const destinationStat = await stat(destination).catch(() => null);
  if (
    destinationStat?.size === sourceStat.size &&
    (await digest(source)) === (await digest(destination))
  ) {
    return false;
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return true;
}

async function copySession(info: SessionInfo, repo: string, machineId: string): Promise<boolean> {
  const projectName = basename(dirname(info.path));
  const sourceRootSlug = info.projectId.slice(0, info.projectId.indexOf("~"));
  const sessionId = basename(info.path, ".jsonl");
  const sessionDir = join(
    repo,
    "machines",
    machineId,
    "roots",
    sourceRootSlug,
    "projects",
    projectName,
  );
  let changed = false;
  if (info.parentExists) {
    changed = (await copyIfChanged(info.path, join(sessionDir, `${sessionId}.jsonl`))) || changed;
  }
  for (const source of info.subagentPaths) {
    const name = basename(source);
    changed =
      (await copyIfChanged(source, join(sessionDir, sessionId, "subagents", name))) || changed;
    const meta = join(dirname(source), `${basename(source, ".jsonl")}.meta.json`);
    if (await Bun.file(meta).exists()) {
      changed =
        (await copyIfChanged(meta, join(sessionDir, sessionId, "subagents", basename(meta)))) ||
        changed;
    }
  }
  return changed;
}

/**
 * Copy discovered raw session trees into a dedicated archive repository and
 * create one local Git commit for the batch. Remote pushes are never performed.
 */
export async function archiveSessions(roots: ClaudeRoot[]): Promise<ArchiveResult> {
  const configuredPath = getArchivePath();
  if (!configuredPath)
    throw new Error("No archive repository configured. Run `cc-analyzer archive set <path>`.");
  const repo = resolve(configuredPath);
  const canonicalRepo = await canonicalPath(repo);
  for (const root of roots) {
    const source = await canonicalPath(root.path);
    if (
      canonicalRepo === source ||
      canonicalRepo.startsWith(`${source}${sep}`) ||
      source.startsWith(`${canonicalRepo}${sep}`)
    ) {
      throw new Error(`Archive repository must not overlap a Claude data directory: ${repo}`);
    }
  }
  await ensureRepository(repo);
  const machineId = getArchiveMachineId();
  const priorStatus = await git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  if (priorStatus) {
    throw new Error(
      "Archive repository has uncommitted changes; commit or restore them before archiving.",
    );
  }
  const sessions = await listAllSessions(roots);
  let copied = 0;
  for (const session of sessions) {
    if (await copySession(session, repo, machineId)) copied++;
  }
  if (copied > 0) await git(repo, ["add", "--force", "machines"]);
  const status = await git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  let committed = false;
  if (status) {
    await git(repo, [
      "-c",
      "user.name=cc-analyzer",
      "-c",
      "user.email=cc-analyzer@localhost",
      "commit",
      "--quiet",
      "-m",
      `Archive ${copied} session${copied === 1 ? "" : "s"}`,
    ]);
    committed = true;
  }
  return {
    copied,
    unchanged: sessions.length - copied,
    committed,
    roots: (await listArchiveRoots(repo)).map((root) => root.path),
  };
}

/** Build stable archive roots in Claude's normal on-disk layout. */
export async function listArchiveRoots(
  repo = getArchivePath(),
  liveRoots: ClaudeRoot[] = [],
): Promise<ClaudeRoot[]> {
  if (!repo) return [];
  const repoStat = await stat(repo).catch(() => null);
  if (!repoStat?.isDirectory()) {
    throw new Error(
      `Configured archive repository is unavailable: ${repo}. Refusing to drop indexed archive rows.`,
    );
  }
  const machinesDir = join(repo, "machines");
  const machines = await readdir(machinesDir).catch(() => []);
  const roots: ClaudeRoot[] = [];
  for (const machine of machines.sort()) {
    const rootsDir = join(machinesDir, machine, "roots");
    const sourceRoots = await readdir(rootsDir).catch(() => []);
    for (const sourceRoot of sourceRoots.sort()) {
      // Prefer this machine's live source while it exists; its archive is a
      // backup copy, not a second session row. If the source disappears, the
      // same archive root becomes visible on the next scan.
      if (machine === getArchiveMachineId() && liveRoots.some((root) => root.slug === sourceRoot)) {
        const live = liveRoots.find((root) => root.slug === sourceRoot);
        const liveProjects = live
          ? await stat(join(live.path, "projects")).catch(() => null)
          : null;
        if (liveProjects?.isDirectory()) continue;
      }
      const path = join(rootsDir, sourceRoot);
      const projects = await stat(join(path, "projects")).catch(() => null);
      if (!projects?.isDirectory()) continue;
      roots.push({ path, slug: `archive-${machine}-${sourceRoot}`, source: "archive" });
    }
  }
  return roots;
}
