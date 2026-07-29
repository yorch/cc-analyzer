import { Database } from "bun:sqlite";
import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { indexDbPath, telemetryConfigPath } from "../../src/core/paths.ts";
import {
  bucketize,
  buildEventBody,
  injectSpaTelemetry,
  isTelemetryEnabled,
  maybeShowFirstRunNotice,
  POSTER_COMMAND,
  posterArgv,
  runTelemetryPoster,
  setTelemetryEnabled,
  spaTelemetryConfig,
  telemetryStatus,
  trackCommand,
} from "../../src/core/telemetry.ts";

// Env vars this module reads; saved and restored around every test so each case
// starts from a known-clean, telemetry-enabled baseline.
const ENV_KEYS = [
  "CC_ANALYZER_STATE_DIR",
  "CC_ANALYZER_TELEMETRY",
  "CC_ANALYZER_TELEMETRY_URL",
  "CC_ANALYZER_TELEMETRY_DOMAIN",
  "DO_NOT_TRACK",
  "CI",
] as const;

let tmpDir: string;
let saved: Record<string, string | undefined>;

beforeEach(() => {
  saved = {};
  for (const k of ENV_KEYS) saved[k] = process.env[k];
  // Clean baseline: nothing disabling telemetry, isolated state dir.
  delete process.env.CC_ANALYZER_TELEMETRY;
  delete process.env.DO_NOT_TRACK;
  delete process.env.CI;
  delete process.env.CC_ANALYZER_TELEMETRY_URL;
  delete process.env.CC_ANALYZER_TELEMETRY_DOMAIN;
  tmpDir = join("/tmp", `cc-analyzer-tel-${process.pid}-${Date.now()}-${Math.random()}`);
  mkdirSync(tmpDir, { recursive: true });
  process.env.CC_ANALYZER_STATE_DIR = tmpDir;
});

afterEach(() => {
  for (const k of ENV_KEYS) {
    if (saved[k] === undefined) delete process.env[k];
    else process.env[k] = saved[k];
  }
  rmSync(tmpDir, { recursive: true, force: true });
});

/** Seed a real index db with `n` session rows so bucket logic has something to read. */
function seedIndex(n: number): void {
  const db = new Database(indexDbPath(), { create: true });
  db.exec("CREATE TABLE sessions (path TEXT PRIMARY KEY)");
  const insert = db.query("INSERT INTO sessions (path) VALUES (?)");
  for (let i = 0; i < n; i++) insert.run(`s${i}`);
  db.close();
}

describe("telemetryStatus / isTelemetryEnabled", () => {
  test("enabled by default (opt-out)", () => {
    expect(isTelemetryEnabled()).toBe(true);
    expect(telemetryStatus().reason).toContain("enabled");
  });

  test("CC_ANALYZER_TELEMETRY=0 disables", () => {
    process.env.CC_ANALYZER_TELEMETRY = "0";
    expect(isTelemetryEnabled()).toBe(false);
    expect(telemetryStatus().reason).toContain("CC_ANALYZER_TELEMETRY");
  });

  test("CC_ANALYZER_TELEMETRY=off/false also disable", () => {
    for (const v of ["off", "false", "no"]) {
      process.env.CC_ANALYZER_TELEMETRY = v;
      expect(isTelemetryEnabled()).toBe(false);
    }
  });

  test("DO_NOT_TRACK=1 disables", () => {
    process.env.DO_NOT_TRACK = "1";
    expect(isTelemetryEnabled()).toBe(false);
    expect(telemetryStatus().reason).toContain("DO_NOT_TRACK");
  });

  test("CI disables", () => {
    process.env.CI = "true";
    expect(isTelemetryEnabled()).toBe(false);
    expect(telemetryStatus().reason).toContain("CI");
  });

  test("persisted config off disables; on re-enables", () => {
    setTelemetryEnabled(false);
    expect(isTelemetryEnabled()).toBe(false);
    expect(telemetryStatus().reason).toContain("telemetry off");
    setTelemetryEnabled(true);
    expect(isTelemetryEnabled()).toBe(true);
  });

  test("env override beats persisted-on config", () => {
    setTelemetryEnabled(true);
    process.env.CC_ANALYZER_TELEMETRY = "0";
    expect(isTelemetryEnabled()).toBe(false);
  });
});

