// Process-wide setup, once at the start of each entry point (api/main.ts, worker/main.ts, the tools), in this order:
// log level/format, crash reporting to `log`, then the shared HubSpot rate limiter and HTTP metrics.

import type { Config } from './config.js';
import { configureHttp, type HttpMetrics } from './http.js';
import { installProcessHandlers } from '../obs/errors.js';
import { configureLogging, type Logger } from '../obs/log.js';

export function startProcess(
  config: Pick<Config, 'log' | 'portalRatePer10s'>,
  o: { log: Logger; metrics?: HttpMetrics },
): void {
  configureLogging(config.log);
  installProcessHandlers(o.log.child({ component: 'errors' }));
  configureHttp({ portalRatePer10s: config.portalRatePer10s, metrics: o.metrics ?? null, log: o.log });
}
