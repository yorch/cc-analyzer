import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

export interface TempClaudeDir {
  /** The temp dir now set as CC_ANALYZER_CLAUDE_DIR. */
  dir: string;
  /** Restore the previous env value and delete the dir. */
  cleanup: () => void;
}

/**
 * Point CC_ANALYZER_CLAUDE_DIR at a fresh temp dir for a test file. One
 * canonical copy of the save/set/restore dance (bun runs test files in one
 * process, so a missed restore leaks into every later suite), with
 * mkdtempSync instead of pid/Date.now names so parallel runs can't collide.
 */
export function tempClaudeDir(prefix: string): TempClaudeDir {
  const dir = mkdtempSync(join(tmpdir(), `${prefix}-`));
  const prev = process.env.CC_ANALYZER_CLAUDE_DIR;
  process.env.CC_ANALYZER_CLAUDE_DIR = dir;
  return {
    dir,
    cleanup: () => {
      if (prev === undefined) delete process.env.CC_ANALYZER_CLAUDE_DIR;
      else process.env.CC_ANALYZER_CLAUDE_DIR = prev;
      rmSync(dir, { recursive: true, force: true });
    },
  };
}
