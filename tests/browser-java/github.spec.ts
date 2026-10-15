import { test, expect } from "@playwright/test";

test("connect GitHub, capture a PR without cloning, and explicitly publish selected drafts", async ({
  page,
}) => {
  test.setTimeout(120000);
  await page.goto("/");
  await page
    .getByRole("button", { name: "Choose repository", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Choose repository",
    exact: true,
  });
  await picker
    .getByRole("button", { name: "Sign in with GitHub CLI", exact: true })
    .click();
  await expect(
    picker.getByText("Connected as reviewer", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await picker.getByRole("button", { name: /example\/repo/ }).click();
  const opened = page.waitForResponse((response) =>
    response.url().endsWith("/pulls/7/open"),
  );
  await picker
    .getByRole("button", { name: "#7 Change validation", exact: false })
    .click();
  expect((await opened).ok()).toBe(true);
  await expect(
    page.getByRole("region", { name: "Pull request review" }),
  ).toContainText("Change validation");
  await expect(page.locator(".file-heading strong")).toHaveText("src/value.ts");
  const session = await page
    .getByRole("combobox", { name: "Saved reviews" })
    .inputValue();
  const captured = await (
    await page.request.get(`/api/sessions/${session}`)
  ).json();
  expect(captured.state.analysisStatus).toBe("idle");
  expect(captured.snapshot.source.provider).toBe("github");
  await page
    .locator(".monaco-diff-editor .editor.modified .line-numbers")
    .filter({ hasText: /^1$/ })
    .click();
  await page
    .getByText("Discussions and local drafts (0)", { exact: true })
    .click();
  await expect(
    page.getByText("Can you explain this rule?", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page
    .getByRole("textbox", { name: "Draft feedback", exact: true })
    .fill("Please check the boundary case.");
  await page
    .getByRole("button", { name: "Save local draft", exact: true })
    .click();
  await expect(
    page.getByText("Discussions and local drafts (1)", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Draft reply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Draft feedback", exact: true })
    .fill("I will check this next.");
  await page
    .getByRole("button", { name: "Save local draft", exact: true })
    .click();
  await expect(
    page.getByText("Discussions and local drafts (2)", { exact: true }),
  ).toBeVisible();
  // Submit just the inline comment. The reply remains a local draft.
  await page.getByRole("checkbox", { name: "Reply", exact: true }).uncheck();
  await page
    .getByRole("button", { name: "Preview submission", exact: true })
    .click();
  const preview = page.getByRole("dialog", {
    name: "Submit review to GitHub?",
    exact: true,
  });
  await expect(preview).toContainText("Please check the boundary case.");
  await expect(preview).not.toContainText("I will check this next.");
  await preview
    .getByRole("button", { name: "Submit to GitHub", exact: true })
    .click();
  await expect(
    page.getByText("Review submitted to GitHub.", { exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await expect(
    page.getByText("Discussions and local drafts (1)", { exact: true }),
  ).toBeVisible();
  await page
    .getByRole("button", { name: "Resolve on GitHub now", exact: true })
    .click();
  await expect(
    page.getByRole("button", { name: "Reopen on GitHub now", exact: true }),
  ).toBeVisible({ timeout: 15000 });
  await page.reload();
  await expect(
    page.getByRole("region", { name: "Pull request review" }),
  ).toContainText("Change validation");
  await expect(
    page.getByText("Discussions and local drafts (1)", { exact: true }),
  ).toBeVisible();
});
