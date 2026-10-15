import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

test("React reviews migrated and Java-created snapshots and persists manual edits", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const { root, link, providerOrigin } = JSON.parse(
    await readFile(".leanreview-test/java-browser-fixture.json", "utf8"),
  );
  await page.goto(link);
  await expect(
    page.getByRole("combobox", { name: "Saved reviews" }),
  ).toBeVisible();
  await page
    .getByRole("combobox", { name: "Saved reviews" })
    .selectOption("session-fixture");
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await page.getByRole("textbox", { name: "Repository root" }).fill(root);
  await page
    .getByRole("combobox", { name: "Comparison mode" })
    .selectOption("all");
  const created = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sessions" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /Open (review|comparison)/ }).click();
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
    page.getByText("Analysis proposal ready", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Accept proposal", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "AI fixture", exact: true }),
  ).toBeVisible();
  await expect(page.locator(".progress-summary")).toContainText(
    "1 / 2 reviewed",
  );
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
    page.getByRole("heading", { name: "Manual review", exact: true }),
  ).toBeVisible();
  page.once("dialog", (dialog) => dialog.accept("Manual edits"));
  await page
    .getByRole("button", { name: "Rename Manual review", exact: true })
    .click();
  await expect(
    page.getByRole("heading", { name: "Manual edits", exact: true }),
  ).toBeVisible();
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
