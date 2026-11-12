import { defineConfig } from 'vitest/config';

/** The packages' and plugins' tests; each app runs its own (`pnpm -r test`) with its Vite config. */
export default defineConfig({
  test: { exclude: ['**/node_modules/**', '**/dist/**', 'apps/**'] },
});
