import { describe, expect, test } from "bun:test";
import {
  buildPortfolioDiagnostics,
  PORTFOLIO_DIAGNOSTIC_CODES,
  type PortfolioSignals,
} from "../../src/core/portfolio-diagnostics.ts";
import type { SetupAudit, SetupAuditFinding } from "../../src/core/setup-audit.ts";
import type {
  CompactionProjectRow,
  ContextTaxRow,
  ErrorWeekRow,
  IdleCacheBucket,
  ParseCoverageSummary,
  ParseCoverageVersionRow,
  ProjectCacheRow,
} from "../../src/core/stats-types.ts";

/* ——— Fixture builders: a healthy baseline, overridden per rule ————————— */

/** Flat 1%-error weeks, oldest first. */
function flatWeeks(n: number, calls = 500, errors = 5): ErrorWeekRow[] {
  return Array.from({ length: n }, (_, i) => ({
    week: `2026-0${1 + Math.floor(i / 4)}-0${1 + (i % 4)}`,
    toolCalls: calls,
    errors,
    errorRate: calls > 0 ? errors / calls : 0,
  }));
}

function idleBuckets(over: Partial<IdleCacheBucket>[] = []): IdleCacheBucket[] {
  const base: IdleCacheBucket[] = [
    { bucket: "<25% idle", sessions: 10, ratio: 5, wasteShare: 0.05 },
    { bucket: "25–50% idle", sessions: 8, ratio: 4.5, wasteShare: 0.08 },
    { bucket: "50–75% idle", sessions: 6, ratio: 4, wasteShare: 0.1 },
    { bucket: "75%+ idle", sessions: 6, ratio: 4, wasteShare: 0.12 },
  ];
  return base.map((b, i) => ({ ...b, ...over[i] }));
}

function cacheProject(over: Partial<ProjectCacheRow> = {}): ProjectCacheRow {
  return {
    projectId: "proj-a",
    projectPath: "/dev/proj-a",
    sessions: 20,
    writeTokens: 1_000_000,
    readTokens: 5_000_000,
    writeCost: 15,
    readCost: 4,
    inputCost: 10,
    outputCost: 20,
    totalCost: 80,
    ratio: 5,
    waste: 0.8,
    ...over,
  };
}

function compactionProject(over: Partial<CompactionProjectRow> = {}): CompactionProjectRow {
  return {
    projectId: "proj-a",
    projectPath: "/dev/proj-a",
    sessions: 20,
    sessionsWithCompaction: 3,
    compactions: 4,
    share: 0.15,
    ...over,
  };
}

function taxProject(over: Partial<ContextTaxRow> = {}): ContextTaxRow {
  return {
    projectId: "proj-a",
    projectPath: "/dev/proj-a",
    sessions: 20,
    avgTokens: 12_000,
    medianTokens: 12_000,
    p90Tokens: 20_000,
    ...over,
  };
}

function auditWith(findings: Partial<SetupAuditFinding>[]): SetupAudit {
  return {
    inventory: {
      claudeDir: "/tmp/claude",
      claudeDirs: ["/tmp/claude"],
      present: true,
      skills: [],
      agents: [],
      plugins: [],
      mcpServers: [],
      hooks: [],
      permissions: { allow: 0, deny: 0, ask: 0 },
      model: null,
    },
    counts: {
      skills: 0,
      agents: 0,
      plugins: 0,
      mcpServers: 0,
      mcpGlobal: 0,
      mcpProject: 0,
      hookEvents: 0,
      hooks: 0,
      permissionAllow: 0,
      permissionDeny: 0,
      permissionAsk: 0,
    },
    plugins: [],
    findings: findings.map((f) => ({
      code: "unused-mcp-server",
      severity: "warning",
      title: "MCP server is unused",
      evidence: "",
      action: "",
      subject: "github",
      ...f,
    })),
    today: "2026-07-28",
  };
}

