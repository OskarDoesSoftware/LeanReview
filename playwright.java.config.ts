import { defineConfig } from "@playwright/test";
export default defineConfig({
  globalSetup: "./tests/java-browser-setup.mjs",
  testDir: "./tests/browser-java",
  workers: 1,
  timeout: 60000,
  use: {
    storageState: ".leanreview-test/java-browser-storage.json",
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
