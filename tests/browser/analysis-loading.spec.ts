import { expect, test } from "@playwright/test";
import type { Review } from "../../packages/contracts/src/index";

test("analysis stays visible while the diff is usable and cancellation has its own pending state", async ({
  page,
}) => {
  const now = Date.now();
  await page.clock.setFixedTime(now);
  const review: Review = {
    snapshot: {
      id: "loading",
      sessionId: "loading",
      capturedAt: "2026-10-15",
      root: "fixture",
      comparison: { mode: "all", base: "main" },
      head: null,
      base: null,
      complete: true,
      files: Array.from({ length: 60 }, (_, index) => ({
        id: `file-${index}`,
        path: `example-${index}.ts`,
        oldPath: `example-${index}.ts`,
        status: "modified" as const,
        fingerprint: "fixture",
        patch: "+export const value = 2;",
        before: { kind: "text" as const, text: "export const value = 1;" },
        after: { kind: "text" as const, text: "export const value = 2;" },
      })),
    },
    history: [{ id: "loading", capturedAt: "2026-10-15" }],
    state: {
      reviewed: [],
      drafts: [],
      accepted: null,
      proposal: null,
      analysisStatus: "running",
      analysisProgress: {
        startedAt: now - 45000,
        updatedAt: now,
        phase: "analyzing",
        completedBatches: 1,
        totalBatches: 3,
        completedFiles: 20,
        totalFiles: 60,
        currentFiles: ["example-20.ts", "example-21.ts"],
        estimatedRemainingMs: 80000,
      },
    },
  };
  let finishCancel: (() => void) | undefined;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.endsWith("/cancel")) {
      await new Promise<void>((resolve) => {
        finishCancel = resolve;
      });
      review.state.analysisStatus = "canceled";
      await route.fulfill({ json: { ok: true } });
      return;
    }
    await route.fulfill({
      json:
        path === "/api/sessions"
          ? [
              {
                id: "loading",
                name: "Loading review",
                root: "fixture",
                updatedAt: "2026-10-15",
              },
            ]
          : path === "/api/sessions/loading"
            ? review
            : path === "/api/editor"
              ? { config: null, presets: [] }
              : path === "/api/provider"
                ? {
                    provider: "codex",
                    endpoint: "https://chatgpt.com/codex",
                    model: "fixture",
                    contextWindow: 8192,
                    maxOutput: 2048,
                    localOnly: false,
                  }
                : null,
    });
  });
  await page.goto("/");
  await page
    .getByRole("combobox", { name: "Saved reviews" })
    .selectOption("loading");
  const loading = page.getByRole("region", { name: "AI analysis in progress" });
  await expect(loading).toBeVisible();
  await expect(loading.getByRole("status")).toHaveText(
    "Analyzing batch 2 of 3…",
  );
  await expect(loading).toContainText("Codex is organizing 60 changed files");
  await expect(loading).toContainText(
    "1 / 3 batches checked · 20 / 60 files processed",
  );
  await expect(loading).toContainText(/About .* remaining/);
  await expect(loading.getByText("0:45 elapsed", { exact: true })).toBeVisible();
  await expect(
    loading.getByRole("progressbar", { name: "Analysis batches completed" }),
  ).toHaveAttribute("aria-valuenow", "1");
  await loading.getByText("Files in this batch (2)", { exact: true }).click();
  await expect(
    loading.getByText("example-20.ts", { exact: true }),
  ).toBeVisible();
  const files = page.getByRole("region", { name: "Changed files list" });
  expect(
    await files.evaluate(
      (element) => element.scrollHeight > element.clientHeight,
    ),
  ).toBe(true);
  expect(await files.evaluate((element) => element.clientHeight)).toBeLessThan(
    750,
  );
  await files.evaluate((element) => {
    element.scrollTop = element.scrollHeight;
  });
  await expect(files.locator(".file-item").last()).toBeInViewport();
  await files.locator(".file-item").last().click();
  await expect(page.locator(".file-heading strong")).toHaveText(
    "example-59.ts",
  );
  await page.reload();
  await expect(page.locator(".file-heading strong")).toHaveText(
    "example-59.ts",
  );
  await expect(loading.getByRole("status")).toHaveText(
    "Analyzing batch 2 of 3…",
  );
  await expect(loading.getByText("0:45 elapsed", { exact: true })).toBeVisible();
  await expect(page.locator(".monaco-diff-editor")).toBeVisible();
  await expect(
    page.getByRole("button", { name: "Analysis in progress…", exact: true }),
  ).toBeDisabled();
  await page.screenshot({
    path: ".leanreview-test/ui-analysis-loading.png",
    fullPage: true,
  });
  await loading.getByRole("button", { name: "Cancel analysis" }).click();
  await expect(
    loading.getByRole("button", { name: "Canceling…", exact: true }),
  ).toBeDisabled();
  await expect(loading.getByRole("status")).toHaveText("Canceling analysis…");
  expect(finishCancel).toBeDefined();
  finishCancel!();
  await expect(loading).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Generate AI proposal", exact: true }),
  ).toBeEnabled();
});
