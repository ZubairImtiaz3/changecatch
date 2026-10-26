// End-to-end latency of stamps: HubSpot occurredAt -> our CRM batch update accepted.
// In memory only (per worker process); /health shows p50/p95 over the most recent samples.

export interface LatencyStats {
  /** Samples in the window (most recent `capacity` stamps). */
  count: number;
  p50Ms: number | null;
  p95Ms: number | null;
  maxMs: number | null;
  lastMs: number | null;
  /** Total stamps measured since the worker started. */
  totalSamples: number;
}

/** Nearest-rank percentile of a sorted array. */
export function percentile(sorted: number[], p: number): number | null {
  if (sorted.length === 0) return null;
  const rank = Math.ceil((p / 100) * sorted.length);
  return sorted[Math.min(sorted.length, Math.max(1, rank)) - 1];
}

export class LatencyTracker {
  private readonly buf: number[] = [];
  private next = 0;
  private total = 0;
  private last: number | null = null;

  constructor(private readonly capacity = 1000) {}

  record(ms: number): void {
    const v = Math.max(0, ms);
    if (this.buf.length < this.capacity) this.buf.push(v);
    else this.buf[this.next] = v;
    this.next = (this.next + 1) % this.capacity;
    this.total++;
    this.last = v;
  }

  stats(): LatencyStats {
    const sorted = [...this.buf].sort((a, b) => a - b);
    return {
      count: sorted.length,
      p50Ms: percentile(sorted, 50),
      p95Ms: percentile(sorted, 95),
      maxMs: sorted.length ? sorted[sorted.length - 1] : null,
      lastMs: this.last,
      totalSamples: this.total,
    };
  }
}