type Overrides = {
  summary?: Partial<PortfolioSignals["stats"]["summary"]>;
  distribution?: Partial<PortfolioSignals["stats"]["distribution"]>;
  sidechain?: Partial<PortfolioSignals["stats"]["sidechain"]>;
  retries?: Partial<PortfolioSignals["rollup"]["retries"]>;
  tests?: Partial<PortfolioSignals["rollup"]["tests"]>;
  thrash?: Partial<PortfolioSignals["rollup"]["thrash"]>;
  corrections?: Partial<PortfolioSignals["rollup"]["corrections"]>;
  cacheSummary?: Partial<PortfolioSignals["cache"]["summary"]>;
  cacheProjects?: ProjectCacheRow[];
  idleBuckets?: IdleCacheBucket[];
  compactionsByProject?: CompactionProjectRow[];
  errorWeekly?: ErrorWeekRow[];
  taxByProject?: ContextTaxRow[];
  parseCoverage?: PortfolioSignals["parseCoverage"];
  whatIfSummary?: Partial<PortfolioSignals["whatIf"]["summary"]>;
  audit?: SetupAudit;
};

/** A portfolio no rule should complain about; each test overrides one signal. */
function signals(over: Overrides = {}): PortfolioSignals {
  return {
    stats: {
      summary: {
        sessions: 30,
        projects: 2,
        cost: 100,
        estimatedShare: 0,
        inputTokens: 1_000_000,
        outputTokens: 200_000,
        cacheWriteTokens: 1_000_000,
        cacheReadTokens: 5_000_000,
        firstDay: "2026-05-01",
        lastDay: "2026-07-27",
        ...over.summary,
      },
      byMonth: [],
      byProject: [],
      byModel: [],
      top: [],
      duration: {
        sessions: 30,
        totalMs: 0,
        avgMs: 0,
        medianMs: 0,
        p90Ms: 0,
        totalActiveMs: 0,
        activeShare: 0,
      },
      distribution: {
        sessions: 30,
        mean: 3.3,
        p50: 1,
        p90: 8,
        p99: 12,
        max: 15,
        topDecileShare: 0.4,
        buckets: [],
        ...over.distribution,
      },
      streaks: { activeDays: 30, longestStreak: 5, currentStreak: 1, last30ActiveDays: 15 },
      runRate: {
        month: "2026-07",
        monthToDate: 40,
        prevMonth: "2026-06",
        prevMonthSamePoint: 35,
        prevMonthTotal: 45,
        projected: 44,
      },
      sidechain: {
        cost: 20,
        calls: 100,
        totalCost: 100,
        totalCalls: 1000,
        share: 0.2,
        ...over.sidechain,
      },
      estimatedByProject: [],
    },
    rollup: {
      tools: [],
      skills: [],
      subagents: [],
      bash: [],
      tests: { runs: 0, failures: 0, sessions: 0, failureRate: 0, ...over.tests },
      retries: {
        total: 5,
        sessions: 3,
        byTool: [{ tool: "Bash", retries: 5, sessions: 2 }],
        ...over.retries,
      },
      thrash: {
        testThrashSessions: 0,
        worstTestFailStreak: 0,
        redundantReads: 10,
        rereadSessions: 2,
        topRereadFiles: [{ file: "/p/one/README.md", sessions: 2 }],
        ...over.thrash,
      },
      corrections: {
        sessions: 5,
        correctionTurns: 10,
        interruptionTurns: 4,
        turns: 300,
        correctionShare: 10 / 300,
        interruptionShare: 4 / 300,
        weekly: [],
        ...over.corrections,
      },
      permissionModes: [],
      stopReasons: [],
      turnDepth: { turns: 100, avgDepth: 3, maxDepth: 10, buckets: [], byMonth: [] },
      versions: [],
      branches: [],
    },
    cache: {
      summary: { writeCost: 20, readCost: 5, waste: 1, totalCost: 100, ...over.cacheSummary },
      ttl: { write5mTokens: 900_000, write1hTokens: 100_000, writeCost: 20 },
      idleBuckets: over.idleBuckets ?? idleBuckets(),
      projects: over.cacheProjects ?? [cacheProject()],
    },
    compactions: {
      summary: {
        sessions: 3,
        totalSessions: 30,
        compactions: 4,
        auto: 3,
        manual: 1,
        unknown: 0,
        sidechain: 0,
        inherited: 0,
      },
      byProject: over.compactionsByProject ?? [compactionProject()],
    },
    errorWeekly: over.errorWeekly ?? flatWeeks(10),
    contextTax: {
      summary: { sessions: 30, medianTokens: 12_000, p90Tokens: 20_000 },
      byProject: over.taxByProject ?? [taxProject()],
    },
    whatIf: {
      summary: {
        actualCost: 100,
        bestModel: "claude-sonnet-5",
        bestCost: 98,
        bestDelta: -2,
        fallbackAlternatives: false,
        ...over.whatIfSummary,
      },
      rows: [],
    },
    ...(over.audit ? { audit: over.audit } : {}),
    ...(over.parseCoverage ? { parseCoverage: over.parseCoverage } : {}),
  };
}

