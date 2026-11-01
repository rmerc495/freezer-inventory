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
    else if (url.pathname.endsWith('/freezers')) body = [{ id: '55555555-5555-4555-8555-555555555555', name: 'Main Freezer', is_default: true }];
    else if (url.pathname.endsWith('/rpc/create_household') || url.pathname.endsWith('/rpc/join_household')) { connected = true; body = householdId; }
    else if (url.pathname.endsWith('/functions/v1/invite-household')) body = { sent: true };
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
  await expect(page.getByRole('heading', { name: 'Your freezers', exact: true })).toBeVisible();
  await page.getByRole('button', { name: 'Profile settings', exact: true }).click();
  await page.getByRole('button', { name: 'Share household' }).click();
  await page.getByLabel('Their email address').fill('partner@example.com');
  await page.getByRole('button', { name: 'Send invitation', exact: true }).click();
  await expect(page.getByRole('status')).toContainText('Invitation sent to');
});

test('invitation email callback requires password setup before joining and survives reload', async ({ page }) => {
  await mockBackend(page);
  let joined = 0;
  page.on('request', request => { if (request.url().endsWith('/rpc/join_household')) joined++; });
  await page.goto(`/?invite=12345678-1234-4234-8234-123456789abc#access_token=${accessToken}&refresh_token=test-refresh-token&expires_in=3600&token_type=bearer&type=invite`);
  await expect(page.getByRole('heading', { name: 'Choose a new password' })).toBeVisible();
  expect(joined).toBe(0);
  await page.reload();
  await page.getByLabel('Password', { exact: true }).fill('new-test-password-456');
  await page.getByLabel('Confirm password').fill('new-test-password-456');
  await page.getByRole('button', { name: 'Save new password' }).click();
  await expect(page.getByRole('heading', { name: 'Your freezers', exact: true })).toBeVisible();
  expect(joined).toBeGreaterThan(0);
});

test('email sending failures retain the invite form and recipient for retry', async ({ page }) => {
  await mockBackend(page, true); await login(page);
  await page.route('**/functions/v1/invite-household', route => route.fulfill({ status: 502, contentType: 'application/json', body: JSON.stringify({ error: 'Email provider unavailable. Try again in a minute.' }) }));
  await page.getByRole('button', { name: 'Profile settings' }).click();
  await page.getByRole('button', { name: 'Share household' }).click();
  await page.getByLabel('Their email address').fill('partner@example.com');
  await page.getByRole('button', { name: 'Send invitation' }).click();
  await expect(page.getByRole('alert')).toContainText('Email provider unavailable');
  await expect(page.getByLabel('Their email address')).toHaveValue('partner@example.com');
});

