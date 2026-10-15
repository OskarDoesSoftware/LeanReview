import { defineConfig } from "@playwright/test";
export default defineConfig({
  testDir: "./tests/browser-java",
  workers: 1,
  timeout: 60000,
  use: {
    baseURL: "http://127.0.0.1:4324",
    viewport: { width: 1440, height: 1000 },
    screenshot: "only-on-failure",
    trace: "retain-on-failure",
  },
  webServer: {
    command: "node tests/java-browser-server.mjs",
    url: "http://127.0.0.1:4324",
    reuseExistingServer: false,
    timeout: 60000,
  },
});