describe("maybeShowFirstRunNotice", () => {
  test("writes once, persists noticeShown, silent thereafter", () => {
    const chunks: string[] = [];
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = ((s: string) => {
      chunks.push(String(s));
      return true;
    }) as typeof process.stderr.write;
    try {
      maybeShowFirstRunNotice();
      maybeShowFirstRunNotice();
    } finally {
      process.stderr.write = orig;
    }
    expect(chunks.length).toBe(1);
    expect(chunks[0]).toContain("anonymous usage stats");
    const cfg = JSON.parse(readFileSync(telemetryConfigPath(), "utf8"));
    expect(cfg.noticeShown).toBe(true);
  });

  test("does nothing when disabled", () => {
    process.env.CC_ANALYZER_TELEMETRY = "0";
    let wrote = false;
    const orig = process.stderr.write.bind(process.stderr);
    process.stderr.write = (() => {
      wrote = true;
      return true;
    }) as typeof process.stderr.write;
    try {
      maybeShowFirstRunNotice();
    } finally {
      process.stderr.write = orig;
    }
    expect(wrote).toBe(false);
    expect(existsSync(telemetryConfigPath())).toBe(false);
  });
});

describe("bucketize", () => {
  test("boundaries", () => {
    expect(bucketize(1)).toBe("1-10");
    expect(bucketize(10)).toBe("1-10");
    expect(bucketize(11)).toBe("11-100");
    expect(bucketize(100)).toBe("11-100");
    expect(bucketize(101)).toBe("101-1000");
    expect(bucketize(1000)).toBe("101-1000");
    expect(bucketize(1001)).toBe("1000+");
  });
});

describe("buildEventBody", () => {
  test("shape and static props", () => {
    process.env.CC_ANALYZER_TELEMETRY_DOMAIN = "cli.test";
    const body = buildEventBody("stats");
    expect(body.name).toBe("command");
    expect(body.url).toBe("app://cli/stats");
    expect(body.domain).toBe("cli.test");
    expect(body.props.name).toBe("stats");
    expect(body.props.os).toBe(process.platform);
    expect(body.props.arch).toBe(process.arch);
    expect(typeof body.props.version).toBe("string");
  });

  test("omits sessions_bucket when no index exists", () => {
    expect(existsSync(indexDbPath())).toBe(false);
    expect(buildEventBody("index").props.sessions_bucket).toBeUndefined();
  });

  test("includes sessions_bucket when index exists", () => {
    seedIndex(42);
    expect(buildEventBody("stats").props.sessions_bucket).toBe("11-100");
  });
});

/** Capture what `trackCommand` hands to `Bun.spawn` / `fetch` without doing
 *  either for real. `spawn` may throw to exercise the in-process fallback. */
function captureDispatch(opts: { spawnThrows?: boolean } = {}) {
  const spawns: Array<Record<string, unknown>> = [];
  const fetches: Array<{ url: string; init: RequestInit }> = [];
  const spy = spyOn(Bun, "spawn").mockImplementation(((options: Record<string, unknown>) => {
    if (opts.spawnThrows) throw new Error("EAGAIN");
    spawns.push(options);
    return { unref() {} };
  }) as unknown as typeof Bun.spawn);
  const origFetch = globalThis.fetch;
  globalThis.fetch = (async (url: string, init: RequestInit) => {
    fetches.push({ url, init });
    return new Response("", { status: 202 });
  }) as unknown as typeof fetch;
  return {
    spawns,
    fetches,
    restore() {
      spy.mockRestore();
      globalThis.fetch = origFetch;
    },
  };
}

