import { randomUUID } from "node:crypto";
import { copyFile, mkdir, readdir, readFile, realpath, stat, writeFile } from "node:fs/promises";
import { hostname } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { ClaudeRoot } from "./claude-roots.ts";
import { fileCoveredBy, listAllSessions, type SessionInfo } from "./discover.ts";
import {
  ARCHIVE_MACHINE_ID_PATTERN,
  getArchiveMachineLabel,
  getArchivePath,
  readStoredArchiveMachineId,
  setArchiveMachineId,
} from "./prefs.ts";
import {
  MAX_ALIAS_UPDATED_AT,
  mergeAliasSources,
  normalizeAliasPath,
  PROJECT_ALIASES_FILE,
  readAliasSources,
  readProjectAliases,
  writeMachineAliases,
} from "./project-aliases.ts";

export interface ArchiveResult {
  copied: number;
  unchanged: number;
  /**
   * Sessions with at least one file left as archived because the live source is
   * a truncated (prefix) version of the archived copy; see `copyIfChanged`.
   */
  notUpdated: number;
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
 * usable `machine.json` (an archive predating identity records, or a damaged or
 * hand-deleted record; `alias set` writes the record itself) still appears,
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
 * Not persisting is deliberate, not an oversight. This runs on every
 * identity-aware path; persisting there would make the first reader mint
 * silently. It never auto-adopts either: a hostname match is not identity (two
 * computers can share a hostname and a root slug), and a wrong adoption would
 * file this computer's transcripts under another computer's id in permanent Git
 * history. Identity matters only for WRITING the archive: reads and the index
 * dedupe by session, never by machine, so an unresolved identity changes no
 * number any read surface prints. What it does stop is the backup itself:
 * `archive run` refuses, and archive-during-index skips and reports it as
 * `ReindexResult.archiveSkipped`, which every surface that indexes must print.
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
    "If one of them is this computer, adopt its id so its sessions stay under one archive directory:",
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
 * unresolved and the archive holds other machines. Used where the user is
 * working with identity (`archive machine`) and when archiving was skipped
 * because of it. Stderr only, so `--json` consumers are unaffected.
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
 * (this computer's own older directory would stay in the repository next to a second copy of everything).
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
        `(${host}). Keeping a new id leaves that directory in place, and from now on this ` +
        "computer's transcripts are archived a second time under the new id. " +
        "If it is this computer, adopt it instead: " +
        `cc-analyzer archive machine adopt ${matching[0]?.id}. Otherwise re-run with --force.`,
    );
  }
  setArchiveMachineId(resolved.id);
  return { id: resolved.id, source: "local", candidates: [], passedOver: resolved.candidates };
}

export interface AdoptOptions {
  /** Claim an id whose recorded hostnames exclude this computer. */
  force?: boolean;
  host?: string;
}

/** Explicitly claim an id that exists in the archive. Throws when it does not. */
export async function adoptArchiveMachine(
  id: string,
  repo = getArchivePath(),
  options: AdoptOptions = {},
): Promise<void> {
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
        `computer (${host}). Adopting another live computer's id would make two computers ` +
        "archive into one machine directory, mixing their raw transcripts in Git history. " +
        "If this computer was renamed, re-run with --force.",
    );
  }
  setArchiveMachineId(id);
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

type CopyOutcome = "copied" | "unchanged" | "kept";

/**
 * Copy `source` over `destination` unless that would lose data. When the
 * source is a truncated version of an already-archived file (smaller, and a
 * prefix by the same tail-window test the indexer's redundancy rule uses) the
 * archived file is kept: the working-tree copy is what the index reads, and
 * Git history holding the old content does not help it. A source that merely
 * differs (diverged) is still copied; history retains what it replaces.
 */
async function copyIfChanged(source: string, destination: string): Promise<CopyOutcome> {
  const sourceStat = await stat(source);
  const destinationStat = await stat(destination).catch(() => null);
  if (destinationStat?.size === sourceStat.size && (await sameContents(source, destination))) {
    return "unchanged";
  }
  if (destinationStat && destinationStat.size > sourceStat.size) {
    if (await fileCoveredBy(source, destination)) return "kept";
  }
  await mkdir(dirname(destination), { recursive: true });
  await copyFile(source, destination);
  return "copied";
}

async function copySession(
  info: SessionInfo,
  repo: string,
  machineId: string,
): Promise<{ changed: boolean; kept: boolean }> {
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
  let kept = false;
  const copy = async (source: string, destination: string) => {
    const outcome = await copyIfChanged(source, destination);
    if (outcome === "copied") changed = true;
    if (outcome === "kept") kept = true;
  };
  if (info.parentExists) await copy(info.path, join(sessionDir, `${sessionId}.jsonl`));
  for (const source of info.subagentPaths) {
    const name = basename(source);
    await copy(source, join(sessionDir, sessionId, "subagents", name));
    const meta = join(dirname(source), `${basename(source, ".jsonl")}.meta.json`);
    if (await Bun.file(meta).exists()) {
      await copy(meta, join(sessionDir, sessionId, "subagents", basename(meta)));
    }
  }
  return { changed, kept };
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
  let notUpdated = 0;
  for (const session of sessions) {
    const { changed, kept } = await copySession(session, repo, machineId);
    if (changed) copied++;
    if (kept) notUpdated++;
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
    notUpdated,
    committed,
    roots: (await listArchiveRoots(repo)).map((root) => root.path),
    machine,
  };
}

