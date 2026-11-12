import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import { type ClaudeRoot, claudeRoots } from "./claude-roots.ts";
import { listAllSessions, type SessionInfo } from "./discover.ts";
import {
  ARCHIVE_MACHINE_ID_PATTERN,
  getArchiveMachineLabel,
  getArchivePath,
  readStoredArchiveMachineId,
  setArchiveMachineId,
} from "./prefs.ts";
import {
  normalizeAliasPath,
  PROJECT_ALIASES_FILE,
  readProjectAliases,
  writeProjectAliases,
} from "./project-aliases.ts";

export interface ArchiveResult {
  copied: number;
  unchanged: number;
  committed: boolean;
  roots: string[];
  /** The machine identity this run archived under. */
  machine?: ArchiveMachineResolution;
}

export const MACHINE_FILE = "machine.json";

/** Identity record stored at `machines/<id>/machine.json` inside the archive. */
export interface ArchiveMachine {
  version: 1;
  id: string;
  label: string;
  hostnames: string[];
}

/**
 * One `machines/<id>` directory. `identified` is false when it has no usable
 * `machine.json` (an archive from before identity records, or a damaged file):
 * then `label` is absent and `hostnames` is empty rather than invented.
 */
export interface ArchiveMachineEntry {
  id: string;
  label?: string;
  hostnames: string[];
  identified: boolean;
}

export interface ArchiveMachineResolution {
  id: string;
  /**
   * `local`: the state file holds this computer's id. `unidentified`: it does
   * not, and `id` is a throwaway minted in memory (never persisted).
   */
  source: "local" | "unidentified";
  /** Machines already in the archive, populated when `unidentified` so callers can warn. */
  candidates: ArchiveMachineEntry[];
  /** The single candidate recording this hostname, if exactly one does. A hint, never acted on. */
  suggestion?: ArchiveMachineEntry;
}

/** Raised when archiving would have to guess which archived computer this is. */
export class ArchiveIdentityError extends Error {}

/**
 * Read every `machines/<id>/machine.json`. Tolerant: this is a file humans and
 * merges can touch, so a missing or malformed one is skipped, never thrown.
 */
export async function readArchiveMachines(repo = getArchivePath()): Promise<ArchiveMachine[]> {
  if (!repo) return [];
  const machinesDir = join(resolve(repo), "machines");
  const dirs = await readdir(machinesDir).catch(() => [] as string[]);
  const found: ArchiveMachine[] = [];
  for (const dir of dirs.sort()) {
    const record = await readMachineRecord(machinesDir, dir);
    if (record) found.push(record);
  }
  return found;
}

async function readMachineRecord(machinesDir: string, dir: string): Promise<ArchiveMachine | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(join(machinesDir, dir, MACHINE_FILE), "utf8"));
    if (typeof raw !== "object" || raw === null) return null;
    const rec = raw as Record<string, unknown>;
    if (rec.version !== 1 || typeof rec.id !== "string" || rec.id !== dir) return null;
    if (!ARCHIVE_MACHINE_ID_PATTERN.test(rec.id)) return null;
    const hostnames = Array.isArray(rec.hostnames)
      ? rec.hostnames.filter((h): h is string => typeof h === "string" && h.length > 0)
      : [];
    const label = typeof rec.label === "string" && rec.label.trim() ? rec.label : rec.id;
    return { version: 1, id: rec.id, label, hostnames };
  } catch {
    // Missing or malformed: shrink the list instead of failing.
    return null;
  }
}

/**
 * Every `machines/<id>` directory, identified or not. A directory without a
 * usable `machine.json` (an archive predating identity records) still appears,
 * with no label or hostnames, so it can be shown and offered for adoption.
 * Never throws.
 */
export async function listArchiveMachineEntries(
  repo = getArchivePath(),
): Promise<ArchiveMachineEntry[]> {
  if (!repo) return [];
  const machinesDir = join(resolve(repo), "machines");
  const dirs = await readdir(machinesDir).catch(() => [] as string[]);
  const entries: ArchiveMachineEntry[] = [];
  for (const dir of dirs.filter((d) => ARCHIVE_MACHINE_ID_PATTERN.test(d)).sort()) {
    const record = await readMachineRecord(machinesDir, dir);
    entries.push(
      record
        ? { id: dir, label: record.label, hostnames: record.hostnames, identified: true }
        : { id: dir, hostnames: [], identified: false },
    );
  }
  return entries;
}