const codes = (s: PortfolioSignals): string[] => buildPortfolioDiagnostics(s).map((d) => d.code);

/* ——— Baseline ————————————————————————————————————————————————————————— */

describe("baseline", () => {
  test("a healthy portfolio yields zero findings", () => {
    expect(buildPortfolioDiagnostics(signals())).toEqual([]);
  });

  test("the exported code list covers every implemented rule", () => {
    expect(PORTFOLIO_DIAGNOSTIC_CODES).toHaveLength(16);
  });
});

/* ——— Per-rule firing + threshold edges ———————————————————————————————— */

describe("cache-leaky", () => {
  const leaky = { cacheWriteTokens: 1_000_000, cacheReadTokens: 500_000 };
  test("fires when reads don't cover writes and write spend is real", () => {
    const out = buildPortfolioDiagnostics(
      signals({ summary: leaky, cacheSummary: { writeCost: 20, waste: 5 } }),
    );
    const f = out.find((d) => d.code === "cache-leaky");
    expect(f?.severity).toBe("warning");
    expect(f?.evidence).toContain("0.5×");
    expect(f?.evidence).toContain("$20.00");
    expect(f?.evidence).toContain("$5.00");
  });
  test("stays quiet below the $5 write-cost floor", () => {
    expect(
      codes(signals({ summary: leaky, cacheSummary: { writeCost: 4.99, waste: 2 } })),
    ).not.toContain("cache-leaky");
  });
  test("stays quiet at ratio exactly 1", () => {
    expect(
      codes(signals({ summary: { cacheWriteTokens: 1_000_000, cacheReadTokens: 1_000_000 } })),
    ).not.toContain("cache-leaky");
  });
});

describe("cache-waste-heavy", () => {
  test("fires at 20% waste over the $10 floor and points at the top project", () => {
    const out = buildPortfolioDiagnostics(
      signals({
        cacheSummary: { writeCost: 50, waste: 10 },
        cacheProjects: [cacheProject({ waste: 7 })],
      }),
    );
    const f = out.find((d) => d.code === "cache-waste-heavy");
    expect(f?.severity).toBe("warning");
    expect(f?.projectId).toBe("proj-a");
    expect(f?.evidence).toContain("$7.00");
  });
  test("stays quiet below the $10 absolute floor", () => {
    expect(codes(signals({ cacheSummary: { writeCost: 20, waste: 9.99 } }))).not.toContain(
      "cache-waste-heavy",
    );
  });
  test("stays quiet below the 20% share", () => {
    expect(codes(signals({ cacheSummary: { writeCost: 100, waste: 19 } }))).not.toContain(
      "cache-waste-heavy",
    );
  });
});

describe("idle-cache-pattern", () => {
  test("fires when the high-idle bucket wastes materially more", () => {
    const out = buildPortfolioDiagnostics(
      signals({ idleBuckets: idleBuckets([{}, {}, { wasteShare: 0.3 }, { sessions: 0 }]) }),
    );
    const f = out.find((d) => d.code === "idle-cache-pattern");
    expect(f?.severity).toBe("info");
    expect(f?.evidence).toContain("50–75% idle");
    expect(f?.action).toContain("Correlational");
  });
  test("fires on a halved read:write ratio too", () => {
    expect(codes(signals({ idleBuckets: idleBuckets([{}, {}, {}, { ratio: 2.5 }]) }))).toContain(
      "idle-cache-pattern",
    );
  });
  test("stays quiet below both deltas or with thin buckets", () => {
    expect(
      codes(signals({ idleBuckets: idleBuckets([{}, {}, { wasteShare: 0.19 }, {}]) })),
    ).not.toContain("idle-cache-pattern");
    expect(
      codes(signals({ idleBuckets: idleBuckets([{}, {}, { wasteShare: 0.5, sessions: 4 }, {}]) })),
    ).not.toContain("idle-cache-pattern");
  });
});

