import { defineConfig } from 'vitest/config';

export default defineConfig({
  // The live-server tests play bots; their per-move pause is for spectators, not tests.
  test: { include: ['test/**/*.test.ts'], testTimeout: 60000, env: { RISK_BOT_DELAY_MS: '0' } },
});