/** List the effective aliases (last writer wins per path across all computers' files). */
export async function listProjectAliases(): Promise<[string, string][]> {
  const { byPath } = await readProjectAliases();
  return [...byPath].sort(([a], [b]) => a.localeCompare(b));
}

/**
 * Add/update an alias, or remove one with `alias === undefined`, and commit it
 * locally. Writes ONLY this computer's `machines/<id>/project-aliases.json`
 * (removal is a tombstone), so two computers can never edit the same file and
 * Git cannot report a conflict. Each entry is stamped
 * `max(Date.now(), highest updatedAt already known for the path + 1)`: an edit
 * made now beats everything this computer can see even if its clock is behind
 * another machine's. Clocks that disagree can still make two genuinely
 * concurrent edits resolve either way, but identically on every computer.
 */
export async function setProjectAlias(path: string, alias: string | undefined): Promise<boolean> {
  const configuredPath = getArchivePath();
  if (!configuredPath)
    throw new Error("No archive repository configured. Run `cc-analyzer archive set <path>`.");
  const repo = resolve(configuredPath);
  const key = normalizeAliasPath(path);
  if (!key || !(key.startsWith("/") || /^[A-Za-z]:\//.test(key))) {
    throw new Error("Project path must be an absolute working-directory path.");
  }
  const value = alias?.trim();
  if (alias !== undefined && !value) throw new Error("Project alias must not be empty.");
  // Identity is checked before ensureRepository so a failed edit on a fresh
  // path does not leave an empty `git init`-ed repository behind.
  const machineId = readStoredArchiveMachineId();
  if (!machineId) {
    throw new Error(
      "this computer has no recorded identity, and alias edits are stored per computer. " +
        "If this computer already appears in the archive, adopt its id:\n" +
        "  cc-analyzer archive machine adopt <id>\n" +
        "Otherwise, if it is new:\n" +
        "  cc-analyzer archive machine keep\n" +
        "(`cc-analyzer archive run` records an identity on a first run.)",
    );
  }
  await ensureRepository(repo);
  await requireCleanRepository(repo);
  const sources = await readAliasSources(repo);
  const winner = mergeAliasSources(sources).get(key);
  if (value ? winner?.label === value : winner?.label === undefined) return false;
  const own = new Map(sources.find((s) => s.machineId === machineId)?.entries);
  const updatedAt = Math.max(Date.now(), (winner?.updatedAt ?? -1) + 1);
  if (updatedAt > MAX_ALIAS_UPDATED_AT) {
    // Refuse before writing anything: a stamp above the ceiling would make our
    // own file unreadable on every computer that pulls it.
    const holder = winner?.machineId
      ? `machines/${winner.machineId}/${PROJECT_ALIASES_FILE}`
      : PROJECT_ALIASES_FILE;
    throw new Error(
      `Cannot edit the alias for '${key}': ${holder} holds an entry with updatedAt ` +
        `${winner?.updatedAt}, so a newer edit would exceed the maximum ${MAX_ALIAS_UPDATED_AT}. ` +
        "Edit or remove that entry in that file, commit it, and try again.",
    );
  }
  own.set(key, { ...(value ? { label: value } : {}), updatedAt });
  const file = await writeMachineAliases(own, machineId, repo);
  // The identity record travels in the same commit: a `machines/<id>/` holding
  // only an alias file would look unidentified to other computers, which could
  // then adopt a live computer's id.
  await writeMachineRecord(repo, machineId, hostname());
  await commitArchiveFiles(
    repo,
    [file, join(repo, "machines", machineId, MACHINE_FILE)],
    value ? `Set project alias: ${value}` : "Remove project alias",
  );
  return true;
}

/**
 * Build stable archive roots in Claude's normal on-disk layout.
 *
 * Every machine's every root is returned: nothing here depends on which
 * computer is "this one". A backup copy of a session that still exists live is
 * dropped per session by `dedupeSessions` (discover.ts), so an identity mistake
 * can never hide a session.
 */
export async function listArchiveRoots(repo = getArchivePath()): Promise<ClaudeRoot[]> {
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
  for (const machine of machines.sort()) {
    const rootsDir = join(machinesDir, machine, "roots");
    const sourceRoots = await readdir(rootsDir).catch(() => []);
    for (const sourceRoot of sourceRoots.sort()) {
      const path = join(rootsDir, sourceRoot);
      const projects = await stat(join(path, "projects")).catch(() => null);
      if (!projects?.isDirectory()) continue;
      roots.push({ path, slug: `archive-${machine}-${sourceRoot}`, source: "archive" });
    }
  }
  return roots;
}
