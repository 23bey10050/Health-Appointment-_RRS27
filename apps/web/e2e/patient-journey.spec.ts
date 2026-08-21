import { expect, test } from '@playwright/test';

/**
 * The one journey this whole phase exists to make possible, walked start to finish against a
 * real running API and a real Postgres database - search, hold, confirm, see it listed, cancel
 * it. Each `page.getByRole`/`getByLabel` lookup doubles as a small accessibility check on its
 * own: if a button or field cannot be found this way, it was not properly labelled either.
 */
test('a patient can search, book, see, and cancel an appointment end to end', async ({ page }) => {
  const email = `journey-${Date.now()}@example.test`;

  await page.goto('/register');
  await page.getByLabel('Full name').fill('Journey Test Patient');
  await page.getByLabel('Email').fill(email);
  await page.getByLabel('Password').fill('a-genuinely-long-passphrase');
  await page.getByRole('button', { name: 'Create account' }).click();
  await page.waitForURL('/appointments');
  await expect(page.getByText('You have no appointments yet.')).toBeVisible();

  await page.locator('#main-content').getByRole('link', { name: 'Find a doctor' }).click();
  await page.waitForURL('/search');
  await expect(page.locator('a[href^="/doctors/"]').first()).toBeVisible();

  await page.locator('a[href^="/doctors/"]').first().click();
  await page.waitForURL(/\/doctors\//);
  const firstSlot = page.locator('div[role="group"] button').first();
  await expect(firstSlot).toBeVisible();
  await firstSlot.click();

  await page.waitForURL(/\/hold\//);
  await expect(page.getByRole('timer')).toContainText(/\d:\d\d/);
  await page
    .getByLabel("What's bringing you in?")
    .fill('Persistent headache for three days, worse in the mornings.');
  await page.getByRole('button', { name: 'Confirm appointment' }).click();

  await page.waitForURL(/\/appointments\/.+\?booked=true/);
  await expect(page.getByText('Your appointment is confirmed')).toBeVisible();
  await expect(page.getByText('confirmed', { exact: false }).first()).toBeVisible();

  await page.getByRole('link', { name: 'My appointments' }).click();
  await page.waitForURL('/appointments');
  await expect(page.locator('a[href^="/appointments/"]')).toHaveCount(1);

  await page.locator('a[href^="/appointments/"]').first().click();
  await page.getByRole('button', { name: 'Cancel appointment' }).click();
  await page.getByRole('button', { name: 'Yes, cancel it' }).click();
  await expect(page.getByText('Cancelled', { exact: false })).toBeVisible();
});
