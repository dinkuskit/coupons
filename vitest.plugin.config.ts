import { emdashPluginTest } from "@emdash-cms/plugin-test/config";
import { defineConfig } from "vitest/config";

// Builds the Coupons admin plugin and runs it in EmDash's own sandbox runner.
export default defineConfig({
  plugins: [emdashPluginTest({ dir: "plugins/coupons-admin" })],
  test: { include: ["tests/plugin/*.test.ts"], maxWorkers: 1 },
});
