import { verifyWelcome, verifyWorkspace } from "../ui-checks";
import { test, expect } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";
test("review a captured Git diff, accept AI proposal, persist progress, and refresh safely", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (e) => errors.push(e.message));
  const { root } = JSON.parse(
    await readFile(".leanreview-test/browser-fixture.json", "utf8"),
  );
  await page.goto("/#bootstrap=browser-fixture-nonce");
  await verifyWelcome(page);
  await page.getByRole("textbox", { name: "Repository root" }).fill(root);
  await page
    .getByRole("combobox", { name: "Comparison mode" })
    .selectOption("staged");
  const openStaged = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sessions" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /Open (review|comparison)/ }).click();
  expect((await openStaged).ok()).toBe(true);
  await expect(
    page.getByRole("heading", { name: "identity-service" }),
  ).toBeVisible();
  const stagedSessions = await (await page.request.get("/api/sessions")).json();
  await page.reload();
  await expect(
    page.getByRole("combobox", { name: "Saved reviews" }),
  ).toHaveValue(stagedSessions[0].id);
  await expect(
    page.getByRole("combobox", { name: "Comparison mode" }),
  ).toHaveValue("staged");
  await page
    .getByRole("combobox", { name: "Comparison mode" })
    .selectOption("all");
  const openAll = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname === "/api/sessions" &&
      response.request().method() === "POST",
  );
  await page.getByRole("button", { name: /Open (review|comparison)/ }).click();
  const opened = await openAll;
  expect(opened.ok()).toBe(true);
  expect((await opened.json()).snapshot.comparison.mode).toBe("all");
  await expect(
    page.getByRole("heading", { name: "identity-service" }),
  ).toBeVisible();
  await expect(
    page.getByText("2 CHANGED FILES", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await verifyWorkspace(page);
  await page
    .getByRole("button", { name: "Mark file reviewed", exact: true })
    .click();
  await expect(page.locator(".progress-summary")).toContainText(
    "1 / 2 reviewed",
  );
  await expect(page.locator(".file-heading strong")).toHaveText(
    "src/auth/types.ts",
  );
  await page.reload();
  await expect(page.locator(".file-heading strong")).toHaveText(
    "src/auth/types.ts",
  );
  await expect(page.locator(".progress-summary")).toContainText(
    "1 / 2 reviewed",
  );
  await page.getByRole("button", { name: /validatePassword.ts/ }).click();
  await page
    .locator(".monaco-diff-editor .editor.modified .line-numbers")
    .filter({ hasText: /^2$/ })
    .click();
  await page
    .getByRole("button", { name: "Open in editor", exact: true })
    .click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page.getByRole("button", { name: "Generate AI proposal" }).click();
  await expect(
    page.getByRole("dialog", { name: "Confirm analysis input" }),
  ).toContainText("fixture-model");
  await page.getByRole("button", { name: "Authorize & analyze" }).click();

  await expect(page.locator(".cohort-sidebar")).toContainText("Authentication");
  await expect(page.locator(".progress-summary")).toContainText(
    "1 / 2 reviewed",
  );
  await expect(
    page.getByRole("region", { name: "Suggested review route" }),
  ).toContainText("Continue");
  await page
    .getByRole("button", { name: "Continue review", exact: true })
    .click();
  await expect(
    page.getByRole("complementary", { name: "AI review guide" }),
  ).toContainText("WHY THESE FILES BELONG TOGETHER");
  await expect(
    page.getByRole("list", { name: "Files in this review step" }),
  ).toBeVisible();
  // Reviewing the last unreviewed file keeps it open; undo stays on that file.
  const lastFile = await page.locator(".file-heading strong").textContent();
  await page
    .getByRole("button", { name: "Mark file reviewed", exact: true })
    .click();
  await expect(
    page.getByRole("region", { name: "Suggested review route" }),
  ).toContainText("All files reviewed");
  await expect(page.locator(".file-heading strong")).toHaveText(lastFile!);
  await page
    .getByRole("button", { name: "Reviewed · undo", exact: true })
    .click();
  await expect(page.locator(".file-heading strong")).toHaveText(lastFile!);
  // Reset the first file, then marking it should open the next suggested file.
  await page
    .getByRole("button", { name: /validatePassword.ts/ })
    .first()
    .click();
  await page
    .getByRole("button", { name: "Reviewed · undo", exact: true })
    .click();
  await page
    .getByRole("button", { name: "Mark file reviewed", exact: true })
    .click();
  await expect(page.locator(".file-heading strong")).toHaveText(
    "src/auth/types.ts",
  );
  const session = await page.request.get("/api/sessions");
  const sessions = await session.json();
  await page.reload();
  await page
    .getByRole("combobox", { name: "Saved reviews" })
    .selectOption(sessions[0].id);
  await expect(page.locator(".cohort-sidebar")).toContainText("Authentication");
  await expect(page.locator(".progress-summary")).toContainText(
    "1 / 2 reviewed",
  );
  await page.getByRole("button", { name: "Unified", exact: true }).click();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await page.screenshot({
    path: ".leanreview-test/review-workspace.png",
    fullPage: true,
  });
  await writeFile(
    path.join(root, "src/auth/validatePassword.ts"),
    "export const changedAgain = true;\n",
  );
  const refreshed = page.waitForResponse(
    (response) =>
      new URL(response.url()).pathname.endsWith("/refresh") &&
      response.request().method() === "POST",
  );
  await page
    .getByRole("button", { name: "Refresh snapshot", exact: true })
    .click();
  expect((await refreshed).ok()).toBe(true);
  await expect(page.locator(".progress-summary")).toContainText(
    "0 / 2 reviewed",
  );
  await expect(page.locator(".cohort-sidebar")).toContainText("Authentication");
  await expect(
    page.getByRole("region", { name: "Suggested review route" }),
  ).toContainText("Cohorts kept from the previous snapshot");
  const history = page.getByRole("combobox", { name: "Snapshot history" });
  const oldValue = await history.locator("option").nth(1).getAttribute("value");
  await history.selectOption(oldValue!);
  await expect(page.getByText("Previous snapshot · read only")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate AI proposal" }),
  ).toBeDisabled();

  // Return an analysis poll after the user has selected a historical snapshot.
  const currentValue = await history
    .locator("option")
    .nth(0)
    .getAttribute("value");
  await page
    .getByRole("button", { name: "Return to current snapshot", exact: true })
    .click();
  await expect(history).toHaveValue(currentValue!);
  await expect(
    page.getByRole("region", { name: "Previous snapshot guidance" }),
  ).toHaveCount(0);
  await history.selectOption(oldValue!);
  await expect(
    page.getByRole("region", { name: "Previous snapshot guidance" }),
  ).toBeVisible();
  const selectedSession = await page
    .getByRole("combobox", { name: "Saved reviews" })
    .inputValue();
  const captured = await (
    await page.request.get(`/api/sessions/${selectedSession}`)
  ).json();
  let requests = 0;
  let releasePoll!: () => void;
  let pollStarted!: () => void;
  const started = new Promise<void>((resolve) => {
    pollStarted = resolve;
  });
  const release = new Promise<void>((resolve) => {
    releasePoll = resolve;
  });
  await page.route(
    (url) =>
      url.pathname === `/api/sessions/${selectedSession}` &&
      url.searchParams.get("snapshot") === currentValue,
    async (route) => {
      ++requests;
      if (requests > 1) {
        pollStarted();
        await release;
      }
      await route.fulfill({
        json: {
          ...captured,
          state: {
            ...captured.state,
            analysisStatus: requests === 1 ? "running" : "ready",
          },
        },
      });
    },
  );
  await history.selectOption(currentValue!);
  await expect(
    page.getByText("Previous snapshot · read only"),
  ).not.toBeVisible();
  await started;
  await history.selectOption(oldValue!);
  await expect(page.getByText("Previous snapshot · read only")).toBeVisible();
  const pollResponse = page.waitForResponse((response) => {
    const url = new URL(response.url());
    return (
      url.pathname === `/api/sessions/${selectedSession}` &&
      url.searchParams.get("snapshot") === currentValue
    );
  });
  releasePoll();
  await pollResponse;
  await page.evaluate(
    () =>
      new Promise<void>((resolve) =>
        requestAnimationFrame(() => requestAnimationFrame(() => resolve())),
      ),
  );
  await expect(history).toHaveValue(oldValue!);
  await expect(page.getByText("Previous snapshot · read only")).toBeVisible();
  expect(errors).toEqual([]);
});
