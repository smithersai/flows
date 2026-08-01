import { defineConfig } from "vitest/config"

export default defineConfig({
  test: {
    environment: "node",
    coverage: {
      enabled: true,
      provider: "v8",
      include: ["src/**"],
      thresholds: { branches: 100, functions: 100, lines: 100, statements: 100 }
    }
  }
})
