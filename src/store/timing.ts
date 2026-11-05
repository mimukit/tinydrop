// A ring of the last query times, and the percentile the Account screen shows.

export class TimeRing {
  private readonly times: number[] = [];

  constructor(private readonly size = 50) {}

  push(ms: number): void {
    this.times.push(ms);
    if (this.times.length > this.size) this.times.shift();
  }

  values(): number[] {
    return [...this.times];
  }
}

/** The nearest-rank percentile (p in 0..100) of a list, or undefined for an empty list. */
export function percentile(values: number[], p: number): number | undefined {
  if (values.length === 0) return undefined;
  const sorted = [...values].sort((a, b) => a - b);
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}
