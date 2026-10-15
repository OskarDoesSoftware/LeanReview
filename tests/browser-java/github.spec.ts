import { test, expect, type Page } from "@playwright/test";
import { readFile, writeFile } from "node:fs/promises";
import path from "node:path";

async function fixtureSignIn(page: Page) {
  if ((await (await page.request.get("/api/github/status")).json()).connected)
    return;
  const response = await page.request.post("/api/github/login", {
    data: {},
    headers: { origin: test.info().project.use.baseURL! },
  });
  expect(response.ok()).toBe(true);
  await expect
    .poll(
      async () =>
        (await (await page.request.get("/api/github/status")).json()).connected,
      { timeout: 15000 },
    )
    .toBe(true);
}

async function saveLocalDraft(page: Page) {
  const saved = page.waitForResponse(
    (response) =>
      response.request().method() === "POST" &&
      /\/sessions\/[^/]+\/(drafts|github\/reply-draft)$/.test(
        new URL(response.url()).pathname,
      ),
  );
  await page
    .getByRole("button", { name: "Save local draft", exact: true })
    .click();
  expect((await saved).ok()).toBe(true);
  await expect(
    page.getByRole("textbox", { name: "Draft feedback", exact: true }),
  ).toHaveValue("");
}

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
  await picker
    .getByRole("button", {
      name: "Choose GitHub repository example/repo",
      exact: true,
    })
    .click();
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
  await saveLocalDraft(page);
  await expect(
    page.getByText("Discussions and local drafts (1)", { exact: true }),
  ).toBeVisible();
  await page.getByRole("button", { name: "Draft reply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Draft feedback", exact: true })
    .fill("I will check this next.");
  await saveLocalDraft(page);
  await expect(
    page.getByText("Discussions and local drafts (2)", { exact: true }),
  ).toBeVisible();
  // Submit just the inline comment. The reply remains a local draft.
  await page.getByRole("checkbox", { name: "Reply", exact: true }).uncheck();
  await page.getByRole("button", { name: "Draft reply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Draft feedback", exact: true })
    .fill("Also check zero input.");
  await saveLocalDraft(page);
  await expect(
    page.getByRole("checkbox", { name: "Reply", exact: true }).first(),
  ).not.toBeChecked();
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

test("switching PRs clears the previous reply target and unsaved feedback", async ({
  page,
}) => {
  await fixtureSignIn(page);
  const headers = { origin: test.info().project.use.baseURL! };
  const first = await (
    await page.request.post("/api/github/repositories/42/pulls/7/open", {
      data: {},
      headers,
    })
  ).json();
  const second = await (
    await page.request.post("/api/github/repositories/42/pulls/8/open", {
      data: {},
      headers,
    })
  ).json();
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Saved reviews" })
    .selectOption(first.snapshot.sessionId);
  await expect(
    page.getByRole("heading", { name: "#7 Change validation", exact: true }),
  ).toBeVisible();
  if (
    !(await page
      .getByRole("textbox", { name: "Draft feedback", exact: true })
      .isVisible())
  )
    await page.getByText(/Discussions and local drafts \(/).click();
  await page.getByRole("button", { name: "Draft reply", exact: true }).click();
  await page
    .getByRole("textbox", { name: "Draft feedback", exact: true })
    .fill("Unsent feedback for the first PR");
  await page
    .getByRole("combobox", { name: "Saved reviews" })
    .selectOption(second.snapshot.sessionId);
  await expect(
    page.getByRole("heading", { name: "#8 Change validation", exact: true }),
  ).toBeVisible();
  if (
    !(await page
      .getByRole("textbox", { name: "Draft feedback", exact: true })
      .isVisible())
  )
    await page.getByText(/Discussions and local drafts \(/).click();
  await expect(
    page.getByRole("textbox", { name: "Draft feedback", exact: true }),
  ).toHaveValue("");
  await expect(
    page.getByRole("heading", { name: "Draft inline comment", exact: true }),
  ).toBeVisible();
});

test("remembered local changes remain available when the PR list is denied", async ({
  page,
}) => {
  await fixtureSignIn(page);
  const { root } = JSON.parse(
    await readFile(".leanreview-test/java-browser-fixture.json", "utf8"),
  );
  expect(
    (
      await page.request.post("/api/github/repositories/42/context", {
        data: { tab: "local", localPath: root },
        headers: { origin: test.info().project.use.baseURL! },
      })
    ).ok(),
  ).toBe(true);
  const fixtureFile = path.join(
    path.dirname(root),
    "github-fixture/state.json",
  );
  const state = JSON.parse(await readFile(fixtureFile, "utf8"));
  await writeFile(fixtureFile, JSON.stringify({ ...state, denyPulls: true }));
  try {
    await page.goto("/");
    await page
      .getByRole("button", { name: "Choose repository", exact: true })
      .click();
    const picker = page.getByRole("dialog", {
      name: "Choose repository",
      exact: true,
    });
    await picker
      .getByRole("button", {
        name: "Choose GitHub repository example/repo",
        exact: true,
      })
      .click();
    await expect(
      picker.getByRole("button", { name: "Back to repositories", exact: true }),
    ).toBeVisible();
    await expect(
      picker.getByRole("textbox", { name: "Local repository path" }),
    ).toHaveValue(root);
    await expect(
      picker.getByRole("button", { name: "Open local changes", exact: true }),
    ).toBeEnabled();
  } finally {
    const latest = JSON.parse(await readFile(fixtureFile, "utf8"));
    await writeFile(
      fixtureFile,
      JSON.stringify({ ...latest, denyPulls: false }),
    );
  }
});

test("recent reviews resume the saved snapshot without recapturing the PR", async ({
  page,
}) => {
  await fixtureSignIn(page);
  const response = await page.request.post(
    "/api/github/repositories/42/pulls/7/open",
    {
      data: {},
      headers: { origin: test.info().project.use.baseURL! },
    },
  );
  expect(response.ok()).toBe(true);
  const saved = await response.json();
  let captures = 0;
  page.on("request", (request) => {
    if (request.url().endsWith("/pulls/7/open")) captures++;
  });
  await page.goto("/");
  await page
    .getByRole("button", { name: "Choose repository", exact: true })
    .click();
  const picker = page.getByRole("dialog", {
    name: "Choose repository",
    exact: true,
  });
  await picker
    .getByRole("textbox", { name: "Search repositories" })
    .fill("example/repo");
  await picker
    .getByRole("button", { name: "Resume review example/repo #7", exact: true })
    .click();
  await expect(picker).not.toBeVisible();
  await expect(
    page.getByRole("combobox", { name: "Saved reviews" }),
  ).toHaveValue(saved.snapshot.sessionId);
  const resumed = await (
    await page.request.get(`/api/sessions/${saved.snapshot.sessionId}`)
  ).json();
  expect(resumed.snapshot.id).toBe(saved.snapshot.id);
  expect(resumed.state.drafts).toEqual(saved.state.drafts);
  expect(resumed.state.analysisStatus).toBe(saved.state.analysisStatus);
  expect(captures).toBe(0);
});
