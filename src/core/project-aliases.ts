import { mkdir, readdir, readFile, rename, rm } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { ARCHIVE_MACHINE_ID_PATTERN, getArchivePath } from "./prefs.ts";

export const PROJECT_ALIASES_FILE = "project-aliases.json";
const EMPTY_ALIASES = new Map<string, string>();

/** Normalize a recorded cwd without interpreting another machine's path locally. */
export function normalizeAliasPath(path: string): string {
  const slashed = path.trim().replace(/\\/g, "/");
  if (!slashed) return "";
  // Preserve Windows drive and UNC roots while using POSIX separators so the
  // same archive mapping reads identically on every operating system.
  const unc = slashed.startsWith("//");
  const normalized = posix.normalize(slashed);
  const rooted = unc ? `//${normalized.replace(/^\/+/, "")}` : normalized;
  return rooted.length > 1 ? rooted.replace(/\/$/, "") : rooted;
}

export interface ProjectAliases {
  byPath: Map<string, string>;
}

/** One alias edit: a label, or a tombstone (`label` undefined) that removes the path. */
export interface AliasEntry {
  /** Absent for a tombstone. */
  label?: string;
  updatedAt: number;
}

/**
 * One file's worth of alias edits. `machineId` is undefined for the legacy
 * shared root file, whose entries all carry `updatedAt: 0` and lose every tie.
 */
export interface AliasSource {
  machineId?: string;
  entries: ReadonlyMap<string, AliasEntry>;
}

/** The winning entry for a path, with the file it came from. */
export interface AliasWinner extends AliasEntry {
  machineId?: string;
}

/** Version of the per-machine file (`machines/<id>/project-aliases.json`). */
export const MACHINE_ALIASES_VERSION = 2;

/**
 * Highest `updatedAt` any alias entry may carry: 2200-01-01T00:00:00Z in epoch
 * ms. A fixed constant (not "now + slack"), so every computer applies the
 * identical rule and the merge fold stays pure. The reader rejects anything
 * above it and the writer refuses to stamp above it: without a ceiling, one
 * hostile or corrupt entry near `Number.MAX_SAFE_INTEGER` forces every later
 * "beat the winner" stamp past the safe-integer range, producing a file our own
 * strict reader rejects on every computer that pulls it.
 */
export const MAX_ALIAS_UPDATED_AT = Date.UTC(2200, 0, 1);

/**
 * How to recover from an invalid alias file: which computer owns it and which
 * Git command discards a local bad edit. Reads stay strict; this only makes the
 * error actionable.
 */
function aliasFileRecovery(file: string, machineId?: string): string {
  const owner = machineId
    ? `This file belongs to machine ${machineId}.`
    : "This is the legacy shared alias file.";
  const repo = machineId ? dirname(dirname(dirname(file))) : dirname(file);
  const rel = machineId ? `machines/${machineId}/${PROJECT_ALIASES_FILE}` : PROJECT_ALIASES_FILE;
  return (
    `${owner} If it was edited on this computer, discard the edit with ` +
    `\`git -C ${repo} checkout -- ${rel}\`; otherwise fix or revert it on the computer ` +
    "that wrote it, commit, and pull. Aliases are never read around a bad file, because " +
    "that would silently move sessions between projects."
  );
}

/** `machines/<id>/project-aliases.json` inside the archive repository. */
export function machineAliasFile(repo: string, machineId: string): string {
  return join(resolve(repo), "machines", machineId, PROJECT_ALIASES_FILE);
}

