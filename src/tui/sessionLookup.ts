import type { Database } from "bun:sqlite";
import { homedir } from "node:os";
import { listArchiveRoots } from "../core/archive.ts";
import { claudeRoots } from "../core/claude-roots.ts";
import { findSessionById, sessionSourceAt } from "../core/discover.ts";
import { type IndexedSession, indexedSessionById } from "../core/queries.ts";

export type SessionLookup =
  | { ok: true; session: IndexedSession }
  | { ok: false; reason: "empty" | "not-found" | "not-jsonl" | "unreadable"; message: string };

/** Strip one pair of matching surrounding quotes (a pasted `"C:\a b\x.jsonl"`). */
export function stripQuotes(s: string): string {
  const t = s.trim();
  const first = t[0];
  if (t.length >= 2 && (first === '"' || first === "'") && t.endsWith(first)) {
    return t.slice(1, -1).trim();
  }
  return t;
}

/** `~`, `~/x` and `~\x` expand to the home directory; anything else is untouched. */
export function expandHome(p: string, home = homedir()): string {
  if (p === "~") return home;
  if (p.startsWith("~/") || p.startsWith("~\\")) return home + p.slice(1);
  return p;
}

/** Last path segment without `.jsonl`, splitting on both `/` and `\`. */
export function sessionIdFromPath(p: string): string {
  const base = p.split(/[\\/]/).pop() ?? p;
  return base.replace(/\.jsonl$/, "") || p;
}

function adHoc(path: string, sessionId: string): IndexedSession {
  // SessionDetailScreen parses via sessionSourceAt, so only the path matters.
  return {
    sessionId,
    path,
    title: null,
    cost: 0,
    costEstimated: false,
    ioTokens: 0,
    cacheTokens: 0,
    startTime: null,
    turns: 0,
    apiCalls: 0,
    toolCalls: 0,
    mtimeMs: Date.now(),
  };
}

export interface LookupDeps {
  roots?: () => Promise<Parameters<typeof findSessionById>[1]>;
  home?: string;
}

/**
 * Resolve what the user typed into the session-search prompt, with the same
 * reach as `cc-analyzer analyze <ref>`: an indexed id, a `.jsonl` path (with
 * `~`, pasted quotes, either separator), or a bare id found on disk across
 * every configured root. Says WHY it failed.
 */
export async function lookupSession(
  db: Database,
  raw: string,
  deps: LookupDeps = {},
): Promise<SessionLookup> {
  const ref = expandHome(stripQuotes(raw), deps.home);
  if (!ref) return { ok: false, reason: "empty", message: "Enter a session id or .jsonl path." };

  const indexed = indexedSessionById(db, ref);
  if (indexed) return { ok: true, session: indexed };

  const pathLike = /[\\/]/.test(ref) || ref.endsWith(".jsonl");
  if (pathLike) {
    // Only .jsonl files — prevents opening arbitrary files like /etc/passwd.
    if (!ref.endsWith(".jsonl")) {
      return { ok: false, reason: "not-jsonl", message: `Not a .jsonl session file: ${ref}` };
    }
    try {
      const source = await sessionSourceAt(ref);
      if (source.parentExists || source.subagentPaths.length > 0) {
        return { ok: true, session: adHoc(ref, sessionIdFromPath(ref)) };
      }
      return { ok: false, reason: "not-found", message: `File not found: ${ref}` };
    } catch (err) {
      return {
        ok: false,
        reason: "unreadable",
        message: `Unreadable: ${ref} (${err instanceof Error ? err.message : String(err)})`,
      };
    }
  }

  try {
    const roots = deps.roots
      ? await deps.roots()
      : [...claudeRoots(), ...(await listArchiveRoots())];
    const found = await findSessionById(ref, roots);
    if (found) return { ok: true, session: adHoc(found.path, found.id) };
  } catch (err) {
    return {
      ok: false,
      reason: "unreadable",
      message: `Could not scan Claude directories: ${err instanceof Error ? err.message : String(err)}`,
    };
  }
  return { ok: false, reason: "not-found", message: `Session not found: ${ref}` };
}
