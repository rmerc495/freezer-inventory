import { test, expect, type Page } from '@playwright/test';

const userId = '11111111-1111-4111-8111-111111111111';
const householdId = '44444444-4444-4444-8444-444444444444';
const user = { id: userId, aud: 'authenticated', role: 'authenticated', email: 'owner@example.com', email_confirmed_at: new Date().toISOString(), app_metadata: { provider: 'email', providers: ['email'] }, user_metadata: {}, created_at: new Date().toISOString() };
const accessToken = `${Buffer.from(JSON.stringify({ alg: 'HS256', typ: 'JWT' })).toString('base64url')}.${Buffer.from(JSON.stringify({ sub: userId, aud: 'authenticated', exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.test-signature`;
const session = { access_token: accessToken, refresh_token: 'test-refresh-token', expires_in: 3600, token_type: 'bearer', user };

async function mockBackend(page: Page, existingHousehold = false) {
  let connected = existingHousehold;
  await page.route('https://*.supabase.co/**', async route => {
    const url = new URL(route.request().url());
    let body: unknown = {};
    if (url.pathname.endsWith('/token')) body = session;
    else if (url.pathname.endsWith('/user')) body = user;
    else if (url.pathname.endsWith('/households')) body = connected ? [{ id: householdId, name: 'Our Freezer', owner_id: userId }] : [];
    else if (url.pathname.endsWith('/inventory_items')) body = [];
    else if (url.pathname.endsWith('/rpc/create_household') || url.pathname.endsWith('/rpc/join_household')) { connected = true; body = householdId; }
    else if (url.pathname.endsWith('/rpc/create_household_invite')) body = '12345678-1234-4234-8234-123456789abc';
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
}
async function login(page: Page, remember = false) {
  await page.goto('/');
  await page.getByLabel('Email address').fill('owner@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password-123');
  if (remember) await page.getByLabel('Remember me').check();
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
}
test('sign in, create household, and create invitation', async ({ page }) => {
  await mockBackend(page); await login(page);
  await expect(page.getByRole('heading', { name: 'Welcome home.' })).toBeVisible();
  await page.getByRole('button', { name: 'Create household', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Our Freezer' })).toBeVisible();
  await page.getByRole('button', { name: 'Share household' }).click();
  await page.getByRole('button', { name: 'Create invitation code' }).click();
  await expect(page.getByLabel('Invitation code')).toHaveValue('12345678-1234-4234-8234-123456789abc');
});
test('join household using partner code', async ({ page }) => {
  await mockBackend(page); await login(page);
  await page.getByRole('button', { name: 'Join your household' }).click();
  await page.getByLabel('Invitation code').fill('partner-code');
  await page.getByRole('button', { name: 'Join household', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Our Freezer' })).toBeVisible();
});
test('remembered login persists to a fresh tab, and sign out removes it', async ({ page, context }) => {
  await mockBackend(page, true); await login(page, true);
  await expect(page.getByRole('heading', { name: 'Our Freezer' })).toBeVisible();
  const next = await context.newPage(); await mockBackend(next, true); await next.goto('/');
  await expect(next.getByRole('heading', { name: 'Our Freezer' })).toBeVisible();
  await next.getByRole('button', { name: 'Sign out' }).click();
  await expect(next.getByRole('heading', { name: 'Open your freezer' })).toBeVisible();
  expect(await next.evaluate(() => Object.keys(localStorage).some(k => k.includes('auth-token')))).toBe(false);
});
test('unchecked login persists on reload but does not persist to a fresh tab', async ({ page, context }) => {
  await mockBackend(page, true); await login(page);
  await expect(page.getByRole('heading', { name: 'Our Freezer' })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Our Freezer' })).toBeVisible();
  const next = await context.newPage(); await mockBackend(next, true); await next.goto('/');
  await expect(next.getByRole('heading', { name: 'Open your freezer' })).toBeVisible();
});
test('bad credentials and reset request show clear feedback', async ({ page }) => {
  await mockBackend(page);
  await page.route('**/auth/v1/token**', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ error_code: 'invalid_credentials', msg: 'Invalid login credentials' }) }));
  await login(page); await expect(page.getByRole('alert')).toContainText('Invalid login credentials');
  await page.getByRole('button', { name: 'Forgot password?' }).click();
  await page.getByRole('button', { name: 'Send reset link' }).click();
  await expect(page.getByRole('status')).toContainText('If an account exists');
});
test('signup confirmation and mismatched passwords', async ({ page }) => {
  await mockBackend(page); await page.goto('/');
  await page.getByRole('button', { name: 'Create an account' }).click();
  await page.getByLabel('Email address').fill('partner@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password-123');
  await page.getByLabel('Confirm password').fill('different-password');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('don’t match');
  await page.getByLabel('Confirm password').fill('test-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  await expect(page.getByText('partner@example.com', { exact: true })).toBeVisible();
  await expect(page.getByLabel('Password', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Create account', exact: true })).toHaveCount(0);
  await page.getByRole('button', { name: 'Send a new confirmation email' }).click();
  await expect(page.getByRole('status')).toContainText('fresh confirmation email');
});
test('mobile login fits the viewport', async ({ page }) => {
  await mockBackend(page); await page.setViewportSize({ width: 390, height: 844 }); await page.goto('/');
  await expect(page.getByRole('button', { name: 'Sign in', exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/login-mobile.png', fullPage: true });
});
test('recovery link opens password form and survives a reload', async ({ page }) => {
  await mockBackend(page, true);
  await page.goto(`/#access_token=${accessToken}&refresh_token=test-refresh-token&expires_in=3600&token_type=bearer&type=recovery`);
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await page.reload();
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  await page.getByLabel('Password', { exact: true }).fill('new-test-password-456');
  await page.getByLabel('Confirm password').fill('new-test-password-456');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('heading', { name: 'Our Freezer' })).toBeVisible();
  expect(await page.evaluate(() => sessionStorage.getItem('freezer.password-recovery'))).toBeNull();
});
test('desktop login preview', async ({ page }) => {
  await mockBackend(page); await page.setViewportSize({ width: 1440, height: 1000 }); await page.goto('/');
  await expect(page.getByRole('heading', { name: 'Open your freezer' })).toBeVisible();
  await page.screenshot({ path: '.local/login-desktop.png', fullPage: true });
});
test('email confirmation callback returns to the signed-in app', async ({ page }) => {
  await mockBackend(page);
  await page.goto(`/#access_token=${accessToken}&refresh_token=test-refresh-token&expires_in=3600&token_type=bearer&type=signup`);
  await expect(page.getByRole('heading', { name: 'Welcome home.' })).toBeVisible();
});
