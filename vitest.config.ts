import { defineConfig } from 'vitest/config';
import { fileURLToPath } from 'node:url';

export default defineConfig({
  test: {
    include: ['tests/**/*.test.ts'],
    environment: 'node',
    // Evidence-writing and browser tests touch the filesystem and a real browser;
    // they are slow but few. Unit tests dominate and stay fast.
    testTimeout: 30_000,
    hookTimeout: 30_000,
    /**
     * Test *files* run one at a time.
     *
     * Four of them drive a real Chromium against a real server. Run in
     * parallel on one machine they contend for CPU, and the browser work
     * starts missing timing windows - the discovery end-to-end test passed
     * five times out of five alone and failed roughly half the time alongside
     * the others. A test that depends on how busy the laptop is tells you
     * nothing, and a suite you learn to re-run is a suite you stop believing.
     *
     * Within a file, tests still run in order and share one browser, so the
     * cost is small: the browser-driven files dominate the wall clock either
     * way.
     */
    fileParallelism: false,
  },
  resolve: {
    alias: { '@': fileURLToPath(new URL('./src', import.meta.url)) },
  },
});
