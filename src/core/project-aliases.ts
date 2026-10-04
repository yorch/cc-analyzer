import { readFile, rename } from "node:fs/promises";
import { basename, dirname, join, posix, resolve } from "node:path";
import { getArchivePath } from "./prefs.ts";

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

function fingerprint(aliases: ReadonlyMap<string, string>): string {
  const canonical = JSON.stringify(
    Object.fromEntries([...aliases].sort(([a], [b]) => a.localeCompare(b))),
  );
  return new Bun.CryptoHasher("sha256").update(canonical).digest("hex");
}

export interface ProjectAliases {
  byPath: Map<string, string>;
  fingerprint: string;
}

/** Read shared path-to-label mappings from the configured archive repository. */
export async function readProjectAliases(repo = getArchivePath()): Promise<ProjectAliases> {
  if (!repo) return { byPath: new Map(EMPTY_ALIASES), fingerprint: fingerprint(EMPTY_ALIASES) };
  const file = join(resolve(repo), PROJECT_ALIASES_FILE);
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(file, "utf8"));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") {
      return { byPath: new Map(EMPTY_ALIASES), fingerprint: fingerprint(EMPTY_ALIASES) };
    }
    throw new Error(
      `Cannot read ${file}: ${error instanceof Error ? error.message : String(error)}`,
    );
  }
  if (
    typeof raw !== "object" ||
    raw === null ||
    !("version" in raw) ||
    raw.version !== 1 ||
    !("aliases" in raw) ||
    typeof raw.aliases !== "object" ||
    raw.aliases === null ||
    Array.isArray(raw.aliases)
  ) {
    throw new Error(`Invalid ${file}; expected {"version":1,"aliases":{...}}.`);
  }
  const byPath = new Map<string, string>();
  for (const [path, alias] of Object.entries(raw.aliases)) {
    const normalizedPath = normalizeAliasPath(path);
    if (
      !normalizedPath ||
      !(normalizedPath.startsWith("/") || /^[A-Za-z]:\//.test(normalizedPath)) ||
      typeof alias !== "string" ||
      !alias.trim()
    ) {
      throw new Error(`Invalid project alias for '${path}' in ${file}.`);
    }
    byPath.set(normalizedPath, alias.trim());
  }
  return { byPath, fingerprint: fingerprint(byPath) };
}

/** Canonical index identity for sessions whose project paths share one alias. */
export function projectAliasId(alias: string): string {
  const hash = new Bun.CryptoHasher("sha256").update(alias).digest("hex");
  return `alias~${hash}`;
}

/** Atomically write the shared alias file, sorted for stable Git diffs. */
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