/**
 * Archive-aware machine identity. READ-ONLY: it never writes the state file.
 * A valid local id wins (`source: "local"`). Otherwise the id is minted in
 * memory (`source: "unidentified"`), with every archived machine as a
 * `candidate` and, when exactly one records this hostname, a `suggestion`.
 *
 * Not persisting is deliberate, not an oversight. This runs on every read path
 * (`index --check`, TUI, `serve`, `projects`, ...); persisting there made the
 * first reader mint silently, so every later command saw "local" and the
 * warning fired once per machine, ever. An unidentified machine instead
 * re-mints each run: its own archive stays unsuppressed and every surface keeps
 * warning until the user resolves it (`archive machine adopt|keep`). It never
 * auto-adopts either: two computers can share a hostname and a root slug, and
 * a wrong guess suppresses another computer's sessions from the index.
 */
export async function resolveArchiveMachine(
  repo = getArchivePath(),
  host = hostname(),
): Promise<ArchiveMachineResolution> {
  const stored = readStoredArchiveMachineId();
  if (stored) return { id: stored, source: "local", candidates: [] };
  const candidates = repo ? await listArchiveMachineEntries(repo) : [];
  const matches = candidates.filter((m) => m.hostnames.includes(host));
  const [only] = matches;
  return {
    id: randomUUID(),
    source: "unidentified",
    candidates,
    ...(matches.length === 1 && only ? { suggestion: only } : {}),
  };
}

/** The full-id warning/refusal text for an unresolved identity (one line per entry). */
export function describeUnresolvedMachine(machine: ArchiveMachineResolution): string[] {
  if (machine.candidates.length === 0) {
    return [
      "this computer has no recorded identity and the archive repository already has history, " +
        "but no machine directory this tool can adopt.",
      "If the archive is still syncing or checking out, wait and retry. If this computer is new:",
      "  cc-analyzer archive machine keep",
    ];
  }
  const lines = [
    "this computer has no recorded identity and the archive already holds other machines.",
    "If one of them is this computer, adopt its id so its sessions are not counted twice:",
  ];
  for (const m of machine.candidates) {
    // The label defaults to the hostname, so only list hostnames that add
    // something — otherwise the same name prints twice.
    const extra = m.hostnames.filter((h) => h !== m.label);
    const hosts = extra.length > 0 ? `, ${extra.join(" ")}` : "";
    const what = m.identified ? `${m.label}${hosts}` : "unidentified: no machine.json";
    const hint = machine.suggestion?.id === m.id ? "  <- hostname matches this computer" : "";
    lines.push(`  cc-analyzer archive machine adopt ${m.id}   (${what})${hint}`);
  }
  lines.push("If this is a new computer that is none of them: cc-analyzer archive machine keep");
  return lines;
}

/**
 * Warn (via `log`, stderr by default) while this computer's archive identity is
 * unresolved and the archive holds other machines. Fires on EVERY run until
 * the user adopts or keeps an id: the resolver never persists, so nothing
 * silences it by accident. Stderr only, so `--json` consumers are unaffected.
 */
export function warnIfUnresolvedMachine(
  machine: ArchiveMachineResolution | undefined,
  log: (line: string) => void = (line) => console.error(line),
): void {
  if (machine?.source !== "unidentified" || machine.candidates.length === 0) return;
  const [first, ...rest] = describeUnresolvedMachine(machine);
  log(`warning: ${first}`);
  for (const line of rest) log(line);
}

/** Resolve identity and warn when unresolved. For surfaces that read the index without reindexing. */
export async function warnIfUnresolvedArchive(): Promise<void> {
  if (!getArchivePath()) return;
  try {
    warnIfUnresolvedMachine(await resolveArchiveMachine());
  } catch {
    // A warning must never break the surface that carries it.
  }
}

/**
 * Whether the archive repository has any commit. This, not the parsed machine
 * list, decides "genuinely first run": `ensureRepository()` only ever
 * `git init`s an empty directory, so a repository with history belongs to
 * someone, even when `machines/` is absent or unreadable right now (a synced
 * folder mid-download, a sparse checkout).
 */
