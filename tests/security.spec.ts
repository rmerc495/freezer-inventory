import { test, expect } from '@playwright/test';
import { createServer, type Server } from 'node:http';
import { readFileSync } from 'node:fs';
import { resolve, extname } from 'node:path';

// Exercise the actual production bundle with the headers shipped to Cloudflare.
let server: Server;
let origin: string;
test.beforeAll(async () => {
  const headers = Object.fromEntries(readFileSync('dist/_headers', 'utf8').split('\n')
    .filter(line => line.startsWith('  ')).map(line => {
      const colon = line.indexOf(':');
      return [line.slice(0, colon).trim(), line.slice(colon + 1).trim()];
    }));
  server = createServer((req, res) => {
    const path = new URL(req.url!, 'http://localhost').pathname;
    const file = path.startsWith('/assets/') ? resolve('dist', '.' + path) : resolve('dist/index.html');
    const type = { '.js': 'text/javascript', '.css': 'text/css', '.html': 'text/html' }[extname(file)] ?? 'application/octet-stream';
    res.writeHead(200, { ...headers, 'Content-Type': type });
    res.end(readFileSync(file));
  });
  await new Promise<void>(done => server.listen(0, '127.0.0.1', done));
  const address = server.address();
  if (!address || typeof address === 'string') throw new Error('Missing test server port');
  origin = `http://127.0.0.1:${address.port}`;
});
test.afterAll(async () => { await new Promise<void>(done => server.close(() => done())); });

test('production CSP permits sign-in and blocks inline scripts', async ({ page }) => {
  const violations: string[] = [];
  page.on('console', message => {
    if (/violates.*Content Security Policy|Refused to/i.test(message.text())) violations.push(message.text());
  });
  await page.route('https://olgldvjabjhxkbnfpcwh.supabase.co/**', async route => {
    const path = new URL(route.request().url()).pathname;
    const user = { id: '11111111-1111-4111-8111-111111111111', email: 'owner@example.invalid', aud: 'authenticated' };
    const body = path.endsWith('/token') ? {
      access_token: 'test-token', refresh_token: 'test-refresh', expires_in: 3600, token_type: 'bearer', user,
    } : path.endsWith('/user') ? user : [];
    await route.fulfill({ status: 200, contentType: 'application/json', body: JSON.stringify(body) });
  });
  const response = await page.goto(origin);
  expect(response!.headers()['x-frame-options']).toBe('DENY');
  expect(response!.headers()['referrer-policy']).toBe('no-referrer');
  expect(response!.headers()['x-content-type-options']).toBe('nosniff');
  await page.getByLabel('Email address').fill('owner@example.invalid');
  await page.getByLabel('Password', { exact: true }).fill('test-password-123');
  await page.getByRole('button', { name: 'Sign in', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Welcome home.' })).toBeVisible();
  expect(violations).toEqual([]);
  const blocked = await page.evaluate(() => new Promise<boolean>(done => {
    document.addEventListener('securitypolicyviolation', event => done(event.blockedURI === 'inline'), { once: true });
    const script = document.createElement('script');
    script.textContent = 'window.securityProbeExecuted = true';
    document.body.append(script);
  }));
  expect(blocked).toBe(true);
  expect(await page.evaluate(() => 'securityProbeExecuted' in window)).toBe(false);
});