/** The three argv slots the poster marker introduces: marker, endpoint, payload. */
function posterParts(cmd: string[]): { url: string; body: { props: Record<string, string> } } {
  const at = cmd.indexOf(POSTER_COMMAND);
  expect(at).toBeGreaterThan(-1);
  return { url: cmd[at + 1] as string, body: JSON.parse(cmd[at + 2] as string) };
}

describe("trackCommand", () => {
  test("no-op (nothing spawned, nothing fetched) when disabled", async () => {
    process.env.CC_ANALYZER_TELEMETRY = "0";
    const cap = captureDispatch();
    try {
      trackCommand("stats");
      await Promise.resolve();
    } finally {
      cap.restore();
    }
    expect(cap.spawns).toHaveLength(0);
    expect(cap.fetches).toHaveLength(0);
  });

  // The core guarantee behind the detached poster: the *parent* never holds the
  // request. A short command exits within ~10ms of dispatch, which is far less
  // than a cold TLS handshake, so an in-process fetch would die on `process.exit`.
  test("hands the event to a detached child instead of posting in-process", async () => {
    process.env.CC_ANALYZER_TELEMETRY_URL = "https://plausible.test";
    const cap = captureDispatch();
    try {
      trackCommand("serve");
      await Promise.resolve();
    } finally {
      cap.restore();
    }
    expect(cap.fetches).toHaveLength(0);
    expect(cap.spawns).toHaveLength(1);
    const spawn = cap.spawns[0] as Record<string, unknown>;
    const { url, body } = posterParts(spawn.cmd as string[]);
    expect(url).toBe("https://plausible.test");
    expect(body.props.name).toBe("serve");
    // Detached with no stdio is what lets it outlive the parent's process.exit().
    expect(spawn.detached).toBe(true);
    expect(spawn.stdio).toEqual(["ignore", "ignore", "ignore"]);
    expect(spawn.windowsHide).toBe(true);
  });

  test("falls back to an in-process post when the spawn is refused", async () => {
    process.env.CC_ANALYZER_TELEMETRY_URL = "https://plausible.test";
    const cap = captureDispatch({ spawnThrows: true });
    try {
      expect(() => trackCommand("stats")).not.toThrow();
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      cap.restore();
    }
    expect(cap.fetches).toHaveLength(1);
    expect(cap.fetches[0]?.url).toBe("https://plausible.test/api/event");
    expect(JSON.parse(String(cap.fetches[0]?.init.body)).props.name).toBe("stats");
  });

  test("never throws when the fallback fetch rejects (fire-and-forget)", async () => {
    const spy = spyOn(Bun, "spawn").mockImplementation((() => {
      throw new Error("EAGAIN");
    }) as unknown as typeof Bun.spawn);
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      throw new Error("network down");
    }) as unknown as typeof fetch;
    try {
      expect(() => trackCommand("stats")).not.toThrow();
      // let the swallowed rejection settle without an unhandled-rejection crash
      await Promise.resolve();
      await Promise.resolve();
    } finally {
      spy.mockRestore();
      globalThis.fetch = orig;
    }
  });
});

describe("posterArgv", () => {
  test("re-invokes this entrypoint with the endpoint and prebuilt payload", () => {
    const body = buildEventBody("stats");
    const argv = posterArgv("https://plausible.test", body);
    // The suite runs from source, so execPath is bun and the entrypoint follows.
    expect(argv[0]).toBe(process.execPath);
    expect(argv[1]).toBe(Bun.main);
    expect(argv[2]).toBe(POSTER_COMMAND);
    expect(argv[3]).toBe("https://plausible.test");
    expect(JSON.parse(argv[4] as string)).toEqual(body);
  });

  test("payload is a single argv entry, so nothing is word-split or shell-parsed", () => {
    const argv = posterArgv("https://plausible.test", buildEventBody("analyze"));
    expect(argv).toHaveLength(5);
  });
});

