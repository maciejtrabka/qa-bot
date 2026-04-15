import { test, expect } from '@playwright/test';

test.describe('strona statyczna', () => {
  test('ładuje się i pokazuje nagłówek oraz status', async ({ page }) => {
    await page.goto('/');

    await expect(page).toHaveTitle(/QA Bot/);
    await expect(page.getByTestId('page-root')).toBeVisible();
    await expect(page.getByTestId('hero-title')).toHaveText(
      'Witaj na stronie pod testy Playwright'
    );
    await expect(page.getByTestId('status-text')).toContainText('Deploy preview');
  });

  test('przycisk głównej akcji jest widoczny', async ({ page }) => {
    await page.goto('/');
    await expect(page.getByTestId('cta-primary')).toBeVisible();
    await expect(page.getByTestId('cta-primary')).toBeEnabled();
  });
});
