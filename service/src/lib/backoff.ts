/** Exponential back-off: baseMs for attempt 0, then x2 per attempt, capped at maxMs. */
export function backoffMs(attempt: number, baseMs: number, maxMs: number): number {
  return Math.min(maxMs, baseMs * 2 ** Math.min(30, Math.max(0, attempt)));
}
