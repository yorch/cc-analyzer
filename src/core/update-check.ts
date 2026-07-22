import { mkdirSync } from "node:fs";
import { stateDir, updateCachePath } from "./paths.ts";
import { compareVersions, fetchLatestVersion } from "./release.ts";
import { VERSION } from "./version.ts";

/**
 * Passive, best-effort "update available" notice. The notice is shown from a
 * cached result (instant); the cache is refreshed at most once a day with a
 * short-timeout request at the tail of the command, so it never delays output.
 */

const DAY_MS = 24 * 60 * 60 * 1000;

interface UpdateCache {
  lastCheck: number;
  latest: string;
}

/** Whether the passive check should run at all in this environment. */
export function notifyEnabled(env: NodeJS.ProcessEnv, isTTY: boolean): boolean {
  if (env.CC_ANALYZER_NO_UPDATE_CHECK) return false;
  if (env.CI) return false;
  return isTTY;
}

/** Whether a cache entry from `lastCheck` is due for a refresh at `now`. */
export function isStale(lastCheck: number, now: number): boolean {
  return now - lastCheck >= DAY_MS;
}

/** The one-line notice, or undefined when `latest` is not newer than `current`. */
export function updateNotice(current: string, latest: string): string | undefined {
  if (compareVersions(latest, current) <= 0) return undefined;
  return `› v${latest} available (you have v${current}) — run: cc-analyzer update`;
}

async function readCache(path: string): Promise<UpdateCache | undefined> {
  try {
    const file = Bun.file(path);
    if (!(await file.exists())) return undefined;
    const data = await file.json();
    if (typeof data?.lastCheck === "number" && typeof data?.latest === "string") {
      return data as UpdateCache;
    }
  } catch {
    // corrupt or unreadable cache — ignore
  }
  return undefined;
}

async function writeCache(path: string, cache: UpdateCache): Promise<void> {
  try {
    mkdirSync(stateDir(), { recursive: true });
    await Bun.write(path, JSON.stringify(cache));
  } catch {
    // caching is best-effort
  }
}

/**
 * Print an update notice to stderr if a newer version is known. Refreshes the
 * cache when stale. Never throws and never affects the exit code.
 */
export async function maybeNotifyUpdate(now: number = Date.now()): Promise<void> {
  try {
    if (!notifyEnabled(process.env, process.stderr.isTTY === true)) return;

    const path = updateCachePath();
    const cache = await readCache(path);
    let latest = cache?.latest;

    if (!cache || isStale(cache.lastCheck, now)) {
      try {
        latest = await fetchLatestVersion(1000);
        await writeCache(path, { lastCheck: now, latest });
      } catch {
        // Offline or slow — keep any previously cached version (never fabricate
        // one; an empty string means "unknown" and shows no notice) and advance
        // lastCheck so an offline user doesn't pay the 1s timeout on every
        // subsequent command for the rest of the day.
        await writeCache(path, { lastCheck: now, latest: latest ?? "" });
      }
    }

    if (latest) {
      const notice = updateNotice(VERSION, latest);
      if (notice) process.stderr.write(`\n${notice}\n`);
    }
  } catch {
    // an update check must never break the actual command
  }
}
