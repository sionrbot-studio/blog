import process from 'node:process';
import { afterAll, vi } from 'vite-plus/test';

// setupFiles runs once per test file, even when the worker's modules are reused.
const cwd = process.cwd();
const env = process.env;
const envValues = { ...env };
const workerGlobal = globalThis;
// Initialize Node's lazy fetch runtime before recording its permanent globals.
void Response;
const globals = Object.getOwnPropertyDescriptors(workerGlobal);

afterAll(() => {
  vi.restoreAllMocks();
  vi.resetAllMocks();
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();

  process.env = env;
  for (const key of Object.keys(env)) {
    if (!Object.hasOwn(envValues, key)) delete env[key];
  }
  Object.assign(env, envValues);
  if (process.cwd() !== cwd) process.chdir(cwd);

  for (const key of Reflect.ownKeys(workerGlobal)) {
    if (!Object.hasOwn(globals, key) && !Reflect.deleteProperty(workerGlobal, key)) {
      throw new Error(`Test file installed a non-configurable global: ${String(key)}`);
    }
  }
  Object.defineProperties(workerGlobal, globals);
});
