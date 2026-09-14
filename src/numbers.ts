/**
 * Numeric helpers where JavaScript and Python disagree.
 *
 * One function so far, and it earns a file because both the cost calculation and
 * the usage dashboard need it and neither should own it.
 */

/**
 * Python's `round(x, 6)`, which breaks a tie to the even digit.
 *
 * `toFixed` and the multiply-round-divide idiom both round half away from zero,
 * so a value landing exactly on a half at the sixth decimal comes out one unit in
 * the last place above what the Python side produces. These numbers are costs,
 * and they are summed into a per-org rolling budget and a platform daily cap, so
 * the difference does not stay in the last place.
 */
export function round6(value: number): number {
  const scaled = value * 1e6
  const floor = Math.floor(scaled)
  const diff = scaled - floor
  if (diff > 0.5) return (floor + 1) / 1e6
  if (diff < 0.5) return floor / 1e6
  return (floor % 2 === 0 ? floor : floor + 1) / 1e6
}
