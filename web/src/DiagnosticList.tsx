import type { ReactNode } from "react";

/**
 * The shape every findings surface shares — session diagnostics, portfolio
 * insights, and setup-audit findings all follow the `session-diagnostics.ts`
 * house style, so they render through one component with identical markup.
 */
interface DiagnosticLike {
  severity: "info" | "warning";
  title: string;
  evidence: string;
  action: string;
}

/**
 * Findings as a list of cards: severity-tinted, evidence above the next action.
 * `extra` renders between the two — the portfolio view uses it for the link to
 * a finding's project; the other surfaces pass nothing.
 */
export function DiagnosticList<T extends DiagnosticLike>({
  items,
  keyOf,
  extra,
}: {
  items: T[];
  keyOf: (item: T) => string;
  extra?: (item: T) => ReactNode;
}) {
  return (
    <div className="diagnostic-list">
      {items.map((item) => (
        <article className={`diagnostic diagnostic-${item.severity}`} key={keyOf(item)}>
          <h3>{item.title}</h3>
          <p>{item.evidence}</p>
          {extra?.(item)}
          <p className="muted">
            <strong>Next:</strong> {item.action}
          </p>
        </article>
      ))}
    </div>
  );
}
