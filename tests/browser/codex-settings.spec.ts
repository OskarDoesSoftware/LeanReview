import { expect, test } from "@playwright/test";
import type { CodexStatus } from "../../packages/contracts/src/codex";

test("connect ChatGPT, display allowance, save without a key, cancel login, and sign out", async ({
  page,
}) => {
  const errors: string[] = [];
  page.on("pageerror", (error) => errors.push(error.message));
  await page.addInitScript(() => {
    window.open = () => null;
  });
  let connected = false;
  let loginPending = false;
  let saved: unknown;
  await page.route("**/api/**", async (route) => {
    const request = route.request();
    const path = new URL(request.url()).pathname;
    let json: unknown = null;
    if (path === "/api/sessions") json = [];
    if (path === "/api/editor") json = { config: null, presets: [] };
    if (path === "/api/codex/login") {
      loginPending = true;
      json = { authUrl: "https://auth.openai.com/authorize?fixture=1" };
    }
    if (path === "/api/codex/cancel-login") {
      loginPending = false;
      json = { ok: true };
    }
    if (path === "/api/codex/logout") {
      connected = false;
      json = { ok: true };
    }
    if (path === "/api/codex/status") {
      json = {
        connected,
        loginPending,
        ...(connected
          ? { email: "reviewer@example.invalid", plan: "plus" }
          : {}),
        models: connected
          ? [
              {
                model: "fixture-codex",
                displayName: "Fixture Codex",
                isDefault: true,
              },
            ]
          : [],
        limits: connected
          ? [
              {
                limitId: "codex",
                primary: {
                  usedPercent: 25,
                  windowDurationMins: 300,
                  resetsAt: 2000000000,
                },
              },
            ]
          : [],
      } satisfies CodexStatus;
    }
    if (path === "/api/provider" && request.method() === "POST") {
      saved = request.postDataJSON();
      json = { ok: true };
    }
    await route.fulfill({ json });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^(Settings|AI settings|AI provider settings)$/, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^(Settings|AI settings|AI provider settings)$/ });
  await dialog
    .getByRole("combobox", { name: "Provider", exact: true })
    .selectOption("codex");
  await expect(
    dialog.getByText("Not signed in", { exact: true }),
  ).toBeVisible();
  await expect(dialog.getByRole("textbox", { name: "API key" })).toHaveCount(0);
  await expect(dialog.getByRole("textbox", { name: "Endpoint" })).toHaveCount(
    0,
  );
  await dialog
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  await expect(
    dialog.getByRole("link", { name: "Continue sign-in in your browser" }),
  ).toHaveAttribute("href", "https://auth.openai.com/authorize?fixture=1");
  await dialog.getByRole("button", { name: "Cancel sign-in" }).click();
  await expect(
    dialog.getByText("Not signed in", { exact: true }),
  ).toBeVisible();
  await dialog
    .getByRole("button", { name: "Sign in with ChatGPT", exact: true })
    .click();
  connected = true;
  loginPending = false;
  await dialog
    .getByRole("button", { name: "Refresh connection and usage" })
    .click();
  await expect(dialog.getByRole("status")).toContainText(
    "Connected as reviewer@example.invalid · plus",
  );
  await expect(dialog.getByText(/75% remaining/)).toBeVisible();
  await expect(
    dialog.getByRole("combobox", { name: "Model", exact: true }),
  ).toHaveValue("fixture-codex");
  await page.screenshot({
    path: ".leanreview-test/ui-codex-settings.png",
    fullPage: true,
  });
  await dialog.getByRole("button", { name: "Save configuration" }).click();
  expect(saved).toMatchObject({
    config: {
      provider: "codex",
      model: "fixture-codex",
      endpoint: "https://chatgpt.com/codex",
      localOnly: false,
    },
  });
  expect(saved).not.toHaveProperty("token");
  await expect(dialog).toHaveCount(0);
  // Reopen and select the provider again because this fixture deliberately doesn't persist settings.
  await page.getByRole("button", { name: /^(Settings|AI settings|AI provider settings)$/, exact: true }).click();
  await dialog.getByRole("button", { name: "Sign out of LeanReview" }).click();
  await expect(
    dialog.getByText("Not signed in", { exact: true }),
  ).toBeVisible();
  await page.setViewportSize({ width: 600, height: 760 });
  await page.emulateMedia({ colorScheme: "dark" });
  await page.screenshot({
    path: ".leanreview-test/ui-codex-settings-small.png",
    fullPage: true,
  });
  expect(errors).toEqual([]);
});

test("shows missing CLI errors and unavailable usage without claiming zero consumption", async ({
  page,
}) => {
  let available = false;
  await page.route("**/api/**", async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path === "/api/codex/status") {
      if (!available)
        return route.fulfill({
          status: 400,
          json: {
            error:
              "Codex CLI was not found. Install @openai/codex and restart LeanReview.",
          },
        });
      return route.fulfill({
        json: {
          connected: true,
          loginPending: false,
          models: [],
          limits: [],
          usageError:
            "Subscription usage is unavailable. Refresh before starting analysis.",
        } satisfies CodexStatus,
      });
    }
    await route.fulfill({
      json:
        path === "/api/sessions"
          ? []
          : path === "/api/editor"
            ? { config: null, presets: [] }
            : null,
    });
  });
  await page.goto("/");
  await page.getByRole("button", { name: /^(Settings|AI settings|AI provider settings)$/, exact: true }).click();
  const dialog = page.getByRole("dialog", { name: /^(Settings|AI settings|AI provider settings)$/ });
  await dialog
    .getByRole("combobox", { name: "Provider", exact: true })
    .selectOption("codex");
  await expect(dialog.getByRole("alert")).toContainText(
    "Codex CLI was not found",
  );
  available = true;
  await dialog
    .getByRole("button", { name: "Refresh connection and usage" })
    .click();
  await expect(
    dialog.getByText(/Subscription usage is unavailable/),
  ).toBeVisible();
  await expect(dialog.getByText(/% remaining/)).toHaveCount(0);
});
