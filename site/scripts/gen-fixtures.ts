#!/usr/bin/env bun
/**
 * Generate a synthetic ~/.claude-shaped dataset for screenshots — no real
 * session data. Point the app at it with CC_ANALYZER_CLAUDE_DIR.
 *
 *   bun run scripts/gen-fixtures.ts [outDir]   # default: ./.tmp/claude
 *
 * The output is deterministic (seeded), so regenerating produces identical
 * numbers and stable screenshots.
 */
import { mkdir, rm, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const outDir = process.argv[2] ?? join(here, "..", ".tmp", "claude");
const projectsRoot = join(outDir, "projects");

// Deterministic PRNG (mulberry32) so screenshots stay stable across runs.
let seed = 0x9e3779b9;
function rand(): number {
  seed |= 0;
  seed = (seed + 0x6d2b79f5) | 0;
  let t = Math.imul(seed ^ (seed >>> 15), 1 | seed);
  t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
  return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
}
const pick = <T>(xs: T[]): T => xs[Math.floor(rand() * xs.length)] as T;
const between = (lo: number, hi: number) => Math.floor(lo + rand() * (hi - lo));

const MODELS = ["claude-opus-4-8", "claude-opus-4-7", "claude-sonnet-4-5", "claude-haiku-4-5"];
const TOOLS = ["Bash", "Read", "Edit", "Write", "Grep", "Glob", "Task", "Skill"];
const PROMPTS = [
  "Refactor the auth middleware",
  "Add pagination to the results endpoint",
  "Fix the failing integration test",
  "Write docs for the pricing module",
  "Investigate the slow dashboard query",
  "Migrate the config loader to Zod",
  "Add a retry with backoff to the API client",
  "Set up the release workflow",
];

interface Project {
  cwd: string;
  branch: string;
  sessions: number;
}
const PROJECTS: Project[] = [
  { cwd: "/Users/alex/projects/webshop", branch: "main", sessions: 6 },
  { cwd: "/Users/alex/projects/analytics-api", branch: "develop", sessions: 4 },
  { cwd: "/Users/alex/work/mobile-app", branch: "main", sessions: 5 },
  { cwd: "/Users/alex/oss/cli-tools", branch: "main", sessions: 3 },
];

/** Claude Code encodes a project's cwd path into its directory name. */
const encode = (cwd: string) => cwd.replace(/\//g, "-");

function iso(base: Date, addSeconds: number): string {
  return new Date(base.getTime() + addSeconds * 1000).toISOString();
}

function buildSession(project: Project, index: number, start: Date): string {
  const sessionId = `s-${encode(project.cwd).slice(1)}-${index}`;
  const lines: string[] = [];
  const meta = {
    cwd: project.cwd,
    gitBranch: project.branch,
    version: "1.3.14",
    isSidechain: false,
    userType: "external",
    sessionId,
  };
  let clock = 0;
  let n = 0;
  const turns = between(2, 6);

  for (let t = 0; t < turns; t++) {
    const uPrompt = `u${t}`;
    lines.push(
      JSON.stringify({
        type: "user",
        ...meta,
        uuid: uPrompt,
        parentUuid: n === 0 ? null : `a${t - 1}`,
        promptId: `p${t}`,
        permissionMode: pick(["default", "acceptEdits", "plan"]),
        timestamp: iso(start, (clock += between(20, 90))),
        message: { role: "user", content: pick(PROMPTS) },
      }),
    );
    n++;

    const apiCalls = between(1, 4);
    for (let a = 0; a < apiCalls; a++) {
      const model = pick(MODELS);
      const toolName = pick(TOOLS);
      const toolId = `toolu_${t}_${a}`;
      const input =
        toolName === "Bash"
          ? { command: "bun test", description: "Run the test suite" }
          : toolName === "Skill"
            ? { skill: pick(["superpowers:brainstorming", "verify", "code-review"]) }
            : toolName === "Task"
              ? { subagent_type: pick(["general-purpose", "code-reviewer"]) }
              : { file_path: `${project.cwd}/src/module-${a}.ts` };

      lines.push(
        JSON.stringify({
          type: "assistant",
          ...meta,
          uuid: `a${t}`,
          parentUuid: uPrompt,
          requestId: `req-${t}-${a}`,
          timestamp: iso(start, (clock += between(3, 25))),
          message: {
            id: `msg-${t}-${a}`,
            role: "assistant",
            model,
            stop_reason: a === apiCalls - 1 ? "end_turn" : "tool_use",
            content: [
              { type: "text", text: "Working on it." },
              { type: "tool_use", id: toolId, name: toolName, input },
            ],
            usage: {
              input_tokens: between(200, 2500),
              output_tokens: between(150, 1800),
              cache_creation_input_tokens: between(2000, 30000),
              cache_read_input_tokens: between(20000, 400000),
              cache_creation: {
                ephemeral_5m_input_tokens: between(2000, 30000),
                ephemeral_1h_input_tokens: 0,
              },
            },
          },
        }),
      );

      lines.push(
        JSON.stringify({
          type: "user",
          ...meta,
          uuid: `r${t}_${a}`,
          parentUuid: `a${t}`,
          timestamp: iso(start, (clock += between(1, 8))),
          message: {
            role: "user",
            content: [
              {
                type: "tool_result",
                tool_use_id: toolId,
                is_error: rand() < 0.12,
                content: "ok",
              },
            ],
          },
        }),
      );
    }
  }

  lines.push(
    JSON.stringify({ type: "ai-title", sessionId, aiTitle: pick(PROMPTS) }),
  );
  return `${lines.join("\n")}\n`;
}

async function main() {
  await rm(outDir, { recursive: true, force: true });
  let sessionCount = 0;

  for (const project of PROJECTS) {
    const dir = join(projectsRoot, encode(project.cwd));
    await mkdir(dir, { recursive: true });
    for (let i = 0; i < project.sessions; i++) {
      // Spread sessions across ~4 months for a rich spend-by-month chart.
      const monthOffset = between(0, 4);
      const start = new Date(Date.UTC(2026, 3 + monthOffset, between(1, 27), between(8, 18), 0, 0));
      const file = `${encode(project.cwd).slice(1)}-${i}.jsonl`;
      await writeFile(join(dir, file), buildSession(project, i, start));
      sessionCount++;
    }
  }

  console.log(
    `Generated ${sessionCount} synthetic sessions across ${PROJECTS.length} projects -> ${projectsRoot}`,
  );
}

await main();