export async function archiveHasHistory(repo = getArchivePath()): Promise<boolean> {
  if (!repo) return false;
  try {
    const proc = Bun.spawn(["git", "rev-parse", "--verify", "--quiet", "HEAD"], {
      cwd: resolve(repo),
      stdout: "pipe",
      stderr: "pipe",
    });
    return (await proc.exited) === 0;
  } catch {
    return false;
  }
}

export interface KeepOptions {
  /** Keep a fresh id even though an archived machine records this hostname. */
  force?: boolean;
  host?: string;
}

export interface KeepResult extends ArchiveMachineResolution {
  /** The archived machines this choice was made against (they stay in the archive). */
  passedOver: ArchiveMachineEntry[];
}

/**
 * Persist a freshly minted id for a genuinely new computer. No-op when one is
 * already stored. Refuses without `force` when an archived machine records this
 * hostname: that is the suggestion case, where `keep` is most likely a mistake
 * (this computer's own older directory would be double-counted forever).
 */
export async function keepArchiveMachine(
  repo = getArchivePath(),
  options: KeepOptions = {},
): Promise<KeepResult> {
  const resolved = await resolveArchiveMachine(repo);
  if (resolved.source === "local") return { ...resolved, passedOver: [] };
  const host = options.host ?? hostname();
  const matching = resolved.candidates.filter((m) => m.hostnames.includes(host));
  if (!options.force && matching.length > 0) {
    throw new Error(
      `Archived machine ${matching.map((m) => m.id).join(", ")} records this computer's hostname ` +
        `(${host}). Keeping a new id leaves that directory in place and its sessions will be ` +
        "counted twice from now on. If it is this computer, adopt it instead: " +
        `cc-analyzer archive machine adopt ${matching[0]?.id}. Otherwise re-run with --force.`,
    );
  }
  setArchiveMachineId(resolved.id);
  return { id: resolved.id, source: "local", candidates: [], passedOver: resolved.candidates };
}

export interface AdoptOptions {
  /** Claim an id whose recorded hostnames exclude this computer, or that would hide sessions. */
  force?: boolean;
  host?: string;
  /** This computer's live roots, to compare the archive against. Defaults to the configured ones. */
  liveRoots?: ClaudeRoot[];
}

export interface AdoptResult {
  /** Archived sessions that adoption hides and that have no counterpart on this computer. */
  hiddenSessions: number;
}

/**
 * Count archived top-level session files under `machines/<id>` for the root
 * slugs this computer also has live, with no file of the same project/name under
 * the live root. Those are exactly the rows adoption would delete from the index.
 */
async function countHiddenSessions(
  repo: string,
  id: string,
  liveRoots: ClaudeRoot[],
): Promise<number> {
  let hidden = 0;
  for (const live of liveRoots) {
    const liveProjects = join(live.path, "projects");
    if (!(await stat(liveProjects).catch(() => null))?.isDirectory()) continue;
    const archived = join(repo, "machines", id, "roots", live.slug, "projects");
    for (const project of await readdir(archived).catch(() => [] as string[])) {
      const files = await readdir(join(archived, project)).catch(() => [] as string[]);
      for (const file of files) {
        if (!file.endsWith(".jsonl")) continue;
        if (!(await stat(join(liveProjects, project, file)).catch(() => null))) hidden++;
      }
    }
  }
  return hidden;
}