function isAbsoluteAliasKey(key: string): boolean {
  return !!key && (key.startsWith("/") || /^[A-Za-z]:\//.test(key));
}

function isPlainObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Total order: later `updatedAt` wins; ties go to the greater machine id; legacy loses. */
function beats(a: AliasWinner, b: AliasWinner): boolean {
  if (a.updatedAt !== b.updatedAt) return a.updatedAt > b.updatedAt;
  return (a.machineId ?? "") > (b.machineId ?? "");
}

/**
 * Pure fold of every alias file into one winner per normalized path: the entry
 * with the greatest `updatedAt`, ties broken by the greater machine id (the
 * legacy file, having no id, loses all ties). Deterministic and independent of
 * input order, so every computer derives the same map from the same repository.
 * Tombstones are kept here; `effectiveAliasMap` drops them.
 *
 * Mixed old/new fleets: an older cc-analyzer rewrites the shared root v1 file,
 * whose entries read here as `updatedAt: 0`. Any per-machine entry for the same
 * path therefore out-votes it, so an edit made by an old client is silently
 * overridden wherever a new client has also set (or removed) that path. Nothing
 * is lost, the old value stays in the legacy file, and this is the accepted
 * compatibility rule: upgrade every computer to make edits count again.
 * In-file duplicates that normalize to one path with equal `updatedAt` resolve
 * to the one listed last (see `parseMachineFile`).
 */
export function mergeAliasSources(sources: readonly AliasSource[]): Map<string, AliasWinner> {
  const winners = new Map<string, AliasWinner>();
  for (const source of sources) {
    for (const [rawPath, entry] of source.entries) {
      const path = normalizeAliasPath(rawPath);
      const candidate: AliasWinner = { ...entry, machineId: source.machineId };
      const current = winners.get(path);
      if (!current || beats(candidate, current)) winners.set(path, candidate);
    }
  }
  return winners;
}

/** The path-to-label map after last-writer-wins resolution (tombstoned paths absent). */
export function effectiveAliasMap(sources: readonly AliasSource[]): Map<string, string> {
  const byPath = new Map<string, string>();
  for (const [path, winner] of mergeAliasSources(sources)) {
    if (winner.label !== undefined) byPath.set(path, winner.label);
  }
  return byPath;
}

async function readJsonFile(file: string, machineId?: string): Promise<unknown | undefined> {
  try {
    return JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new Error(
      `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}\n` +
        aliasFileRecovery(file, machineId),
    );
  }
}

/** Strict parse of the legacy root file (version 1); every entry gets `updatedAt: 0`. */
function parseLegacy(raw: unknown, file: string): AliasSource {
  if (!isPlainObject(raw) || raw.version !== 1 || !isPlainObject(raw.aliases)) {
    throw new Error(
      `Invalid ${file}; expected {"version":1,"aliases":{...}}.\n${aliasFileRecovery(file)}`,
    );
  }
  const entries = new Map<string, AliasEntry>();
  for (const [path, alias] of Object.entries(raw.aliases)) {
    const key = normalizeAliasPath(path);
    if (!isAbsoluteAliasKey(key) || typeof alias !== "string" || !alias.trim()) {
      throw new Error(
        `Invalid project alias for '${path}' in ${file}.\n${aliasFileRecovery(file)}`,
      );
    }
    entries.set(key, { label: alias.trim(), updatedAt: 0 });
  }
  return { entries };
}

/** Strict parse of a per-machine file (version 2). */
function parseMachineFile(raw: unknown, file: string, machineId: string): AliasSource {
  if (
    !isPlainObject(raw) ||
    raw.version !== MACHINE_ALIASES_VERSION ||
    !isPlainObject(raw.aliases)
  ) {
    throw new Error(
      `Invalid ${file}; expected {"version":2,"aliases":{...}}.\n` +
        aliasFileRecovery(file, machineId),
    );
  }
  const entries = new Map<string, AliasEntry>();
  for (const [path, value] of Object.entries(raw.aliases)) {
    const key = normalizeAliasPath(path);
    const label = isPlainObject(value) && typeof value.label === "string" ? value.label.trim() : "";
    const tombstone = isPlainObject(value) && value.removed === true;
    // An entry is exactly one of {label, updatedAt} or {removed:true, updatedAt}.
    const bothForms = isPlainObject(value) && "label" in value && "removed" in value;
    if (
      !isAbsoluteAliasKey(key) ||
      !isPlainObject(value) ||
      bothForms ||
      !Number.isSafeInteger(value.updatedAt) ||
      (value.updatedAt as number) < 0 ||
      (value.updatedAt as number) > MAX_ALIAS_UPDATED_AT ||
      (!tombstone && !label)
    ) {
      const stamp = isPlainObject(value) ? ` (updatedAt ${String(value?.updatedAt)})` : "";
      throw new Error(
        `Invalid project alias for '${path}' in ${file}${stamp}; an entry needs an absolute path, exactly one of label or removed:true, ` +
          `and an integer updatedAt between 0 and ${MAX_ALIAS_UPDATED_AT}.\n${aliasFileRecovery(file, machineId)}`,
      );
    }
    const entry: AliasEntry = {
      ...(tombstone ? {} : { label }),
      updatedAt: value.updatedAt as number,
    };
    const existing = entries.get(key);
    if (!existing || entry.updatedAt >= existing.updatedAt) entries.set(key, entry);
  }
  return { machineId, entries };
}

/**
 * Read the legacy root file and every `machines/<id>/project-aliases.json`.
 * Strict: any unreadable or invalid file throws, naming it, because silently
 * dropping aliases would silently re-assign sessions to different projects.
 * A missing file is simply absent.
 */
export async function readAliasSources(repo = getArchivePath()): Promise<AliasSource[]> {
  if (!repo) return [];
  const root = resolve(repo);
  const sources: AliasSource[] = [];
  const legacyFile = join(root, PROJECT_ALIASES_FILE);
  const legacy = await readJsonFile(legacyFile);
  if (legacy !== undefined) sources.push(parseLegacy(legacy, legacyFile));
  const dirs = (await readdir(join(root, "machines")).catch(() => [] as string[]))
    .filter((d) => ARCHIVE_MACHINE_ID_PATTERN.test(d))
    .sort();
  for (const id of dirs) {
    const file = machineAliasFile(root, id);
    const raw = await readJsonFile(file, id);
    if (raw !== undefined) sources.push(parseMachineFile(raw, file, id));
  }
  return sources;
}

/** Read the effective path-to-label mappings from the configured archive repository. */
export async function readProjectAliases(repo = getArchivePath()): Promise<ProjectAliases> {
  if (!repo) return { byPath: new Map(EMPTY_ALIASES) };
  return { byPath: effectiveAliasMap(await readAliasSources(repo)) };
}

/**
 * Atomically write one computer's alias file (sorted for stable Git diffs).
 * Only that machine's file is ever written; the legacy root file is never
 * touched by this.
 */
export async function writeMachineAliases(
  entries: ReadonlyMap<string, AliasEntry>,
  machineId: string,
  repo = getArchivePath(),
): Promise<string> {
  if (!repo)
    throw new Error("No archive repository configured. Run `cc-analyzer archive set <path>`.");
  const file = machineAliasFile(repo, machineId);
  const aliases = Object.fromEntries(
    [...entries]
      .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
      .map(([path, e]) => [
        path,
        e.label === undefined
          ? { removed: true, updatedAt: e.updatedAt }
          : { label: e.label, updatedAt: e.updatedAt },
      ]),
  );
  const body = `${JSON.stringify({ version: MACHINE_ALIASES_VERSION, aliases }, null, 2)}\n`;
  await mkdir(dirname(file), { recursive: true });
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  // Best-effort cleanup if the write or rename throws, so a failed write cannot
  // leave an untracked temp file that dirties the repo. A crash (not a throw)
  // between write and rename can still leave one behind.
  try {
    await Bun.write(temp, body);
    await rename(temp, file);
  } catch (error) {
    await rm(temp, { force: true }).catch(() => {});
    throw error;
  }
  return file;
}

/** Canonical index identity for sessions whose project paths share one alias. */
export function projectAliasId(alias: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(alias).digest("hex");
  return `alias~${hash}`;
}

/**
 * Atomically write the LEGACY shared root file (version 1). cc-analyzer itself
 * no longer writes it (see `writeMachineAliases`); kept for tests and for
 * fixtures that model archives written by older versions.
 */
export async function writeProjectAliases(
  aliases: ReadonlyMap<string, string>,
  repo = getArchivePath(),
): Promise<void> {
  if (!repo)
    throw new Error("No archive repository configured. Run `cc-analyzer archive set <path>`.");
  const file = join(resolve(repo), PROJECT_ALIASES_FILE);
  const sorted = Object.fromEntries([...aliases].sort(([a], [b]) => a.localeCompare(b)));
  const body = `${JSON.stringify({ version: 1, aliases: sorted }, null, 2)}\n`;
  const temp = join(dirname(file), `.${basename(file)}.${process.pid}.tmp`);
  await Bun.write(temp, body);
  await rename(temp, file);
}

/** Resolve source-compatible paths for display or CLI input. */
export function aliasesForProjectPath(
  path: string | null | undefined,
  aliases: ReadonlyMap<string, string>,
): string | undefined {
  if (!path) return undefined;
  return aliases.get(normalizeAliasPath(path));
}

/**
 * Whether an indexed row was keyed under an alias the current map no longer
 * agrees with. The row's own `project_alias` column is the ground truth for
 * what it was indexed under, so no separate bookkeeping can go stale. Shared by
 * `reindex()` and `inspectIndexStatus()` so `index --check` never reports work
 * the indexer will not do.
 */
export function aliasNeedsReindex(
  projectPath: string | null | undefined,
  projectAlias: string | null | undefined,
  aliases: ReadonlyMap<string, string>,
): boolean {
  return (aliasesForProjectPath(projectPath, aliases) ?? null) !== (projectAlias ?? null);
}
