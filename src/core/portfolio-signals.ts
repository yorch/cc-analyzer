/**
 * Assembles the plain-data `PortfolioSignals` object that the bun-free rules
 * engine in `portfolio-diagnostics.ts` folds into findings. One assembler so
 * the CLI (`cc-analyzer insights`), the web `/api/insights` route, and the TUI
 * insights screen feed the rules identical inputs — they cannot drift.
 *
 * Lives outside `stats.ts` because it also touches the filesystem (the setup
 * audit's inventory scan); "today" is pinned here, at the boundary, so the
 * rules module stays free of `Date.now()`.
 */

import type { Database } from "bun:sqlite";
import { scanInventory } from "./inventory.ts";
import type { PortfolioSignals } from "./portfolio-diagnostics.ts";
import type { PricingTable } from "./pricing.ts";
import { buildSetupAudit } from "./setup-audit.ts";
import {
  analyticsRollup,
  buildPortfolioStats,
  cacheSummary,
  cacheTtlSplit,
  cacheWasteByProject,
  compactionUsage,
  contextTax,
  errorRateByWeek,
  idleVsCache,
  localDayOfMs,
  whatIfRepricing,
} from "./stats.ts";

export interface AssembleSignalsOptions {
  /** Skip the setup-audit inventory scan (the only filesystem-touching input). */
  audit?: boolean;
}

/** Everything `buildPortfolioDiagnostics` needs, from the index + pricing. */
export function assemblePortfolioSignals(
  db: Database,
  pricing: PricingTable,
  opts: AssembleSignalsOptions = {},
): PortfolioSignals {
  const today = localDayOfMs(Date.now());
  const rollup = analyticsRollup(db);
  return {
    stats: buildPortfolioStats(db, today),
    rollup,
    cache: {
      summary: cacheSummary(db),
      ttl: cacheTtlSplit(db),
      idleBuckets: idleVsCache(db),
      projects: cacheWasteByProject(db),
    },
    compactions: compactionUsage(db),
    errorWeekly: errorRateByWeek(db),
    contextTax: contextTax(db),
    whatIf: whatIfRepricing(db, pricing),
    ...(opts.audit === false ? {} : { audit: buildSetupAudit(scanInventory(), rollup, today) }),
  };
}