describe("compaction-pressure", () => {
  test("fires when half a project's sessions compact", () => {
    const out = buildPortfolioDiagnostics(
      signals({
        compactionsByProject: [
          compactionProject({ sessions: 6, sessionsWithCompaction: 3, share: 0.5 }),
        ],
      }),
    );
    const f = out.find((d) => d.code === "compaction-pressure");
    expect(f?.severity).toBe("warning");
    expect(f?.projectId).toBe("proj-a");
    expect(f?.evidence).toContain("3 of 6 sessions");
  });
  test("stays quiet below the share or session floor", () => {
    expect(
      codes(
        signals({
          compactionsByProject: [
            compactionProject({ sessions: 6, sessionsWithCompaction: 2, share: 0.49 }),
          ],
        }),
      ),
    ).not.toContain("compaction-pressure");
    expect(
      codes(
        signals({
          compactionsByProject: [
            compactionProject({ sessions: 4, sessionsWithCompaction: 3, share: 0.75 }),
          ],
        }),
      ),
    ).not.toContain("compaction-pressure");
  });
});

describe("context-tax-heavy", () => {
  test("fires as info at 30k and escalates to warning at 50k", () => {
    const info = buildPortfolioDiagnostics(
      signals({ taxByProject: [taxProject({ medianTokens: 30_000 })] }),
    ).find((d) => d.code === "context-tax-heavy");
    expect(info?.severity).toBe("info");
    const warn = buildPortfolioDiagnostics(
      signals({ taxByProject: [taxProject({ medianTokens: 50_000 })] }),
    ).find((d) => d.code === "context-tax-heavy");
    expect(warn?.severity).toBe("warning");
    expect(warn?.evidence).toContain("50,000");
  });
  test("stays quiet below the token or session floor", () => {
    expect(codes(signals({ taxByProject: [taxProject({ medianTokens: 29_999 })] }))).not.toContain(
      "context-tax-heavy",
    );
    expect(
      codes(signals({ taxByProject: [taxProject({ medianTokens: 60_000, sessions: 4 })] })),
    ).not.toContain("context-tax-heavy");
  });
  test("cross-references unused MCP servers when the audit is present", () => {
    const f = buildPortfolioDiagnostics(
      signals({
        taxByProject: [taxProject({ medianTokens: 40_000 })],
        audit: auditWith([{ code: "unused-mcp-server", subject: "github" }]),
      }),
    ).find((d) => d.code === "context-tax-heavy");
    expect(f?.action).toContain("github");
  });
});

describe("model-downshift-opportunity", () => {
  test("fires when the best delta saves ≥20% and ≥$5", () => {
    const f = buildPortfolioDiagnostics(
      signals({ whatIfSummary: { bestCost: 75, bestDelta: -25 } }),
    ).find((d) => d.code === "model-downshift-opportunity");
    expect(f?.severity).toBe("info");
    expect(f?.evidence).toContain("claude-sonnet-5");
    expect(f?.evidence).toContain("$25.00");
    expect(f?.action).toContain("quality is not priced in");
  });
  test("stays quiet below the 20% share or the $5 floor", () => {
    expect(codes(signals({ whatIfSummary: { bestCost: 80.01, bestDelta: -19.99 } }))).not.toContain(
      "model-downshift-opportunity",
    );
    expect(
      codes(signals({ whatIfSummary: { actualCost: 20, bestCost: 15.5, bestDelta: -4.5 } })),
    ).not.toContain("model-downshift-opportunity");
  });
});

describe("retry-churn", () => {
  test("fires on one tool at 20 retries across 3 sessions", () => {
    const f = buildPortfolioDiagnostics(
      signals({
        retries: { total: 25, sessions: 4, byTool: [{ tool: "Edit", retries: 20, sessions: 3 }] },
      }),
    ).find((d) => d.code === "retry-churn");
    expect(f?.severity).toBe("info");
    expect(f?.evidence).toContain("Edit");
  });
  test("fires on the portfolio fallback of one retry per session", () => {
    expect(
      codes(
        signals({
          retries: {
            total: 30,
            sessions: 12,
            byTool: [{ tool: "Bash", retries: 10, sessions: 2 }],
          },
        }),
      ),
    ).toContain("retry-churn");
  });
  test("stays quiet one retry below the tool threshold", () => {
    expect(
      codes(
        signals({
          retries: { total: 19, sessions: 3, byTool: [{ tool: "Edit", retries: 19, sessions: 3 }] },
        }),
      ),
    ).not.toContain("retry-churn");
  });
});

