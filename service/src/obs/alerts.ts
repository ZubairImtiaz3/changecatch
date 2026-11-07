// Throttle for repeated alerts, shared by the processes. Alert names: obs/log.ts ALERTS.

/**
 * Throttle for an alert that stays true for a while (per key, e.g. a portal id): the first fire() goes out, then at
 * most one every repeatMs while it keeps firing. clear() ends it and says whether it was active (to log "cleared").
 * In memory: after a restart the first fire() goes out again.
 */
export class AlertThrottle<K = string | number> {
  private readonly lastAt = new Map<K, number>();
  constructor(private readonly repeatMs: number) {}

  /** true = send the alert now. */
  fire(key: K, now: number): boolean {
    const last = this.lastAt.get(key);
    if (last !== undefined && now - last < this.repeatMs) return false;
    this.lastAt.set(key, now);
    return true;
  }

  /** Forget `key`. true if an alert for it had gone out (the caller may log alertCleared). */
  clear(key: K): boolean {
    return this.lastAt.delete(key);
  }
}