describe("runTelemetryPoster", () => {
  test("posts the handed-over body to the handed-over endpoint", async () => {
    const body = buildEventBody("projects");
    let url: string | undefined;
    let init: RequestInit | undefined;
    const orig = globalThis.fetch;
    globalThis.fetch = (async (u: string, i: RequestInit) => {
      url = u;
      init = i;
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    try {
      expect(await runTelemetryPoster("https://plausible.test", JSON.stringify(body))).toBe(0);
    } finally {
      globalThis.fetch = orig;
    }
    expect(url).toBe("https://plausible.test/api/event");
    expect(init?.method).toBe("POST");
    expect(JSON.parse(String(init?.body)).props.name).toBe("projects");
    const headers = init?.headers as Record<string, string>;
    expect(headers["User-Agent"]).toContain("cc-analyzer/");
    expect(headers["Content-Type"]).toBe("application/json");
  });

  test("sends nothing, and still succeeds, on missing or malformed input", async () => {
    let called = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    try {
      expect(await runTelemetryPoster()).toBe(0);
      expect(await runTelemetryPoster("https://plausible.test")).toBe(0);
      expect(await runTelemetryPoster("https://plausible.test", "not json")).toBe(0);
    } finally {
      globalThis.fetch = orig;
    }
    expect(called).toBe(false);
  });

  // The marker is reachable by hand, so it re-checks the switch: an opted-out
  // machine cannot be made to emit an event by invoking the hidden subcommand.
  test("sends nothing when telemetry is disabled", async () => {
    process.env.CC_ANALYZER_TELEMETRY = "0";
    let called = false;
    const orig = globalThis.fetch;
    globalThis.fetch = (async () => {
      called = true;
      return new Response("", { status: 202 });
    }) as unknown as typeof fetch;
    try {
      const body = JSON.stringify(buildEventBody("stats"));
      expect(await runTelemetryPoster("https://plausible.test", body)).toBe(0);
    } finally {
      globalThis.fetch = orig;
    }
    expect(called).toBe(false);
  });
});

describe("spa injection", () => {
  test("spaTelemetryConfig carries web domain + Events API endpoint when enabled", () => {
    process.env.CC_ANALYZER_TELEMETRY_URL = "https://plausible.test";
    const cfg = spaTelemetryConfig();
    expect(cfg).toEqual({
      domain: "cc-analyzer-webui",
      endpoint: "https://plausible.test/api/event",
    });
  });

  test("spaTelemetryConfig null when disabled", () => {
    process.env.CC_ANALYZER_TELEMETRY = "0";
    expect(spaTelemetryConfig()).toBeNull();
  });

  test("injectSpaTelemetry inserts the config before </head> when enabled", () => {
    const out = injectSpaTelemetry("<head><title>x</title></head><body></body>");
    expect(out).toContain("window.__CC_TELEMETRY__=");
    expect(out).toContain('"domain":"cc-analyzer-webui"');
    // config must land before </head> (so it runs before the deferred SPA bundle)
    expect(out.indexOf("__CC_TELEMETRY__")).toBeLessThan(out.indexOf("</head>"));
    // never emit an auto-capturing script src — pageviews are sanitized client-side
    expect(out).not.toContain("script.local.js");
  });

  test("injectSpaTelemetry escapes < so a value cannot break out of the script", () => {
    process.env.CC_ANALYZER_TELEMETRY_URL = "https://plausible.test/</script>";
    const out = injectSpaTelemetry("<head></head><body></body>");
    // The payload's "<" is escaped, so the only "</script>" is the wrapper's own.
    expect(out.split("</script>").length - 1).toBe(1);
    expect(out).toContain("\\u003c");
  });

  test("injectSpaTelemetry is a no-op when disabled", () => {
    process.env.CC_ANALYZER_TELEMETRY = "0";
    const html = "<head></head><body></body>";
    expect(injectSpaTelemetry(html)).toBe(html);
  });
});
