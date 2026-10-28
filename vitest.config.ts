import { defineConfig } from 'vitest/config';

// Backend and concurrency behavior are verified by Go tests.
export default defineConfig({ test: { include: ['tests/**/*.test.ts'] } });
