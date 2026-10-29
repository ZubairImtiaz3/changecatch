// Runs the app server (PORT, e.g. 3001) and the worker (health on WORKER_HEALTH_PORT, 3002) together, for local E2E.
//   npx tsx src/cli/dev.ts [--no-lifecycle]   (from service/)
// Each line is prefixed with [app] or [worker]. Ctrl+C stops both. On Windows the children are killed at once
// (no graceful batch finish); that is safe: an unfinished batch's offset is not saved and is simply re-read.
// If one process exits, the other is stopped too. Both read the same .env and the same DB_PATH.
// Logs: the children write JSON lines by default; here LOG_FORMAT defaults to "pretty" so they are readable
// (set LOG_FORMAT=json to see exactly what production writes). Redaction is the same in both formats.
import { spawn, type ChildProcess } from 'node:child_process';
import { fileURLToPath } from 'node:url';

// Paths are resolved from this file, so it works from any cwd (repo root or service/).
const srcDir = fileURLToPath(new URL('..', import.meta.url));

const childEnv: NodeJS.ProcessEnv = { ...process.env, LOG_FORMAT: process.env.LOG_FORMAT || 'pretty' };
const extraAppArgs = process.argv.includes('--no-lifecycle') ? ['--no-lifecycle'] : [];
const procs: { name: string; child: ChildProcess }[] = [];
let stopping = false;

function start(name: string, script: string, args: string[] = []): void {
  // process.execPath + tsx's loader: no shell, works the same on Windows and Unix.
  const child = spawn(process.execPath, ['--import', 'tsx', script, ...args], { stdio: ['ignore', 'pipe', 'pipe'], env: childEnv });
  const pipe = (stream: NodeJS.ReadableStream | null, out: NodeJS.WriteStream) => {
    let buf = '';
    stream?.setEncoding('utf8');
    stream?.on('data', (chunk: string) => {
      buf += chunk;
      const lines = buf.split(/\r?\n/);
      buf = lines.pop() ?? '';
      for (const l of lines) out.write(`[${name}] ${l}\n`);
    });
    stream?.on('end', () => buf && out.write(`[${name}] ${buf}\n`));
  };
  pipe(child.stdout, process.stdout);
  pipe(child.stderr, process.stderr);
  child.on('exit', (code, signal) => {
    console.log(`[dev] ${name} exited (${signal ?? code})`);
    stopAll();
  });
  procs.push({ name, child });
}

function stopAll(): void {
  if (stopping) return;
  stopping = true;
  for (const { child } of procs) if (child.exitCode === null) child.kill('SIGINT');
  // Force after 30 s (the worker may be mid-batch).
  setTimeout(() => {
    for (const { child } of procs) if (child.exitCode === null) child.kill('SIGKILL');
    process.exit(1);
  }, 30_000).unref();
}

process.on('SIGINT', stopAll);
process.on('SIGTERM', stopAll);

start('app', `${srcDir}api/main.ts`, extraAppArgs);
start('worker', `${srcDir}worker/main.ts`);
