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
  await page.getByRole("textbox", { name: "Repository root" }).fill(root);
  await page
    .getByRole("combobox", { name: "Comparison mode" })
    .selectOption("staged");
  await page.getByRole("button", { name: /Open (review|comparison)/ }).click();
  await expect(
    page.getByRole("heading", { name: "identity-service" }),
  ).toBeVisible();
  const stagedSessions = await (await page.request.get("/api/sessions")).json();
  await page.reload();
  await page
    .getByRole("combobox", { name: "Saved reviews" })
    .selectOption(stagedSessions[0].id);
  await expect(
    page.getByRole("combobox", { name: "Comparison mode" }),
  ).toHaveValue("staged");
  await page
    .getByRole("combobox", { name: "Comparison mode" })
    .selectOption("all");
  await page.getByRole("button", { name: /Open (review|comparison)/ }).click();
  await expect(
    page.getByRole("heading", { name: "identity-service" }),
  ).toBeVisible();
  await expect(
    page.getByText("2 CHANGED FILES", { exact: false }),
  ).toBeVisible();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await page
    .getByRole("button", { name: "Mark file reviewed", exact: true })
    .click();
  await expect(page.locator(".progress-summary")).toContainText(
    "1 / 2 reviewed",
  );
  await expect(page.locator(".file-heading strong")).toHaveText(
    "src/auth/types.ts",
  );
  await page.getByRole("button", { name: /validatePassword.ts/ }).click();
  await page
    .locator(".monaco-diff-editor .editor.modified .line-numbers")
    .filter({ hasText: /^2$/ })
    .click();
  await page
    .getByRole("button", { name: "Open in editor", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Choose your default editor" }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Cancel", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Draft comment" })
    .fill("Does this preserve existing password compatibility?");
  await page.getByRole("button", { name: "Save draft", exact: true }).click();
  await expect(
    page.getByText("Does this preserve existing password compatibility?", {
      exact: true,
    }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Explanation", exact: true }).click();
  await page.getByRole("button", { name: "Generate AI proposal" }).click();
  await expect(
    page.getByRole("dialog", { name: "Confirm analysis input" }),
  ).toContainText("fixture-model");
  await page.getByRole("button", { name: "Authorize & analyze" }).click();
  await expect(
    page.getByText("Analysis proposal ready", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Accept proposal", exact: true })
    .click();
  await expect(page.locator(".cohort-sidebar")).toContainText("Authentication");
  await expect(page.locator(".progress-summary")).toContainText(
    "1 / 2 reviewed",
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
  await page
    .getByRole("button", { name: "Refresh snapshot", exact: true })
    .click();
  await expect(page.locator(".progress-summary")).toContainText(
    "0 / 2 reviewed",
  );
  await page.getByRole("button", { name: "Comments", exact: false }).click();
  await expect(
    page.getByText("Needs reattachment", { exact: true }),
  ).toBeVisible();
  const history = page.getByRole("combobox", { name: "Snapshot history" });
  const oldValue = await history.locator("option").nth(1).getAttribute("value");
  await history.selectOption(oldValue!);
  await expect(page.getByText("Previous snapshot · read only")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Generate AI proposal" }),
  ).toBeDisabled();
  expect(errors).toEqual([]);
});
