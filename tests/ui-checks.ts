import { expect, type Page } from "@playwright/test";

export async function verifyWelcome(page: Page) {
  await expect(
    page.getByRole("heading", {
      name: "Your changes. A clear place to start.",
    }),
  ).toBeVisible();
  await page.screenshot({
    path: ".leanreview-test/ui-welcome.png",
    fullPage: true,
  });
  const settings = page.getByRole("button", {
    name: "AI settings",
    exact: true,
  });
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "AI provider settings" });
  await expect(dialog).toBeVisible();
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press("Tab");
    await expect(dialog).toContainText("AI provider settings");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
}

export async function verifyWorkspace(page: Page) {
  const explanation = page.getByRole("tab", {
    name: "Explanation",
    exact: true,
  });
  const primary = page.getByRole("button", {
    name: "Mark file reviewed",
    exact: true,
  });
  await expect(primary).toHaveCSS("color", "rgb(255, 255, 255)");
  await explanation.focus();
  await page.keyboard.press("ArrowRight");
  await expect(
    page.getByRole("tab", { name: "CRAP", exact: true }),
  ).toHaveAttribute("aria-selected", "true");
  await explanation.click();
  await page.screenshot({
    path: ".leanreview-test/ui-workspace.png",
    fullPage: true,
  });
  await page.emulateMedia({ colorScheme: "dark" });
  await expect(primary).toHaveCSS("color", "rgb(21, 23, 30)");
  await page.screenshot({
    path: ".leanreview-test/ui-workspace-dark.png",
    fullPage: true,
  });
  await page.setViewportSize({ width: 390, height: 844 });
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page
    .getByRole("button", { name: "Editor settings", exact: true })
    .click();
  await expect(
    page.getByRole("dialog", { name: "Choose your default editor" }),
  ).toBeInViewport();
  expect(
    await page.evaluate(
      () => document.documentElement.scrollWidth <= innerWidth,
    ),
  ).toBe(true);
  await page.screenshot({
    path: ".leanreview-test/ui-mobile-dialog.png",
    fullPage: true,
  });
  await page.keyboard.press("Escape");

  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.emulateMedia({ colorScheme: "light" });
}