describe("error-rate-rising", () => {
  /** 5 quiet weeks then 5 bad weeks; the newest is dropped as in-progress. */
  const rising = [...flatWeeks(5, 500, 5), ...flatWeeks(5, 500, 15)];
  test("fires when the last 4 full weeks run 1.5× the prior 4", () => {
    const f = buildPortfolioDiagnostics(signals({ errorWeekly: rising })).find(
      (d) => d.code === "error-rate-rising",
    );
    expect(f?.severity).toBe("warning");
    expect(f?.evidence).toContain("3.0%");
    expect(f?.evidence).toContain("1.0%");
  });
  test("stays quiet with fewer than 8 full weeks of history", () => {
    const short = [...flatWeeks(3, 500, 5), ...flatWeeks(5, 500, 15)];
    expect(codes(signals({ errorWeekly: short }))).not.toContain("error-rate-rising");
  });
  test("stays quiet below the per-window call volume", () => {
    const thin = [...flatWeeks(5, 40, 0), ...flatWeeks(5, 40, 4)];
    expect(codes(signals({ errorWeekly: thin }))).not.toContain("error-rate-rising");
  });
});

describe("spend-concentration", () => {
  test("fires at a 60% top-decile share over 20 sessions", () => {
    const f = buildPortfolioDiagnostics(signals({ distribution: { topDecileShare: 0.6 } })).find(
      (d) => d.code === "spend-concentration",
    );
    expect(f?.severity).toBe("info");
    expect(f?.evidence).toContain("60%");
  });
  test("stays quiet just below the share or session floor", () => {
    expect(codes(signals({ distribution: { topDecileShare: 0.59 } }))).not.toContain(
      "spend-concentration",
    );
    expect(codes(signals({ distribution: { topDecileShare: 0.7, sessions: 19 } }))).not.toContain(
      "spend-concentration",
    );
  });
});

describe("estimated-pricing-share", () => {
  test("fires at a quarter of spend on heuristic pricing", () => {
    const f = buildPortfolioDiagnostics(signals({ summary: { estimatedShare: 0.25 } })).find(
      (d) => d.code === "estimated-pricing-share",
    );
    expect(f?.severity).toBe("info");
    expect(f?.action).toContain("pricing update");
  });
  test("stays quiet just below", () => {
    expect(codes(signals({ summary: { estimatedShare: 0.24 } }))).not.toContain(
      "estimated-pricing-share",
    );
  });
});

describe("setup-debt", () => {
  test("fires when the audit carries a warning, naming the top one", () => {
    const f = buildPortfolioDiagnostics(
      signals({ audit: auditWith([{ title: 'MCP server "github" is configured but unused' }]) }),
    ).find((d) => d.code === "setup-debt");
    expect(f?.severity).toBe("info");
    expect(f?.evidence).toContain('"MCP server "github" is configured but unused"');
  });
  test("stays quiet without an audit or with info-only findings", () => {
    expect(codes(signals())).not.toContain("setup-debt");
    expect(
      codes(signals({ audit: auditWith([{ severity: "info", code: "unused-skill" }]) })),
    ).not.toContain("setup-debt");
  });
});

describe("sidechain-imbalance", () => {
  test("fires when subagents carry half the spend", () => {
    const f = buildPortfolioDiagnostics(signals({ sidechain: { cost: 50, share: 0.5 } })).find(
      (d) => d.code === "sidechain-imbalance",
    );
    expect(f?.severity).toBe("info");
    expect(f?.evidence).toContain("50%");
  });
  test("fires when subagents are never used across 50+ sessions", () => {
    const out = buildPortfolioDiagnostics(
      signals({ sidechain: { cost: 0, calls: 0, share: 0 }, summary: { sessions: 50 } }),
    );
    expect(out.filter((d) => d.code === "sidechain-imbalance")).toHaveLength(1);
    expect(out.find((d) => d.code === "sidechain-imbalance")?.title).toContain("never used");
  });
  test("only one side can fire, and small portfolios stay quiet", () => {
    const heavy = buildPortfolioDiagnostics(signals({ sidechain: { cost: 60, share: 0.6 } }));
    expect(heavy.filter((d) => d.code === "sidechain-imbalance")).toHaveLength(1);
    expect(
      codes(signals({ sidechain: { cost: 0, calls: 0, share: 0 }, summary: { sessions: 49 } })),
    ).not.toContain("sidechain-imbalance");
  });
});