test('mobile email invitation fits the screen and Cancel sends nothing', async ({ page }) => {
  await page.setViewportSize({ width: 390, height: 844 });
  await mockBackend(page, true); await login(page);
  let sends = 0;
  page.on('request', request => { if (request.url().includes('/functions/v1/invite-household')) sends++; });
  await page.getByRole('button', { name: 'Profile settings' }).click();
  await page.getByRole('button', { name: 'Share household' }).click();
  await expect(page.getByRole('dialog')).toBeVisible();
  await expect(page.getByLabel('Their email address')).toBeFocused();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/email-invitation-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(page.getByRole('dialog')).toHaveCount(0);
  expect(sends).toBe(0);
});
test('join household using partner code', async ({ page }) => {
  await mockBackend(page); await login(page);
  await page.getByRole('button', { name: 'Join your household' }).click();
  await page.getByLabel('Invitation code').fill('partner-code');
  await page.getByRole('button', { name: 'Join household', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your freezers', exact: true })).toBeVisible();
});
test('remembered login persists to a fresh tab, and sign out removes it', async ({ page, context }) => {
  await mockBackend(page, true); await login(page, true);
  await expect(page.getByRole('heading', { name: 'Your freezers', exact: true })).toBeVisible();
  const next = await context.newPage(); await mockBackend(next, true); await next.goto('/');
  await expect(next.getByRole('heading', { name: 'Your freezers', exact: true })).toBeVisible();
  await next.getByRole('button', { name: 'Profile settings', exact: true }).click();
  await next.getByRole('button', { name: 'Sign out' }).click();
  await expect(next.getByRole('heading', { name: 'Open your freezer' })).toBeVisible();
  expect(await next.evaluate(() => Object.keys(localStorage).some(k => k.includes('auth-token')))).toBe(false);
});
test('unchecked login persists on reload but does not persist to a fresh tab', async ({ page, context }) => {
  await mockBackend(page, true); await login(page);
  await expect(page.getByRole('heading', { name: 'Your freezers', exact: true })).toBeVisible();
  await page.reload(); await expect(page.getByRole('heading', { name: 'Your freezers', exact: true })).toBeVisible();
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
  await expect(page.getByRole('heading', { name: 'Your freezers', exact: true })).toBeVisible();
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

const invitation = '12345678-1234-4234-8234-123456789abc';
test('invite opens signup and email confirmation joins on a fresh browser', async ({ page, browser }) => {
  await mockBackend(page);
  let redirect = '';
  await page.route('**/auth/v1/signup**', route => {
    redirect = new URL(route.request().url()).searchParams.get('redirect_to') ?? '';
    return route.fulfill({ status: 200, contentType: 'application/json', body: '{}' });
  });
  await page.goto(`/?invite=${invitation}`);
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByLabel('Email address').fill('partner@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password-123');
  await page.getByLabel('Confirm password').fill('test-password-123');
  await page.getByRole('button', { name: 'Create account', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Check your email' })).toBeVisible();
  expect(new URL(redirect).searchParams.get('invite')).toBe(invitation);
  const context = await browser.newContext(); const confirmed = await context.newPage();
  await mockBackend(confirmed);
  let joinedCode = '';
  confirmed.on('request', request => { if (request.url().endsWith('/rpc/join_household')) joinedCode = request.postDataJSON().p_code; });
  await confirmed.goto(`/?invite=${invitation}#access_token=${accessToken}&refresh_token=test-refresh-token&expires_in=3600&token_type=bearer&type=signup`);
  await expect(confirmed.getByRole('heading', { name: 'Your freezers', exact: true })).toBeVisible();
  expect(joinedCode).toBe(invitation);
  expect(await confirmed.evaluate(() => localStorage.getItem('freezer.pending-invitation'))).toBeNull();
  expect(new URL(confirmed.url()).searchParams.has('invite')).toBe(false);
  await context.close();
});

test('invite survives reload and an existing account can sign in to join', async ({ page }) => {
  await mockBackend(page);
  await page.goto(`/?invite=${invitation}`); await page.reload();
  await expect(page.getByRole('heading', { name: 'Create your account' })).toBeVisible();
  await page.getByRole('button', { name: 'Back to sign in' }).click();
  await page.getByLabel('Email address').fill('partner@example.com');
  await page.getByLabel('Password', { exact: true }).fill('test-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Your freezers', exact: true })).toBeVisible();
});

test('expired invite shows an actionable error without creating a household', async ({ page }) => {
  await mockBackend(page);
  await page.route('**/rpc/join_household', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'This invitation is invalid or expired. Ask for a new link.' }) }));
  await page.goto(`/?invite=${invitation}#access_token=${accessToken}&refresh_token=test-refresh-token&expires_in=3600&token_type=bearer&type=signup`);
  await expect(page.getByRole('alert')).toContainText('invalid or expired');
  await expect(page.getByRole('button', { name: 'Try invitation again' })).toBeVisible();
  await page.getByRole('button', { name: 'Continue without this invitation' }).click();
  await expect(page.getByRole('heading', { name: 'Welcome home.' })).toBeVisible();
});
