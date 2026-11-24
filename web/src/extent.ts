/** Spread-free max/min: `Math.max(...arr)` throws a RangeError once `arr` runs
 *  past the engine's argument limit (~100k+), which long sessions and daily
 *  series can reach. `floor`/`ceil` seed the fold, mirroring the old
 *  `Math.max(...values, floor)` call shape. */
export function maxOf(values: readonly number[], floor = Number.NEGATIVE_INFINITY): number {
  let max = floor;
  for (const v of values) if (v > max) max = v;
  return max;
}

export function minOf(values: readonly number[], ceil = Number.POSITIVE_INFINITY): number {
  let min = ceil;
  for (const v of values) if (v < min) min = v;
  return min;
}