/* ——— Ranking ————————————————————————————————————————————————————————— */

describe("parse-coverage-drop", () => {
  /** One version row, newest first (the rule only reads byVersion[0]). */
  const coverage = (over: Partial<ParseCoverageVersionRow> = {}) => {
    const row: ParseCoverageVersionRow = {
      version: "2.4.0",
      sessions: 40,
      lines: 200_000,
      parseErrors: 500,
      unknownEvents: 1_500,
      unparsedShare: 0.01,
      ...over,
    };
    return { summary: { ...row } as ParseCoverageSummary, byVersion: [row] };
  };

  test("fires on the newest version once the unparsed share clears 1%", () => {
    const out = buildPortfolioDiagnostics(signals({ parseCoverage: coverage() }));
    const f = out.find((d) => d.code === "parse-coverage-drop");
    expect(f?.severity).toBe("warning");
    expect(f?.evidence).toContain("2.4.0");
    expect(f?.evidence).toContain("1.0%");
    expect(f?.evidence).toContain("200,000");
    expect(f?.action).toContain("cc-analyzer update");
  });

  test("stays quiet just below the 1% share", () => {
    expect(codes(signals({ parseCoverage: coverage({ unparsedShare: 0.0099 }) }))).not.toContain(
      "parse-coverage-drop",
    );
  });

  test("stays quiet below the 10k-line volume floor", () => {
    expect(
      codes(signals({ parseCoverage: coverage({ lines: 9_999, unparsedShare: 0.5 }) })),
    ).not.toContain("parse-coverage-drop");
  });

  test("only the newest version is judged", () => {
    const newest: ParseCoverageVersionRow = {
      version: "2.4.0",
      sessions: 10,
      lines: 50_000,
      parseErrors: 0,
      unknownEvents: 0,
      unparsedShare: 0,
    };
    const old: ParseCoverageVersionRow = {
      version: "1.0.0",
      sessions: 10,
      lines: 50_000,
      parseErrors: 5_000,
      unknownEvents: 0,
      unparsedShare: 0.1,
    };
    expect(
      codes(
        signals({
          parseCoverage: {
            summary: { ...newest } as ParseCoverageSummary,
            byVersion: [newest, old],
          },
        }),
      ),
    ).not.toContain("parse-coverage-drop");
  });

  test("is safe when the signal is absent entirely", () => {
    expect(signals().parseCoverage).toBeUndefined();
    expect(codes(signals())).not.toContain("parse-coverage-drop");
    // …and with an empty index there is no version row to judge.
    expect(
      codes(
        signals({
          parseCoverage: {
            summary: {
              sessions: 0,
              lines: 0,
              parseErrors: 0,
              unknownEvents: 0,
              unparsedShare: 0,
            },
            byVersion: [],
          },
        }),
      ),
    ).not.toContain("parse-coverage-drop");
  });
});

describe("test-thrash-pattern", () => {
  test("fires at 3 thrashing sessions making 10% of test-running sessions", () => {
    const out = buildPortfolioDiagnostics(
      signals({
        tests: { runs: 100, sessions: 30 },
        thrash: { testThrashSessions: 3, worstTestFailStreak: 7 },
      }),
    );
    const f = out.find((d) => d.code === "test-thrash-pattern");
    expect(f?.severity).toBe("warning");
    expect(f?.evidence).toContain("3 sessions");
    expect(f?.evidence).toContain("worst streak: 7");
    expect(f?.evidence).toContain("10%");
    expect(f?.action).toContain("bisect");
  });

  test("stays quiet below 3 sessions", () => {
    expect(
      codes(
        signals({
          tests: { runs: 100, sessions: 10 },
          thrash: { testThrashSessions: 2, worstTestFailStreak: 9 },
        }),
      ),
    ).not.toContain("test-thrash-pattern");
  });

  test("the volume guard holds: 3 sessions out of 31+ testers stay quiet", () => {
    expect(
      codes(
        signals({
          tests: { runs: 500, sessions: 31 },
          thrash: { testThrashSessions: 3, worstTestFailStreak: 5 },
        }),
      ),
    ).not.toContain("test-thrash-pattern");
    // …and with no test-running sessions at all, nothing can fire.
    expect(
      codes(signals({ thrash: { testThrashSessions: 3, worstTestFailStreak: 5 } })),
    ).not.toContain("test-thrash-pattern");
  });
});

