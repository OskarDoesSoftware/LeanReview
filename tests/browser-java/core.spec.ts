import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

test("React reviews migrated and Java-created snapshots and persists manual edits", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.open = () => null;
  });
  const { root, link, providerOrigin } = JSON.parse(
    await readFile(".leanreview-test/java-browser-fixture.json", "utf8"),
  );
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Saved reviews" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Saved reviews" })
    .selectOption("session-fixture");
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await page
    .getByRole("button", { name: "Choose repository", exact: true })
    .click();
  await page.getByRole("textbox", { name: "Local repository path" }).fill(root);
  await page
    .getByRole("combobox", { name: "Local comparison" })
    .selectOption("all");
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sessions" &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Open local changes", exact: true })
    .click();
  const response = await created;
  expect(response.ok()).toBe(true);
  const review = await response.json();
  const session = review.snapshot.sessionId;
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await page
    .getByRole("button", { name: "Mark file reviewed", exact: true })
    .click();
  await expect(page.locator(".progress-summary")).toContainText(
    "1 / 2 reviewed",
  );
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Saved reviews" }),
  ).toHaveValue(session);
  await expect(page.locator(".progress-summary")).toContainText(
    "1 / 2 reviewed",
  );
  await page.getByRole("button", { name: /first.ts/ }).click();
  await page
    .locator(".monaco-diff-editor .editor.modified .line-numbers")
    .filter({ hasText: /^1$/ })
    .click();
  const configured = await page.request.post("/api/provider", {
    headers: { Origin: "http://127.0.0.1:4324" },
    data: {
      config: {
        provider: "ollama",
        endpoint: providerOrigin,
        model: "fixture-java-model",
        contextWindow: 8192,
        maxOutput: 2048,
        localOnly: true,
      },
      persist: false,
    },
  });
  expect(configured.ok()).toBe(true);
  await page
    .getByRole("button", { name: "Generate AI proposal", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Confirm analysis input" }),
  ).toContainText("fixture-java-model");
  await page
    .getByRole("button", { name: "Authorize & analyze", exact: true })
    .click();

  await expect(
    page.getByRole("heading", { name: "AI fixture", exact: true, level: 3 }),
  ).toBeVisible();
  await expect(page.locator(".progress-summary")).toContainText(
    "1 / 2 reviewed",
  );
  await page
    .getByRole("button", { name: /^(Settings|AI settings)$/, exact: true })
    .click();
  const settings = page.getByRole("dialog", {
    name: /^(Settings|AI settings|AI provider settings)$/,
  });
  await settings
    .getByRole("combobox", { name: "Provider", exact: true })
    .selectOption("codex");
  await expect(
    settings.getByText("Not signed in", { exact: true }),
  ).toBeVisible();
  await expect(settings.getByRole("textbox", { name: "API key" })).toHaveCount(
    0,
  );
  await settings
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  await expect(
    settings.getByRole("link", { name: "Continue sign-in in your browser" }),
  ).toBeVisible();
  await settings.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(
    settings.getByText("Not signed in", { exact: true }),
  ).toBeVisible();
  await settings
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  await expect(settings.getByRole("status")).toContainText(
    "Connected as reviewer@example.invalid",
    { timeout: 10000 },
  );
  await expect(
    settings.getByRole("combobox", { name: "Model", exact: true }),
  ).toHaveValue("fixture-codex");
  await settings.getByRole("button", { name: "Save configuration" }).click();
  await page
    .getByRole("button", { name: "Generate AI proposal", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Confirm analysis input" }),
  ).toContainText("fixture-codex");
  await page
    .getByRole("button", { name: "Authorize & analyze", exact: true })
    .click();

  await expect(
    page.getByRole("heading", { name: "Feature", exact: true, level: 3 }),
  ).toBeVisible();
  await expect(page.locator(".progress-summary")).toContainText(
    "1 / 2 reviewed",
  );
  await page
    .getByRole("button", { name: /^(Settings|AI settings)$/, exact: true })
    .click();
  await settings
    .getByRole("button", { name: "Sign out of LeanReview" })
    .click();
  await expect(
    settings.getByText("Not signed in", { exact: true }),
  ).toBeVisible();
  await page.keyboard.press("Escape");
  const grouping = await page.request.post(
    `/api/sessions/${session}/grouping`,
    {
      headers: { Origin: "http://127.0.0.1:4324" },
      data: {
        snapshotId: review.snapshot.id,
        analysis: {
          cohorts: [
            {
              name: "Manual review",
              explanation: "Browser acceptance",
              layers: [
                {
                  name: "Changes",
                  explanation: "Both files",
                  fileIds: review.snapshot.files.map(
                    (file: { id: string }) => file.id,
                  ),
                },
              ],
            },
          ],
          findings: [],
        },
      },
    },
  );
  expect(grouping.ok()).toBe(true);
  await page.reload();
  await expect(
    page.getByRole("heading", { name: "Manual review", exact: true, level: 3 }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept("Manual edits"));
  await page
    .getByRole("button", { name: "Rename Manual review", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Manual edits", exact: true, level: 3 }),
  ).toBeVisible();
  await page.goto(`/assets/java-analysis/analysis.html?session=${session}`);
  await expect(
    page.getByRole("heading", { name: "Java analysis acceptance" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Repository graph", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Scan pinned sources", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Rescan pinned sources", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".react-flow__node").first()).toBeVisible();
  await page.getByRole("button", { name: "Close graph", exact: true }).click();
  const base = `/api/sessions/${session}/coverage`;
  const headers = { Origin: "http://127.0.0.1:4324" };
  const report = {
    "first.ts": {
      statementMap: {
        "0": { start: { line: 1, column: 34 }, end: { line: 1, column: 49 } },
        "1": { start: { line: 1, column: 50 }, end: { line: 1, column: 59 } },
      },
      s: { "0": 1, "1": 0 },
    },
  };
  const configuredTests = await page.request.post(base + "/config", {
    headers,
    data: {
      snapshotId: review.snapshot.id,
      config: {
        format: "istanbul",
        cwd: ".",
        reportPath: "coverage.json",
        timeoutSeconds: 30,
        threshold: 8,
        steps: [
          {
            executable: process.execPath,
            args: [
              "-e",
              `require('node:fs').writeFileSync('coverage.json', ${JSON.stringify(JSON.stringify(report))})`,
            ],
            shell: false,
          },
        ],
      },
    },
  });
  expect(configuredTests.ok()).toBe(true);
  await page.reload();
  await expect(page.locator(".function-metric")).toContainText("first");
  await page
    .getByRole("button", { name: "Run tests & coverage", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Run tests and measure coverage?" }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Confirm & run tests", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Test run · succeeded", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".function-metric")).toContainText("first");
  const artifact = await page.request.get(base + "/artifact?format=istanbul");
  expect(artifact.ok()).toBe(true);
  expect(JSON.parse((await artifact.json()).report)).toEqual(report);
  await page.goto("/");
  await expect(
    page.getByRole("combobox", { name: "Saved reviews" }),
  ).toHaveValue(session);
  await writeFile(path.join(root, "first.ts"), "export const first = 3;\n");
  const refreshed = page.waitForResponse((response) =>
    new URL(response.url()).pathname.endsWith("/refresh"),
  );
  await page
    .getByRole("button", { name: "Refresh snapshot", exact: true })
    .click();
  expect((await refreshed).ok()).toBe(true);
  const history = page.getByRole("combobox", { name: "Snapshot history" });
  await history.selectOption(review.snapshot.id);
  await expect(page.getByText("Previous snapshot · read only")).toBeVisible();
  await expect(
    page.getByRole("button", {
      name: /^(Mark file reviewed|Reviewed · undo)$/,
    }),
  ).toBeDisabled();
  await page.screenshot({
    path: ".leanreview-test/java-core-review.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});
