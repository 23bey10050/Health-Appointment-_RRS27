import { expect, test } from '@playwright/test';

/**
 * A hold really does last five real minutes server-side - waiting that out here would make this
 * the slowest test in the whole project for no real benefit. `page.clock` fast-forwards the
 * browser's own clock instead, so the countdown's `setInterval` ticks down through the exact same
 * code a genuine five-minute wait would run, just without actually waiting five minutes.
 */
test('an expired hold sends the patient back to the grid with a clear message', async ({
  page,
}) => {
  const email = `expiry-${Date.now()}@example.test`;

  await page.goto('/register');
  await page.getByLabel('Full name').fill('Expiry Test Patient');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a-genuinely-long-passphrase');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/appointments');

  await page.locator('#main-content').getByRole('link', { name: 'Find a doctor' }).click();
  await page.waitForURL('/search');
  await page.locator('a[href^="/doctors/"]').first().click();
  await page.waitForURL(/\/doctors\//);
  await page.locator('div[role="group"] button').first().click();
  await page.waitForURL(/\/hold\//);
  await expect(page.getByRole('timer')).toBeVisible();

  await page.clock.install({ time: Date.now() });
  await page.clock.fastForward('05:05');

  await expect(page.getByText('This hold has expired')).toBeVisible();
  await expect(
    page.locator('#main-content').getByRole('link', { name: 'Find a doctor' }),
  ).toBeVisible();
});
