import { afterAll, vi } from 'vite-plus/test';

// setupFiles runs once per test file, even when the worker's modules are reused.
afterAll(() => {
  vi.useRealTimers();
  vi.unstubAllEnvs();
  vi.unstubAllGlobals();
  vi.restoreAllMocks();
  vi.resetAllMocks();
});
