import { defineConfig } from "vitest/config";
import { fileURLToPath, URL } from "node:url";

// 诊断算法是纯 TypeScript 逻辑，使用 node 环境即可，无需 jsdom。
export default defineConfig({
  test: {
    environment: "node",
    include: [
      "src/**/__tests__/**/*.test.ts",
      "src/**/*.test.ts",
      "scripts/**/__tests__/**/*.test.ts",
    ],
    globals: false,
  },
  resolve: {
    alias: {
      "@": fileURLToPath(new URL("./src", import.meta.url)),
    },
  },
});
