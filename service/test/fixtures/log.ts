// In-memory logger for tests.

import { Logger, type LogLevel, type LogRecord } from '../../src/obs/log.js';

/** A logger that collects records in memory. */
export function memoryLogger(component = 'test', level: LogLevel = 'debug'): { log: Logger; records: LogRecord[]; lines: string[] } {
  const records: LogRecord[] = [];
  const lines: string[] = [];
  const log = new Logger(component, {}, { level, format: 'json', sink: (r, l) => (records.push(r), lines.push(l)) });
  return { log, records, lines };
}

/** Messages of the alert records (event "alert"), optionally only alert `name`. */
export const alertsOf = (records: LogRecord[], name?: string): string[] =>
  records.filter((r) => r.event === 'alert' && (name === undefined || r.alert === name)).map((r) => r.msg);
