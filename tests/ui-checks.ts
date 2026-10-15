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
    name: "Settings",
    exact: true,
  });
  await settings.click();
  const dialog = page.getByRole("dialog", { name: "Settings" });
  await expect(dialog).toBeVisible();
  await expect(page.getByText("On your machine", { exact: true })).toHaveCount(
    0,
  );
  await dialog.getByRole("tab", { name: "Editor", exact: true }).click();
  await expect(
    dialog.getByRole("textbox", { name: "Executable", exact: true }),
  ).toBeVisible();
  await dialog.getByRole("tab", { name: "AI", exact: true }).click();
  await expect(
    dialog.getByRole("combobox", { name: "Provider", exact: true }),
  ).toBeVisible();
  for (let i = 0; i < 18; i++) {
    await page.keyboard.press("Tab");
    await expect(dialog).toContainText("Settings");
    expect(
      await dialog.evaluate((el) => el.contains(document.activeElement)),
    ).toBe(true);
  }
  await page.keyboard.press("Escape");
  await expect(dialog).toHaveCount(0);
  await expect(settings).toBeFocused();
}

export async function verifyWorkspace(page: Page) {
  const primary = page.getByRole("button", {
    name: "Mark file reviewed",
    exact: true,
  });
  await expect(primary).toHaveCSS("color", "rgb(255, 255, 255)");
  await expect(
    page.getByRole("complementary", { name: "AI review guide" }),
  ).toBeVisible();
  await expect(
    page.getByRole("tab", { name: "CRAP", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("tab", { name: "Comments", exact: false }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Repository graph", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("button", { name: "Review dependencies", exact: true }),
  ).toHaveCount(0);
  await expect(
    page.getByRole("textbox", { name: "Draft comment" }),
  ).toHaveCount(0);
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
  await page.getByRole("button", { name: "Settings", exact: true }).click();
  await page.getByRole("tab", { name: "Editor", exact: true }).click();
  await expect(page.getByRole("dialog", { name: "Settings" })).toBeInViewport();
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
