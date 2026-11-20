import { defineConfig } from 'vitest/config';
export default defineConfig({
  // setup.ts gives each test file its own temp folder and removes it afterwards.
  // expect.poll waits up to 15 s, not Vitest's 1 s: a poll for a background step (the mail outbox, the worker)
  // passes the moment it holds, and on a loaded Mac 1 s was too short (2026-11-12, invitations.test.ts).
  test: { include: ['tests/*.test.ts'], setupFiles: ['tests/setup.ts'], testTimeout: 120_000, hookTimeout: 120_000, expect: { poll: { timeout: 15_000 } } },
});
