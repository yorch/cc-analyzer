/** The one inline magnitude bar (`.bar` in styles.css, all colors from tokens).
 *  Decorative: the number it encodes always sits in an adjacent cell, so it is
 *  hidden from assistive tech. `value / max` is clamped to 0–100%. */
export function MiniBar({ value, max }: { value: number; max: number }) {
  const share = max > 0 && Number.isFinite(value) ? Math.min(1, Math.max(0, value / max)) : 0;
  return (
    <div className="bar" aria-hidden="true">
      <span style={{ width: `${share * 100}%` }} />
    </div>
  );
}
