import { test, expect } from "@playwright/test";
import { largeJavaGraph } from "../fixtures/large-graph";
import type { Review } from "../../packages/contracts/src/index";

test("large Java graph opens at readable scale and drills down without dense layout", async ({
  page,
}) => {
  const graph = largeJavaGraph();
  const review: Review = {
    snapshot: {
      id: "large",
      sessionId: "large",
      root: "fixture",
      comparison: { mode: "all", base: "main" },
      head: null,
      base: null,
      files: [],
      complete: true,
      capturedAt: "2026-10-15",
    },
    history: [{ id: "large", capturedAt: "2026-10-15" }],
    state: {
      reviewed: [],
      drafts: [],
      proposal: null,
      accepted: null,
      analysisStatus: "idle",
    },
  };
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    const data = path.endsWith("/graph")
      ? {
          graph,
          run: {
            status: "succeeded",
            startedAt: "2026-10-15",
            finishedAt: "2026-10-15",
          },
        }
      : path === "/api/sessions"
        ? [
            {
              id: "large",
              name: "Large Java fixture",
              root: "fixture",
              updatedAt: "2026-10-15",
            },
          ]
        : path === "/api/sessions/large"
          ? review
          : path === "/api/editor"
            ? { config: null, presets: [] }
            : null;
    await route.fulfill({ json: data });
  });
  await page.goto("/");
  await page.getByLabel("Saved reviews").selectOption("large");
  const started = Date.now();
  await page
    .getByRole("button", { name: "Repository graph", exact: true })
    .click();
  const viewer = page.getByRole("dialog", { name: "Module dependency viewer" });
  await expect(viewer.locator(".graph-node-list button")).toHaveCount(10);
  await expect(viewer.locator(".graph-layout-note")).toContainText(
    "Large graph: grid layout",
  );
  expect(Date.now() - started).toBeLessThan(5000);
  await page.screenshot({ path: ".leanreview-test/large-java-overview.png" });
  await expect(viewer.locator(".react-flow__edge")).toHaveCount(0);
  await expect(viewer.locator(".graph-node-label strong").first()).toHaveCSS(
    "font-size",
    "15px",
  );
  await viewer
    .getByRole("button", {
      name: "com.example.product.area3 folder",
      exact: true,
    })
    .click();
  await expect(viewer.locator(".react-flow__edge").first()).toBeVisible();
  await viewer
    .getByRole("button", { name: "Open namespace", exact: true })
    .click();
  await expect(viewer.locator(".graph-node-list button")).toHaveCount(60);
  await expect(viewer.locator(".graph-layout-note")).toContainText(
    "Large graph: grid layout",
  );
  await expect(viewer.locator(".graph-layout-note")).toContainText(
    "Large graph: grid layout",
  );
  await expect(viewer.locator(".react-flow__edge")).toHaveCount(0);
  await viewer
    .getByRole("button", {
      name: "com.example.product.area3.feature180 package",
      exact: true,
    })
    .click();
  await expect(viewer.locator(".react-flow__edge")).not.toHaveCount(0);
  await page.screenshot({ path: ".leanreview-test/large-java-namespace.png" });
  await page.getByLabel("Filter modules").fill("feature180");
  await expect(viewer.locator(".graph-node-list button")).toHaveCount(1);
  await page.screenshot({ path: ".leanreview-test/large-java-graph.png" });
});