/** Explicitly claim an id that exists in the archive. Throws when it does not. */
export async function adoptArchiveMachine(
  id: string,
  repo = getArchivePath(),
  options: AdoptOptions = {},
): Promise<AdoptResult> {
  if (!repo)
    throw new Error("No archive repository configured. Run `cc-analyzer archive set <path>`.");
  id = id.trim().toLowerCase();
  if (!ARCHIVE_MACHINE_ID_PATTERN.test(id)) throw new Error(`Not a valid machine id: ${id}`);
  const entry = (await listArchiveMachineEntries(repo)).find((m) => m.id === id);
  if (!entry) throw new Error(`No machine with id ${id} exists in the archive.`);
  const host = options.host ?? hostname();
  // Hostnames recorded and none is ours: this is another computer's identity.
  // An unidentified entry (no machine.json) records nothing and stays adoptable.
  if (!options.force && entry.hostnames.length > 0 && !entry.hostnames.includes(host)) {
    throw new Error(
      `Machine ${id} (${entry.label}) records hostnames ${entry.hostnames.join(", ")}, not this ` +
        `computer (${host}). Adopting another live computer's id would hide its sessions. ` +
        "If this computer was renamed, re-run with --force.",
    );
  }
  // Adoption makes `listArchiveRoots` suppress this id's copy of every root
  // slug we also have live. Sessions archived there that we do NOT have are
  // another computer's (same hostname and same ~/.claude path hash the same),
  // and suppressing them deletes their rows. Genuine lost-identity recovery
  // mirrors the live files, so it counts zero.
  const hiddenSessions = await countHiddenSessions(
    resolve(repo),
    id,
    options.liveRoots ?? claudeRoots(),
  );
  if (!options.force && hiddenSessions > 0) {
    throw new Error(
      `Adopting ${id} would hide ${hiddenSessions} archived ` +
        (hiddenSessions === 1
          ? "session that is not present on this computer: it looks like another computer's. "
          : `sessions that are not present on this computer: they look like another computer's. `) +
        "If they really are yours and their sources are gone, re-run with --force.",
    );
  }
  setArchiveMachineId(id);
  return { hiddenSessions };
}

/** Write/refresh this machine's record, unioning hostnames. Returns whether the file changed. */
async function writeMachineRecord(repo: string, id: string, host: string): Promise<boolean> {
  const existing = (await readArchiveMachines(repo)).find((m) => m.id === id);
  // Never add this host to a record that names other hosts only: archiving
  // from here must not launder a --force adoption into a recorded fact, or the
  // adopt guard would accept this id from either host forever after.
  const recorded = existing?.hostnames ?? [];
  const hostnames =
    recorded.length > 0 && !recorded.includes(host) ? recorded : [...new Set([...recorded, host])];
  const record: ArchiveMachine = {
    version: 1,
    id,
    label: getArchiveMachineLabel(),
    hostnames: [...hostnames].sort(),
  };
  const body = `${JSON.stringify(record, null, 2)}\n`;
  const file = join(repo, "machines", id, MACHINE_FILE);
  const current = await readFile(file, "utf8").catch(() => null);
  if (current === body) return false;
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, body);
  return true;
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

/** Streaming byte comparison that stops at the first difference. */
async function sameContents(a: string, b: string): Promise<boolean> {
  const readerA = Bun.file(a).stream().getReader();
  const readerB = Bun.file(b).stream().getReader();
  let bufA: Uint8Array = new Uint8Array(0);
  let bufB: Uint8Array = new Uint8Array(0);
  let doneA = false;
  let doneB = false;
  try {
    for (;;) {
      if (bufA.length === 0 && !doneA) {
        const r = await readerA.read();
        if (r.done) doneA = true;
        else bufA = r.value;
        continue;
      }
      if (bufB.length === 0 && !doneB) {
        const r = await readerB.read();
        if (r.done) doneB = true;
        else bufB = r.value;
        continue;
      }
      if (bufA.length === 0 || bufB.length === 0) return bufA.length === 0 && bufB.length === 0;
      const n = Math.min(bufA.length, bufB.length);
      for (let i = 0; i < n; i++) if (bufA[i] !== bufB[i]) return false;
      bufA = bufA.subarray(n);
      bufB = bufB.subarray(n);
    }
  } finally {
    await Promise.all([readerA.cancel().catch(() => {}), readerB.cancel().catch(() => {})]);
  }
}

