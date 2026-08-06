import type { ReactNode } from "react";

/** A stat card: big value, small label, optional context line. The context
 *  line takes nodes so a card can colour a delta without a second component. */
export function Card({ label, value, sub }: { label: string; value: string; sub?: ReactNode }) {
  return (
    <div className="card">
      <div className="label">{label}</div>
      <div className="value">{value}</div>
      {sub && <div className="sub">{sub}</div>}
    </div>
  );
}
