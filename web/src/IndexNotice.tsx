import { INDEX_AGE_WARNING_MS, type IndexStatus } from "../../src/core/index-status-types.ts";

function refreshedLabel(value: string | null): string {
  if (!value) return "unknown";
  return new Intl.DateTimeFormat(undefined, {
    dateStyle: "medium",
    timeStyle: "short",
  }).format(new Date(value));
}

export function IndexNotice({ status }: { status: IndexStatus | null }) {
  if (!status) return null;
  const old = status.lastRefreshedAt === null || (status.ageMs ?? 0) >= INDEX_AGE_WARNING_MS;
  if (!status.stale && !old) return null;

  return (
    <aside className="index-notice" role="status" aria-live="polite">
      <span className="index-notice-mark" aria-hidden="true">
        ◇
      </span>
      <div>
        <strong>
          {status.stale ? "New ledger activity detected" : "Index refresh recommended"}
        </strong>
        <p>
          {status.stale
            ? `${status.added} new · ${status.changed} changed · ${status.deleted} deleted sessions`
            : `Last refreshed ${refreshedLabel(status.lastRefreshedAt)}`}
          {" · "}
          restart with <code>cc-analyzer serve --refresh</code>
        </p>
      </div>
    </aside>
  );
}

export function IndexFreshness({ status }: { status: IndexStatus | null }) {
  if (!status) return null;
  return (
    <span className="index-freshness">
      index ·{" "}
      {status.stale ? "updates available" : `refreshed ${refreshedLabel(status.lastRefreshedAt)}`}
    </span>
  );
}