describe("reread-heavy", () => {
  test("fires at 200 redundant reads across 10 sessions and names the top file", () => {
    const out = buildPortfolioDiagnostics(
      signals({
        thrash: {
          redundantReads: 200,
          rereadSessions: 10,
          topRereadFiles: [{ file: "/p/one/schema.sql", sessions: 8 }],
        },
      }),
    );
    const f = out.find((d) => d.code === "reread-heavy");
    expect(f?.severity).toBe("info");
    expect(f?.evidence).toContain("200 redundant reads");
    expect(f?.evidence).toContain("/p/one/schema.sql");
    expect(f?.action).toContain("subagents");
  });

  test("stays quiet below either volume guard", () => {
    expect(codes(signals({ thrash: { redundantReads: 199, rereadSessions: 20 } }))).not.toContain(
      "reread-heavy",
    );
    expect(codes(signals({ thrash: { redundantReads: 500, rereadSessions: 9 } }))).not.toContain(
      "reread-heavy",
    );
  });
});

describe("correction-heavy", () => {
  test("fires at a 15% correction share over 200 turns, with the heuristic caveat", () => {
    const out = buildPortfolioDiagnostics(
      signals({
        corrections: {
          sessions: 12,
          correctionTurns: 30,
          interruptionTurns: 10,
          turns: 200,
          correctionShare: 0.15,
          interruptionShare: 0.05,
        },
      }),
    );
    const f = out.find((d) => d.code === "correction-heavy");
    expect(f?.severity).toBe("info");
    expect(f?.evidence).toContain("30 of 200 turns (15%)");
    expect(f?.evidence).toContain("12 sessions");
    expect(f?.evidence).toContain("5% of turns were interrupted");
    expect(f?.evidence).toContain("English-only");
    expect(f?.action).toContain("first prompts");
  });

  test("stays quiet below the share or the turn-volume floor", () => {
    expect(
      codes(
        signals({
          corrections: { correctionTurns: 29, turns: 200, correctionShare: 29 / 200 },
        }),
      ),
    ).not.toContain("correction-heavy");
    expect(
      codes(
        signals({
          corrections: { correctionTurns: 30, turns: 199, correctionShare: 30 / 199 },
        }),
      ),
    ).not.toContain("correction-heavy");
  });
});

describe("ranking", () => {
  test("warnings rank before infos, and dollar impact orders within severity", () => {
    const out = buildPortfolioDiagnostics(
      signals({
        // error-rate-rising: warning, no dollar impact.
        errorWeekly: [...flatWeeks(5, 500, 5), ...flatWeeks(5, 500, 15)],
        // cache-leaky + cache-waste-heavy: warnings with $12 of waste behind them.
        summary: { cacheWriteTokens: 1_000_000, cacheReadTokens: 500_000 },
        cacheSummary: { writeCost: 30, waste: 12 },
        // model-downshift ($25 saving) and spend-concentration ($0): infos.
        whatIfSummary: { bestCost: 75, bestDelta: -25 },
        distribution: { topDecileShare: 0.65 },
      }),
    );
    const outCodes = out.map((d) => d.code);
    // Severity partition: all warnings strictly before all infos.
    const firstInfo = out.findIndex((d) => d.severity === "info");
    expect(out.slice(0, firstInfo).every((d) => d.severity === "warning")).toBe(true);
    expect(out.slice(firstInfo).every((d) => d.severity === "info")).toBe(true);
    // Dollar-backed warnings outrank the dollar-less one.
    expect(outCodes.indexOf("cache-leaky")).toBeLessThan(outCodes.indexOf("error-rate-rising"));
    expect(outCodes.indexOf("cache-waste-heavy")).toBeLessThan(
      outCodes.indexOf("error-rate-rising"),
    );
    // Dollar-backed info outranks the dollar-less info.
    expect(outCodes.indexOf("model-downshift-opportunity")).toBeLessThan(
      outCodes.indexOf("spend-concentration"),
    );
  });
});