async function copyIfChanged(source: string, destination: string): Promise<boolean> {
  const sourceStat = await stat(source);
  const destinationStat = await stat(destination).catch(() => null);
  if (destinationStat?.size === sourceStat.size && (await sameContents(source, destination))) {
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

async function requireCleanRepository(repo: string): Promise<void> {
  const status = await git(repo, ["status", "--porcelain", "--untracked-files=all"]);
  if (status) {
    throw new Error(
      "Archive repository has uncommitted changes; commit or restore them before archiving.",
    );
  }
}

async function commitArchiveFiles(repo: string, paths: string[], message: string): Promise<void> {
  await git(repo, ["add", "--force", ...paths]);
  await git(repo, [
    "-c",
    "user.name=cc-analyzer",
    "-c",
    "user.email=cc-analyzer@localhost",
    "commit",
    "--quiet",
    "-m",
    message,
  ]);
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
  await requireCleanRepository(repo);
  let machine = await resolveArchiveMachine(repo);
  if (machine.source === "unidentified") {
    // Archiving writes raw transcripts into permanent history: never guess.
    // Decided from the repository, not the parsed machine list: a non-UUID or
    // not-yet-materialised `machines/` must not read as "nothing to confuse".
    if (machine.candidates.length > 0 || (await archiveHasHistory(repo))) {
      throw new ArchiveIdentityError(
        `Refusing to archive: ${describeUnresolvedMachine(machine).join("\n")}`,
      );
    }
    // Genuinely first run: nothing in the archive to be confused with.
    setArchiveMachineId(machine.id);
    machine = { id: machine.id, source: "local", candidates: [] };
  }
  const machineId = machine.id;
  const metadataChanged = await writeMachineRecord(repo, machineId, hostname());
  const sessions = await listAllSessions(roots);
  let copied = 0;
  for (const session of sessions) {
    if (await copySession(session, repo, machineId)) copied++;
  }
  let committed = false;
  if (copied > 0 || metadataChanged) {
    await commitArchiveFiles(
      repo,
      ["machines"],
      copied > 0
        ? `Archive ${copied} session${copied === 1 ? "" : "s"}`
        : "Update archive machine metadata",
    );
    committed = true;
  }
  return {
    copied,
    unchanged: sessions.length - copied,
    committed,
    roots: (await listArchiveRoots(repo)).map((root) => root.path),
    machine,
  };
}

/** List aliases stored in the shared archive configuration. */
export async function listProjectAliases(): Promise<[string, string][]> {
  const { byPath } = await readProjectAliases();
  return [...byPath].sort(([a], [b]) => a.localeCompare(b));
}

/** Add/update an alias, or remove one with `alias === undefined`, and commit it locally. */
export async function setProjectAlias(path: string, alias: string | undefined): Promise<boolean> {
  const configuredPath = getArchivePath();
  if (!configuredPath)
    throw new Error("No archive repository configured. Run `cc-analyzer archive set <path>`.");
  const repo = resolve(configuredPath);
  await ensureRepository(repo);
  await requireCleanRepository(repo);
  const key = normalizeAliasPath(path);
  if (!key || !(key.startsWith("/") || /^[A-Za-z]:\//.test(key))) {
    throw new Error("Project path must be an absolute working-directory path.");
  }
  const { byPath } = await readProjectAliases(repo);
  const value = alias?.trim();
  if (alias !== undefined && !value) throw new Error("Project alias must not be empty.");
  if (value) {
    if (byPath.get(key) === value) return false;
    byPath.set(key, value);
  } else {
    if (!byPath.delete(key)) return false;
  }
  await writeProjectAliases(byPath, repo);
  await commitArchiveFiles(
    repo,
    [PROJECT_ALIASES_FILE],
    value ? `Set project alias: ${value}` : "Remove project alias",
  );
  return true;
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
  // Filtered by the SAME pattern `listArchiveMachineEntries` uses. The two must
  // stay in sync: a directory identity cannot see must not be discoverable
  // either, or it becomes a second set of session rows that no surface warns
  // about (identity reports zero candidates, so nothing can be adopted).
  const machines = (await readdir(machinesDir).catch(() => [] as string[])).filter((d) =>
    ARCHIVE_MACHINE_ID_PATTERN.test(d),
  );
  const roots: ClaudeRoot[] = [];
  const ownId = liveRoots.length > 0 ? (await resolveArchiveMachine(repo)).id : undefined;
  for (const machine of machines.sort()) {
    const rootsDir = join(machinesDir, machine, "roots");
    const sourceRoots = await readdir(rootsDir).catch(() => []);
    for (const sourceRoot of sourceRoots.sort()) {
      // Prefer this machine's live source while it exists; its archive is a
      // backup copy, not a second session row. If the source disappears, the
      // same archive root becomes visible on the next scan.
      if (machine === ownId && liveRoots.some((root) => root.slug === sourceRoot)) {
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
