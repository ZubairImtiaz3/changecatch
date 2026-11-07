// Loaded before every test file (package.json "test": --import): the process-wide setup that each entry point does
// with startProcess (lib/process.ts). getRateLimiter throws without it.
import { configureHttp } from '../src/lib/http.js';

configureHttp({});
