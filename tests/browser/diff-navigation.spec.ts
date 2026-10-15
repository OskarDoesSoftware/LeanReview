import { test, expect } from "@playwright/test";
import type { Review } from "../../packages/contracts/src/index";

test("change arrows navigate distant hunks in split and unified diffs", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  const lines = Array.from(
    { length: 120 },
    (_, i) => `const value${i + 1} = ${i + 1};`,
  );
  const changed = [...lines];
  changed[9] = "const firstChange = true;";
  changed.splice(89, 1);
  const review: Review = {
    snapshot: {
      id: "arrows",
      sessionId: "arrows",
      root: "fixture",
      comparison: { mode: "all", base: "main" },
      head: null,
      base: null,
      complete: true,
      capturedAt: "2026-10-15",
      files: [
        {
          id: "text",
          path: "changes.ts",
          oldPath: "changes.ts",
          status: "modified",
          before: { kind: "text", text: lines.join("\n") },
          after: { kind: "text", text: changed.join("\n") },
          fingerprint: "text",
          patch: "",
        },
        {
          id: "binary",
          path: "image.png",
          oldPath: "image.png",
          status: "modified",
          before: { kind: "binary" },
          after: { kind: "binary" },
          fingerprint: "binary",
          patch: "",
        },
      ],
    },
    history: [{ id: "arrows", capturedAt: "2026-10-15" }],
    state: {
      reviewed: [],
      drafts: [],
      proposal: null,
      accepted: null,
      analysisStatus: "idle",
    },
  };
  review.snapshot.files.push({
    ...review.snapshot.files[0],
    id: "last",
    path: "last.ts",
    oldPath: "last.ts",
    after: { kind: "text", text: changed.slice(0, 100).join("\n") },
  });
  review.state.accepted = {
    cohorts: [
      {
        name: "Ordered changes",
        explanation: "Fixture",
        layers: [
          {
            name: "Reading order",
            explanation: "Fixture",
            fileIds: ["text", "last", "binary"],
          },
        ],
      },
    ],
    findings: [],
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    await route.fulfill({
      json:
        path === "/api/sessions"
          ? [
              {
                id: "arrows",
                name: "Diff navigation",
                root: "fixture",
                updatedAt: "2026-10-15",
              },
            ]
          : path === "/api/sessions/arrows"
            ? review
            : path === "/api/editor"
              ? { config: null, presets: [] }
              : null,
    });
  });
  await page.setViewportSize({ width: 2000, height: 1000 });
  await page.goto("/");
  await page.getByLabel("Saved reviews").selectOption("arrows");
  const next = page.getByRole("button", { name: "Next change", exact: true });
  const previous = page.getByRole("button", {
    name: "Previous change",
    exact: true,
  });
  await expect(next).toBeEnabled();
  await next.click();
  await expect(
    page
      .locator(".editor.modified .view-line")
      .filter({ hasText: "firstChange" }),
  ).toBeInViewport();
  await next.click();
  await expect(
    page
      .locator(".editor.original .view-line")
      .filter({ hasText: "value90 =" }),
  ).toBeInViewport();
  await previous.click();
  await expect(
    page
      .locator(".editor.modified .view-line")
      .filter({ hasText: "firstChange" }),
  ).toBeInViewport();
  await page.getByRole("button", { name: "Unified", exact: true }).click();
  await next.click();
  await expect(
    page
      .locator(".editor.modified .view-line")
      .filter({ hasText: "value91 =" }),
  ).toBeInViewport();
  // The accepted sidebar order differs from snapshot order.
  await next.click();
  await expect(page.locator(".file-heading strong")).toHaveText("last.ts");
  await expect(
    page
      .locator(".editor.modified .view-line")
      .filter({ hasText: "firstChange" }),
  ).toBeInViewport();
  await previous.click();
  await expect(page.locator(".file-heading strong")).toHaveText("changes.ts");
  await expect(
    page
      .locator(".editor.modified .view-line")
      .filter({ hasText: "value91 =" }),
  ).toBeInViewport();
  await next.click();
  await expect(page.locator(".file-heading strong")).toHaveText("last.ts");
  await next.click();
  await next.click();
  await next.click();
  await expect(page.locator(".file-heading strong")).toHaveText("image.png");
  await expect(next).toBeDisabled();
  await expect(previous).toBeEnabled();
  await previous.click();
  await expect(page.locator(".file-heading strong")).toHaveText("last.ts");
  await expect(
    page
      .locator(".editor.modified .view-line")
      .filter({ hasText: "value91 =" }),
  ).toBeInViewport();
  await next.click();
  await expect(page.locator(".file-heading strong")).toHaveText("image.png");
  await previous.click();
  await page.reload();
  await expect(page.locator(".file-heading strong")).toHaveText("last.ts");
  expect(errors).toEqual([]);
});
