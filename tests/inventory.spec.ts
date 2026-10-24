import { test, expect, type Page } from '@playwright/test';

const household = '44444444-4444-4444-8444-444444444444';
const owner = '11111111-1111-4111-8111-111111111111';
const partner = '22222222-2222-4222-8222-222222222222';
const mainFreezer = '55555555-5555-4555-8555-555555555555';
type Item = { id: string; name: string; quantity: number; updated_at?: string; freezer_id?: string; tags?: string[]; synonyms?: string[] };
type Freezer = { id: string; name: string; is_default: boolean };
type SpellingEvent = { operation_id: string; original_name: string; corrected_name?: string; quantity: number; status: string; actor_id: string; freezer_id: string; dismissed?: boolean };

function backend() {
  const items: Item[] = [];
  let tick = 0;
  const changedAt = () => new Date(Date.now() + ++tick).toISOString();
  const freezers: Freezer[] = [{ id: mainFreezer, name: 'Main Freezer', is_default: true }];
  const operations = new Map<string, { item: Item; delta: number; actor: string; undone?: boolean; other?: { item: Item; delta: number }; batch?: { item: Item; delta: number }[] }>();
  const requests: Record<string, string | number>[] = [];
  let loseResponse = false;
  let failRead = false;
  let failUndo = false;
  const corrections = new Map<string, { item_id: string; name: string; merged: boolean }>();
  const spelling: SpellingEvent[] = [];
  const keptSpellings = new Set<string>();
  async function connect(page: Page, actor = owner) {
    const user = { id: actor, aud: 'authenticated', role: 'authenticated', email: `${actor === owner ? 'owner' : 'partner'}@example.com`, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() };
    const token = `${Buffer.from('{"alg":"HS256"}').toString('base64url')}.${Buffer.from(JSON.stringify({ sub: actor, exp: Math.floor(Date.now() / 1000) + 3600 })).toString('base64url')}.signature`;
    await page.route('https://*.supabase.co/**', async route => {
      const path = new URL(route.request().url()).pathname;
      let body: unknown = {};
      let status = 200;
      if (path.endsWith('/token')) body = { access_token: token, refresh_token: 'test-refresh', expires_in: 3600, token_type: 'bearer', user };
      else if (path.endsWith('/user')) body = user;
      else if (path.endsWith('/households')) body = [{ id: household, name: 'Our Freezer', owner_id: owner }];
      else if (path.endsWith('/freezers')) body = freezers;
      else if (path.endsWith('/rpc/save_freezer')) {
        const args = route.request().postDataJSON();
        const existing = freezers.find(f => f.id === args.p_freezer_id);
        if (existing) existing.name = args.p_name; else freezers.push({ id: args.p_freezer_id, name: args.p_name, is_default: false });
        body = args.p_freezer_id;
      }
      else if (path.endsWith('/inventory_spelling')) body = spelling.filter(event => event.actor_id === actor && event.status === 'corrected' && !event.dismissed && event.freezer_id === new URL(route.request().url()).searchParams.get('freezer_id')?.replace('eq.', '')).slice(-3).reverse();
      else if (path.endsWith('/inventory_items')) {
        const url = new URL(route.request().url());
        const suggestions = url.searchParams.get('select') === 'id,name,quantity';
        const lookup = url.searchParams.has('normalized_name');
        if (!suggestions) expect(url.searchParams.get('quantity')).toBe('gt.0');
        expect(url.searchParams.get('household_id')).toBe(`eq.${household}`);
        if (failRead) { status = 503; body = { message: 'Inventory temporarily unavailable' }; }
        else {
          let matching = items.filter(i => (suggestions || i.quantity > 0) && (i.freezer_id ?? mainFreezer) === url.searchParams.get('freezer_id')?.replace('eq.', ''));
          if (lookup) {
            matching = matching.filter(i => i.name.toLowerCase() === url.searchParams.get('normalized_name')?.replace('eq.', '') && i.id !== url.searchParams.get('id')?.replace('neq.', ''));
          } else if (suggestions) {
            const term = (url.searchParams.get('name') ?? '').replace(/^ilike\. %/, '').replace(/^ilike\.%/, '').replace(/%$/, '').replace(/\\([%_\\])/g, '$1').toLowerCase();
            matching = matching.filter(i => i.name.toLowerCase().includes(term)).slice(0, 6);
          }
          body = lookup ? matching[0] ?? null : matching;
        }
      } else if (path.endsWith('/rpc/restore_inventory_spelling') || path.endsWith('/rpc/dismiss_inventory_spelling')) {
        const args = route.request().postDataJSON(); requests.push(args);
        const event = spelling.find(event => event.operation_id === args.p_operation_id && event.actor_id === actor)!;
        if (path.endsWith('/dismiss_inventory_spelling')) event.dismissed = true;
        else if (event.status !== 'restored') {
          const operation = operations.get(event.operation_id)!;
          operation.item.quantity -= event.quantity;
          let original = items.find(item => item.name === event.original_name && (item.freezer_id ?? mainFreezer) === event.freezer_id);
          if (!original) { original = { id: `restored-${++tick}`, name: event.original_name, quantity: 0, freezer_id: event.freezer_id }; items.push(original); }
          original.quantity += event.quantity; operation.item = original;
          event.status = 'restored'; keptSpellings.add(event.original_name.toLowerCase());
        }
        body = event.operation_id;
        if (loseResponse) { loseResponse = false; await route.abort('failed'); return; }
      } else if (path.endsWith('/rpc/rename_inventory_item')) {
        const args = route.request().postDataJSON(); requests.push(args);
        expect(args.p_household_id).toBe(household);
        if (!corrections.has(args.p_request_id)) {
          const source = items.find(i => i.id === args.p_item_id)!;
          const clean = args.p_name.trim().replace(/\s+/g, ' ');
          const target = items.find(i => i.id !== source.id && (i.freezer_id ?? mainFreezer) === (source.freezer_id ?? mainFreezer) && i.name.toLowerCase() === clean.toLowerCase());
          if (source.name !== args.p_expected_name || (target?.id ?? null) !== args.p_merge_target_id) {
            status = 400; body = { code: '22023', message: 'This item has changed. Review the name again.' };
          } else {
            if (target) {
              target.quantity += source.quantity; target.updated_at = changedAt();
              for (const operation of operations.values()) {
                if (operation.item === source) operation.item = target;
                if (operation.other?.item === source) operation.other.item = target;
                for (const change of operation.batch ?? []) if (change.item === source) change.item = target;
              }
              items.splice(items.indexOf(source), 1);
            } else { source.name = clean.replace(/\b\w/g, (c: string) => c.toUpperCase()); source.updated_at = changedAt(); }
            const survivor = target ?? source;
            corrections.set(args.p_request_id, { item_id: survivor.id, name: survivor.name, merged: !!target });
          }
        }
        if (status === 200) body = corrections.get(args.p_request_id);
        if (loseResponse) { loseResponse = false; await route.abort('failed'); return; }
      } else if (path.endsWith('/rpc/submit_inventory_item') || path.endsWith('/rpc/change_inventory') || path.endsWith('/rpc/undo_inventory') || path.endsWith('/rpc/move_inventory') || path.endsWith('/rpc/bulk_add_inventory')) {
        const args = route.request().postDataJSON(); requests.push(args);
        expect(args.p_household_id).toBe(household);
        const undoing = path.endsWith('/undo_inventory');
        const id = undoing ? args.p_undo_id : args.p_operation_id;
        expect(id).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/);
        if (!operations.has(id)) {
          if (undoing) {
            const original = operations.get(args.p_operation_id)!;
            if (failUndo || original.item.quantity - original.delta < 0 || original.batch?.some(change => change.item.quantity - change.delta < 0)) { status = 400; body = { message: 'Undo would make quantity negative' }; }
            else {
              expect(original.actor).toBe(actor);
              original.item.quantity -= original.delta; original.item.updated_at = changedAt(); original.undone = true;
              for (const change of original.batch ?? []) { change.item.quantity -= change.delta; change.item.updated_at = changedAt(); }
              if (original.other) original.other.item.quantity -= original.other.delta;
              operations.set(id, { item: original.item, delta: -original.delta, actor });
              const event = spelling.find(event => event.operation_id === args.p_operation_id); if (event) event.dismissed = true;
            }
          } else if (path.endsWith('/bulk_add_inventory')) {
            const changes: { item: Item; delta: number }[] = [];
            for (const row of args.p_items) {
              const normalized = row.name.trim().replace(/\s+/g, ' ').toLowerCase();
              let item = items.find(i => i.name.toLowerCase() === normalized && (i.freezer_id ?? mainFreezer) === args.p_freezer_id);
              if (!item) { item = { id: `item-${items.length}`, name: normalized.replace(/\b\w/g, (c: string) => c.toUpperCase()), quantity: 0, freezer_id: args.p_freezer_id }; items.push(item); }
              item.quantity += row.quantity; item.updated_at = changedAt(); changes.push({ item, delta: row.quantity });
            }
            operations.set(id, { item: changes[0].item, delta: changes[0].delta, batch: changes.slice(1), actor });
          } else if (path.endsWith('/move_inventory')) {
            const source = items.find(i => i.id === args.p_item_id)!;
            let target = items.find(i => i.name === source.name && i.freezer_id === args.p_to_freezer_id);
            if (!target) { target = { id: `item-${items.length}`, name: source.name, quantity: 0, freezer_id: args.p_to_freezer_id }; items.push(target); }
            const amount = args.p_quantity ?? source.quantity; source.quantity -= amount; target.quantity += amount;
            operations.set(id, { item: source, delta: -amount, actor, other: { item: target, delta: amount } });
          } else {
            let normalized = args.p_name?.trim().replace(/\s+/g, ' ').toLowerCase();
            const originalName = normalized;
            const knownCorrection = new Map([['peperoni', 'pepperoni'], ['chikcen', 'chicken']]).get(normalized);
            if (path.endsWith('/submit_inventory_item') && !keptSpellings.has(normalized) && !items.some(item => item.name.toLowerCase() === normalized) && knownCorrection && items.some(item => item.name.toLowerCase() === knownCorrection)) normalized = knownCorrection;
            let item = items.find(i => args.p_item_id ? i.id === args.p_item_id : i.name.toLowerCase() === normalized && (i.freezer_id ?? mainFreezer) === args.p_freezer_id);
            if (!item) { item = { id: `item-${items.length}`, name: normalized.replace(/\b\w/g, (c: string) => c.toUpperCase()), quantity: 0, freezer_id: args.p_freezer_id }; items.push(item!); }
            item!.quantity += args.p_delta; item!.updated_at = changedAt();
            operations.set(id, { item: item!, delta: args.p_delta, actor });
            if (path.endsWith('/submit_inventory_item')) spelling.push({ operation_id: id, original_name: originalName.replace(/\b\w/g, (c: string) => c.toUpperCase()), corrected_name: normalized !== originalName ? item!.name : undefined, quantity: args.p_delta, status: normalized !== originalName ? 'corrected' : 'pending', actor_id: actor, freezer_id: args.p_freezer_id });
          }
        }
        if (status === 200) body = id;
        if (loseResponse) { loseResponse = false; await route.abort('failed'); return; }
      }
      await route.fulfill({ status, contentType: 'application/json', body: JSON.stringify(body) });
    });
    await page.goto('/');
    await page.getByLabel('Email address').fill(user.email);
    await page.getByLabel('Password', { exact: true }).fill('test-password');
    await page.getByRole('button', { name: 'Sign in', exact: true }).click();
    await expect(page.getByRole('heading', { name: 'Your freezers', exact: true })).toBeVisible();
  }
  return { connect, items, freezers, requests, loseNextResponse: () => { loseResponse = true; }, failReads: (value: boolean) => { failRead = value; }, failUndos: () => { failUndo = true; },
    correctInBackground: (from: string, to: string) => {
      const source = items.find(item => item.name === from)!;
      let target = items.find(item => item.name === to && (item.freezer_id ?? mainFreezer) === (source.freezer_id ?? mainFreezer));
      if (!target) { target = { id: `corrected-${++tick}`, name: to, quantity: 0, freezer_id: source.freezer_id }; items.push(target); }
      target.quantity += source.quantity;
      for (const event of spelling.filter(event => event.original_name === from && event.status === 'pending')) {
        event.status = 'corrected'; event.corrected_name = to; operations.get(event.operation_id)!.item = target;
      }
      items.splice(items.indexOf(source), 1);
    },
  };
}

async function add(page: Page, name: string, quantity = '1') {
  await page.getByLabel('Item name', { exact: true }).fill(name);
  await page.getByLabel('Quantity', { exact: true }).fill(quantity);
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(page.getByRole('button', { name: 'Add item', exact: true })).toBeEnabled();
}

test('search finds background tags, synonyms and typos without blocking entry', async ({ page }) => {
  const db = backend();
  db.items.push(
    { id: 'broccoli', name: 'Broccoli', quantity: 2, tags: ['vegetables'], synonyms: ['broccoli florets'] },
    { id: 'beans', name: 'Green Beans', quantity: 1, tags: ['vegetables'], synonyms: ['string beans'] },
    { id: 'nuggets', name: 'Chicken Nuggets', quantity: 3, tags: ['snacks', 'poultry'] },
    { id: 'zero', name: 'Peas', quantity: 0, tags: ['vegetables'] },
  );
  await db.connect(page);
  const search = page.getByRole('searchbox', { name: 'Search inventory' });
  await search.fill('vegtables');
  await expect(page.getByLabel('Broccoli quantity')).toBeVisible();
  await expect(page.getByLabel('Green Beans quantity')).toBeVisible();
  await expect(page.getByLabel('Chicken Nuggets quantity')).toHaveCount(0);
  await expect(page.getByLabel('Peas quantity')).toHaveCount(0);
  await search.fill('string beans');
  await expect(page.getByLabel('Green Beans quantity')).toBeVisible();
  await expect(page.getByLabel('Broccoli quantity')).toHaveCount(0);
  await search.fill('snacks');
  await expect(page.getByLabel('Chicken Nuggets quantity')).toBeVisible();
  await search.fill('chikcen');
  await expect(page.getByLabel('Chicken Nuggets quantity')).toBeVisible();
  await search.fill('');
  await add(page, 'Carrots');
  await expect(page.getByLabel('Carrots quantity')).toBeVisible();
  db.items.find(item => item.name === 'Carrots')!.tags = ['vegetables'];
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await search.fill('vegetables');
  await expect(page.getByLabel('Carrots quantity')).toBeVisible();
});

test('submission corrects a familiar typo, merges stock, and restores only that addition', async ({ page }) => {
  const db = backend(); db.items.push({ id: 'pepperoni', name: 'Pepperoni', quantity: 2 });
  await db.connect(page); await add(page, 'peperoni', '3');
  await expect(page.getByLabel('Pepperoni quantity')).toHaveText('5');
  await expect(page.getByText('Corrected Peperoni → Pepperoni.', { exact: true })).toBeVisible();
  db.loseNextResponse();
  await page.getByRole('button', { name: 'Keep original spelling Peperoni', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Couldn’t confirm');
  await page.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(page.getByLabel('Pepperoni quantity')).toHaveText('2');
  await expect(page.getByLabel('Peperoni quantity')).toHaveText('3');
  expect(db.requests[1]).toEqual(db.requests[2]);
  await add(page, 'peperoni');
  await expect(page.getByLabel('Peperoni quantity')).toHaveText('4');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Peperoni quantity')).toHaveText('3');
});

test('unfamiliar names save immediately and a background correction can be dismissed on mobile', async ({ page }) => {
  const db = backend(); await db.connect(page); await page.setViewportSize({ width: 390, height: 844 });
  await add(page, 'brocoli', '2');
  await expect(page.getByLabel('Brocoli quantity')).toHaveText('2');
  await expect(page.getByRole('button', { name: 'Add item', exact: true })).toBeEnabled();
  db.correctInBackground('Brocoli', 'Broccoli');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Broccoli quantity')).toHaveText('2');
  await expect(page.getByText('Corrected Brocoli → Broccoli.', { exact: true })).toBeVisible();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/spelling-correction-mobile.png', fullPage: true });
  await page.getByRole('button', { name: 'Dismiss correction Brocoli', exact: true }).click();
  await expect(page.getByText('Corrected Brocoli → Broccoli.', { exact: true })).toHaveCount(0);
  await page.reload();
  await expect(page.getByText('Corrected Brocoli → Broccoli.', { exact: true })).toHaveCount(0);
});

test('item names can be renamed and duplicate spellings explicitly merged with quantity Undo preserved', async ({ page }) => {
  const db = backend(); await db.connect(page);
  await add(page, 'popscicles', '2');
  await page.getByRole('button', { name: 'Edit name Popscicles', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit item name' });
  await dialog.getByLabel('New item name').fill('ice pops');
  await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Ice Pops quantity')).toHaveText('2');
  const originalId = db.items[0].id;
  await add(page, 'popsicles', '3');
  await page.getByRole('button', { name: 'Edit name Ice Pops', exact: true }).click();
  await dialog.getByLabel('New item name').fill('popsicles');
  await expect(dialog).toContainText('Merge 2 + 3 into 5 total');
  await dialog.getByRole('button', { name: 'Merge items', exact: true }).click();
  await expect(page.getByLabel('Popsicles quantity')).toHaveText('5');
  await expect(page.getByLabel('Ice Pops quantity')).toHaveCount(0);
  expect(db.items).toHaveLength(1); expect(db.items[0].id).not.toBe(originalId);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Popsicles quantity')).toHaveText('2');
  await page.getByLabel('Item name', { exact: true }).fill('ice pops');
  await expect(page.getByRole('option', { name: 'Ice Pops', exact: true })).toHaveCount(0);
});

test('zero-stock names can be corrected from autocomplete without restocking, with mobile modal and cancel', async ({ page }) => {
  const db = backend();
  db.items.push({ id: 'old-typo', name: 'Popscicles', quantity: 0 }, { id: 'correct-zero', name: 'Popsicles', quantity: 0 });
  await db.connect(page); await page.setViewportSize({ width: 390, height: 844 });
  await page.getByLabel('Item name', { exact: true }).fill('popsc');
  await page.getByRole('option', { name: 'Popscicles', exact: true }).click();
  await page.getByRole('button', { name: 'Edit saved name', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit item name' });
  await dialog.getByLabel('New item name').fill('popsicles');
  await expect(dialog).toContainText('Merge 0 + 0 into 0 total');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/merge-item-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  expect(db.requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Edit saved name', exact: true }).click();
  await dialog.getByLabel('New item name').fill('popsicles');
  await dialog.getByRole('button', { name: 'Merge items', exact: true }).click();
  expect(db.items).toEqual([expect.objectContaining({ id: 'correct-zero', name: 'Popsicles', quantity: 0 })]);
  await expect(page.getByLabel('Popsicles quantity')).toHaveCount(0);
});

test('lost rename responses keep the correction frozen and retry its original request', async ({ page }) => {
  const db = backend(); await db.connect(page); await add(page, 'popscicles', '2');
  await page.getByRole('button', { name: 'Edit name Popscicles', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Edit item name' });
  await dialog.getByLabel('New item name').fill('popsicles');
  db.loseNextResponse();
  await dialog.getByRole('button', { name: 'Save name', exact: true }).click();
  await expect(dialog.getByRole('alert')).toContainText('Couldn’t confirm');
  await expect(dialog.getByLabel('New item name')).toBeDisabled();
  await dialog.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(dialog).toHaveCount(0);
  await expect(page.getByLabel('Popsicles quantity')).toHaveText('2');
  expect(db.requests[1]).toEqual(db.requests[2]);
  expect(db.items).toHaveLength(1);
});

test('duplicate adds, plus/minus, zero preservation and Undo', async ({ page }) => {
  const db = backend(); await db.connect(page);
  await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('1');
  await add(page, 'chicken thighs', '2');
  await add(page, '  CHICKEN   THIGHS ');
  const quantity = page.getByLabel('Chicken Thighs quantity');
  await expect(quantity).toHaveText('3'); expect(db.items).toHaveLength(1);
  await page.getByRole('button', { name: 'Add one Chicken Thighs', exact: true }).click();
  await expect(quantity).toHaveText('4');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(quantity).toHaveText('3');
  for (const next of ['2', '1']) {
    await page.getByRole('button', { name: 'Remove one Chicken Thighs' }).click();
    await expect(quantity).toHaveText(next);
  }
  await page.getByRole('button', { name: 'Remove one Chicken Thighs' }).click();
  await expect(quantity).toHaveCount(0);
  expect(db.items[0].quantity).toBe(0);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(quantity).toHaveText('1');
  await add(page, 'peas');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Peas quantity')).toHaveCount(0);
});

test('lost save and Undo responses reuse IDs without duplicating writes', async ({ page }) => {
  const db = backend(); await db.connect(page); db.loseNextResponse();
  await page.getByLabel('Item name', { exact: true }).fill('peas');
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Couldn’t confirm the save');
  await expect(page.getByLabel('Item name', { exact: true })).toHaveValue('peas');
  await page.getByRole('button', { name: 'Retry save' }).click();
  await expect(page.getByLabel('Peas quantity')).toHaveText('1');
  expect(db.requests[0]).toEqual(db.requests[1]);
  db.loseNextResponse();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Couldn’t confirm Undo');
  await page.getByRole('button', { name: 'Retry save' }).click();
  await expect(page.getByText('Change undone.', { exact: true })).toBeVisible();
  expect(db.requests[2]).toEqual(db.requests[3]); expect(db.items[0].quantity).toBe(0);
});

test('save success with refresh failure keeps Undo and offers a read-only retry', async ({ page }) => {
  const db = backend(); await db.connect(page); db.failReads(true);
  await add(page, 'peas', '2');
  await expect(page.getByRole('alert')).toContainText('Couldn’t refresh inventory');
  await expect(page.getByRole('button', { name: 'Undo', exact: true })).toBeVisible();
  db.failReads(false);
  await page.getByRole('button', { name: 'Refresh inventory' }).click();
  await expect(page.getByLabel('Peas quantity')).toHaveText('2');
  expect(db.requests).toHaveLength(1);
  db.failUndos();
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('Undo would make quantity negative');
  await expect(page.getByLabel('Peas quantity')).toHaveText('2');
});

test('both accounts update shared stock and refresh on returning to the app', async ({ page, browser }) => {
  const db = backend(); await db.connect(page);
  const partnerContext = await browser.newContext(); const other = await partnerContext.newPage();
  await db.connect(other, partner);
  await add(page, 'peas', '2');
  await other.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(other.getByLabel('Peas quantity')).toHaveText('2');
  await other.getByRole('button', { name: 'Add one Peas', exact: true }).click();
  await expect(other.getByLabel('Peas quantity')).toHaveText('3');
  await page.evaluate(() => window.dispatchEvent(new Event('focus')));
  await expect(page.getByLabel('Peas quantity')).toHaveText('3');
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Peas quantity')).toHaveText('1');
  await other.evaluate(() => window.dispatchEvent(new Event('online')));
  await expect(other.getByLabel('Peas quantity')).toHaveText('1');
  await partnerContext.close();
});

test('mobile inventory fits and quantity validation prevents invalid saves', async ({ page }) => {
  const db = backend(); await page.setViewportSize({ width: 390, height: 844 }); await db.connect(page);
  for (const value of ['0', '-1', '1.5', '2147483648']) {
    await page.getByLabel('Item name', { exact: true }).fill('peas');
    await page.getByLabel('Quantity', { exact: true }).fill(value);
    await page.getByRole('button', { name: 'Add item', exact: true }).click();
  }
  expect(db.requests).toHaveLength(0);
  await add(page, 'Chicken thighs with a very long product description', '12');
  await expect(page.getByLabel('Quantity', { exact: true })).toHaveValue('1');
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/inventory-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '.local/inventory-desktop.png', fullPage: true });
});

test('Realtime changes refresh the list, including an item reaching zero', async ({ page }) => {
  const db = backend();
  let sendChange: (() => void) | undefined;
  await page.routeWebSocket('wss://*.supabase.co/**', socket => {
    socket.onMessage(raw => {
      const message = JSON.parse(String(raw));
      const [joinRef, ref, topic, event, payload] = message;
      if (event === 'phx_join' && payload.config.postgres_changes[0].table === 'inventory_items') {
        expect(payload.config.postgres_changes[0]).toEqual({ event: '*', schema: 'public', table: 'inventory_items', filter: `household_id=eq.${household}` });
        socket.send(JSON.stringify([joinRef, ref, topic, 'phx_reply', { status: 'ok', response: { postgres_changes: payload.config.postgres_changes.map((binding: object, index: number) => ({ ...binding, id: index + 1 })) } }]));
        sendChange = () => socket.send(JSON.stringify([joinRef, null, topic, 'postgres_changes', { ids: [1], data: { schema: 'public', table: 'inventory_items', type: 'UPDATE', commit_timestamp: new Date().toISOString(), record: db.items[0], old_record: {}, columns: [], errors: null } }]));
      } else if (event === 'heartbeat') socket.send(JSON.stringify([null, ref, topic, 'phx_reply', { status: 'ok', response: {} }]));
    });
  });
  await db.connect(page);
  await expect.poll(() => !!sendChange).toBe(true);
  db.items.push({ id: 'remote-item', name: 'Peas', quantity: 2 });
  sendChange!();
  await expect(page.getByLabel('Peas quantity')).toHaveText('2');
  db.items[0].quantity = 0; sendChange!();
  await expect(page.getByLabel('Peas quantity')).toHaveCount(0);
});

test('freezer folders separate duplicate names, move stock, and Undo a move', async ({ page }) => {
  const db = backend(); await db.connect(page);
  await add(page, 'peas', '2');
  await page.getByRole('button', { name: 'Add freezer', exact: true }).click();
  await page.getByLabel('Freezer name', { exact: true }).fill('Garage Freezer');
  await page.getByRole('button', { name: 'Save freezer', exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Garage Freezer', exact: true })).toBeVisible();
  await expect(page.getByLabel('Peas quantity')).toHaveCount(0);
  await add(page, 'peas', '3');
  await expect(page.getByLabel('Peas quantity')).toHaveText('3');
  await page.getByRole('button', { name: 'Main Freezer', exact: true }).click();
  await expect(page.getByLabel('Peas quantity')).toHaveText('2');
  await page.getByRole('button', { name: 'Freezer swap Peas', exact: true }).click();
  await expect(page.getByRole('dialog', { name: 'Freezer swap', exact: true })).toBeVisible();
  await page.getByLabel('Destination freezer').selectOption(db.freezers[1].id);
  await page.getByRole('button', { name: 'Increase swap quantity', exact: true }).click();
  await page.getByRole('button', { name: 'Swap items', exact: true }).click();
  await expect(page.getByLabel('Peas quantity')).toHaveCount(0);
  expect(db.items.find(i => i.freezer_id === db.freezers[1].id)?.quantity).toBe(5);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Peas quantity')).toHaveText('2');
  expect(db.items.find(i => i.freezer_id === db.freezers[1].id)?.quantity).toBe(3);
  await page.getByRole('button', { name: 'Garage Freezer', exact: true }).click();
  await page.getByRole('button', { name: 'Edit freezer name', exact: true }).click();
  await page.getByRole('textbox', { name: 'Edit freezer name', exact: true }).fill('Basement');
  await page.getByLabel('Item name', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Basement', exact: true })).toBeVisible();
  await expect(page.getByLabel('Peas quantity')).toHaveText('3');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/freezers-mobile.png', fullPage: true });
});

test('previously used suggestions include zero stock and fill a restock name', async ({ page }) => {
  const db = backend();
  db.items.push({ id: 'old-food', name: 'Chicken Thighs', quantity: 0 }, { id: 'other-food', name: 'Other Freezer Food', quantity: 0, freezer_id: 'other-freezer' });
  await db.connect(page);
  await expect(page.getByLabel('Chicken Thighs quantity')).toHaveCount(0);
  await page.getByLabel('Item name', { exact: true }).fill('chick');
  await page.getByRole('option', { name: 'Chicken Thighs', exact: true }).click();
  await expect(page.getByLabel('Item name', { exact: true })).toHaveValue('Chicken Thighs');
  expect(db.requests).toHaveLength(0);
  await page.getByRole('button', { name: 'Add item', exact: true }).click();
  await expect(page.getByLabel('Chicken Thighs quantity')).toHaveText('1');
  expect(db.items.filter(i => i.name === 'Chicken Thighs')).toHaveLength(1);
});

test('Name and Recently Changed sorting track plus, Undo, and persist on reload', async ({ page }) => {
  const db = backend(); await db.connect(page);
  await add(page, 'apples'); await add(page, 'peas');
  const names = page.locator('.item-list .item-title>span');
  await expect(names).toHaveText(['Apples', 'Peas']);
  await page.getByRole('combobox', { name: 'Sort by', exact: true }).selectOption('recent');
  await expect(names).toHaveText(['Peas', 'Apples']);
  await page.getByRole('button', { name: 'Add one Apples', exact: true }).click();
  await expect(names).toHaveText(['Apples', 'Peas']);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Apples quantity')).toHaveText('1');
  await page.reload();
  await expect(page.getByRole('combobox', { name: 'Sort by', exact: true })).toHaveValue('recent');
  await expect(names).toHaveText(['Apples', 'Peas']);
  await page.getByRole('combobox', { name: 'Sort by', exact: true }).selectOption('name');
  await page.setViewportSize({ width: 390, height: 844 });
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/compact-inventory-mobile.png', fullPage: true });
  await page.setViewportSize({ width: 1440, height: 1000 });
  await page.screenshot({ path: '.local/compact-inventory-desktop.png', fullPage: true });
});

test('item autocomplete stays attached to the input and supports keyboard selection and dismissal', async ({ page }) => {
  const db = backend();
  db.items.push({ id: 'thighs', name: 'Chicken Thighs', quantity: 0 }, { id: 'breasts', name: 'Chicken Breasts', quantity: 0 });
  await db.connect(page);
  const input = page.getByRole('combobox', { name: 'Item name', exact: true });
  await input.focus(); await expect(page.getByRole('listbox')).toHaveCount(0);
  await input.fill('ch');
  const list = page.getByRole('listbox', { name: 'Matching item names' });
  await expect(list.getByRole('option')).toHaveText(['Chicken Breasts', 'Chicken Thighs']);
  const field = (await input.boundingBox())!; const dropdown = (await list.boundingBox())!;
  expect(Math.abs(field.x - dropdown.x)).toBeLessThan(2); expect(Math.abs(field.width - dropdown.width)).toBeLessThan(2);
  expect(dropdown.y).toBeGreaterThanOrEqual(field.y + field.height);
  await input.press('ArrowDown');
  await expect(list.getByRole('option', { name: 'Chicken Breasts' })).toHaveAttribute('aria-selected', 'true');
  await input.press('ArrowDown'); await input.press('Enter');
  await expect(input).toHaveValue('Chicken Thighs'); await expect(list).toHaveCount(0);
  expect(db.requests).toHaveLength(0);
  await input.fill('ch'); await expect(list).toBeVisible(); await input.press('Escape');
  await expect(list).toHaveCount(0); await expect(input).toHaveValue('ch');
  await input.press('ArrowDown'); await expect(list).toBeVisible(); await input.press('Tab');
  await expect(page.getByLabel('Quantity', { exact: true })).toBeFocused(); await expect(list).toHaveCount(0);
  await input.fill('ch'); await expect(list).toBeVisible();
  await page.getByRole('heading', { name: 'Your freezers', exact: true }).click(); await expect(list).toHaveCount(0);
});

test('autocomplete can be tapped on mobile', async ({ browser }) => {
  const context = await browser.newContext({ viewport: { width: 390, height: 844 }, hasTouch: true, isMobile: true });
  const page = await context.newPage(); const db = backend();
  db.items.push({ id: 'thighs', name: 'Chicken Thighs', quantity: 0 }, { id: 'breasts', name: 'Chicken Breasts', quantity: 0 });
  await db.connect(page); await page.getByLabel('Item name', { exact: true }).fill('ch');
  await expect(page.getByRole('listbox')).toBeVisible();
  await page.screenshot({ path: '.local/autocomplete-mobile.png', fullPage: true });
  await page.getByRole('option', { name: 'Chicken Breasts', exact: true }).tap();
  await expect(page.getByLabel('Item name', { exact: true })).toHaveValue('Chicken Breasts');
  await expect(page.getByRole('listbox')).toHaveCount(0); expect(db.requests).toHaveLength(0);
  await context.close();
});

test('freezer swap dialog moves a chosen quantity, validates stock, and supports Undo and cancel', async ({ page }) => {
  const db = backend(); db.freezers.push({ id: 'inside-freezer', name: 'Inside Freezer', is_default: false });
  db.items.push({ id: 'thighs', name: 'Chicken Thighs', quantity: 6 }, { id: 'inside-thighs', name: 'Chicken Thighs', quantity: 1, freezer_id: 'inside-freezer' });
  await db.connect(page);
  const trigger = page.getByRole('button', { name: 'Freezer swap Chicken Thighs', exact: true });
  await trigger.click(); const dialog = page.getByRole('dialog', { name: 'Freezer swap', exact: true });
  await expect(dialog).toBeVisible();
  await expect(dialog.getByLabel('Destination freezer')).toHaveValue('inside-freezer');
  const quantity = dialog.getByLabel('Swap quantity', { exact: true });
  const minus = dialog.getByRole('button', { name: 'Decrease swap quantity', exact: true });
  const plus = dialog.getByRole('button', { name: 'Increase swap quantity', exact: true });
  await expect(quantity).toHaveText('1'); await expect(minus).toBeDisabled();
  await expect(dialog.getByRole('spinbutton')).toHaveCount(0);
  await dialog.getByLabel('Destination freezer').selectOption('inside-freezer');
  for (let count = 0; count < 5; count++) await plus.click();
  await expect(quantity).toHaveText('6'); await expect(plus).toBeDisabled();
  for (let count = 0; count < 5; count++) await minus.click();
  await expect(quantity).toHaveText('1'); await expect(minus).toBeDisabled();
  expect(db.requests).toHaveLength(0);
  await plus.click(); await page.setViewportSize({ width: 390, height: 844 });
  await page.screenshot({ path: '.local/freezer-swap-mobile.png', fullPage: true });
  await dialog.getByRole('button', { name: 'Swap items' }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByLabel('Chicken Thighs quantity')).toHaveText('4');
  expect(db.items.find(i => i.id === 'inside-thighs')?.quantity).toBe(3);
  expect(db.requests[0].p_quantity).toBe(2);
  await page.getByRole('button', { name: 'Undo', exact: true }).click();
  await expect(page.getByLabel('Chicken Thighs quantity')).toHaveText('6');
  expect(db.items.find(i => i.id === 'inside-thighs')?.quantity).toBe(1);
  await trigger.click(); await dialog.getByRole('button', { name: 'Cancel', exact: true }).click();
  await expect(trigger).toBeFocused();
  await trigger.click(); await page.keyboard.press('Escape'); await expect(dialog).toHaveCount(0);
  expect(db.requests).toHaveLength(2);
});

test('freezer swap keeps errors in its dialog and retries an uncertain full-stock swap safely', async ({ page }) => {
  const db = backend(); db.freezers.push({ id: 'inside-freezer', name: 'Inside Freezer', is_default: false });
  db.items.push({ id: 'thighs', name: 'Chicken Thighs', quantity: 2 }); await db.connect(page);
  await page.getByRole('button', { name: 'Freezer swap Chicken Thighs', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Freezer swap', exact: true });
  await dialog.getByLabel('Destination freezer').selectOption('inside-freezer');
  await dialog.getByRole('button', { name: 'Increase swap quantity', exact: true }).click(); db.loseNextResponse();
  await dialog.getByRole('button', { name: 'Swap items' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Couldn’t confirm the save');
  await expect(dialog.getByRole('button', { name: 'Increase swap quantity', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Decrease swap quantity', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Retry save', exact: true }).click();
  await expect(dialog).toHaveCount(0); await expect(page.getByLabel('Chicken Thighs quantity')).toHaveCount(0);
  expect(db.requests[0]).toEqual(db.requests[1]); expect(db.items.find(i => i.freezer_id === 'inside-freezer')?.quantity).toBe(2);
});

test('stock changing on another phone leaves a rejected swap editable in its dialog', async ({ page }) => {
  const db = backend(); db.freezers.push({ id: 'inside-freezer', name: 'Inside Freezer', is_default: false });
  db.items.push({ id: 'thighs', name: 'Chicken Thighs', quantity: 6 }); await db.connect(page);
  await page.getByRole('button', { name: 'Freezer swap Chicken Thighs', exact: true }).click();
  const dialog = page.getByRole('dialog', { name: 'Freezer swap', exact: true });
  await dialog.getByLabel('Destination freezer').selectOption('inside-freezer');
  await dialog.getByRole('button', { name: 'Increase swap quantity', exact: true }).click();
  await dialog.getByRole('button', { name: 'Increase swap quantity', exact: true }).click();
  await page.route('**/rpc/move_inventory', async route => {
    db.items[0].quantity = 1;
    await route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ code: '22023', message: 'Only 1 available in this freezer. Choose a smaller quantity.' }) });
  }, { times: 1 });
  await dialog.getByRole('button', { name: 'Swap items' }).click();
  await expect(dialog.getByRole('alert')).toContainText('Only 1 available');
  await expect(dialog.getByLabel('Swap quantity', { exact: true })).toHaveText('1');
  await expect(dialog.getByRole('button', { name: 'Increase swap quantity', exact: true })).toBeDisabled();
  await expect(dialog.getByRole('button', { name: 'Decrease swap quantity', exact: true })).toBeDisabled();
  await dialog.getByRole('button', { name: 'Swap items' }).click();
  await expect(dialog).toHaveCount(0);
  expect(db.items.find(i => i.freezer_id === 'inside-freezer')?.quantity).toBe(1);
});

test('freezer title saves inline on blur and Enter, cancels on Escape, and retains a failed edit', async ({ page }) => {
  const db = backend(); await db.connect(page);
  let saves = 0;
  page.on('request', request => { if (request.url().endsWith('/rpc/save_freezer')) saves++; });
  const edit = page.getByRole('button', { name: 'Edit freezer name', exact: true });
  const field = page.getByRole('textbox', { name: 'Edit freezer name', exact: true });
  await edit.click(); await field.fill('Chest Freezer');
  await page.getByLabel('Item name', { exact: true }).click();
  await expect(page.getByRole('heading', { name: 'Chest Freezer', exact: true })).toBeVisible();
  expect(saves).toBe(1);
  await edit.click(); await field.fill('Cancelled'); await field.press('Escape');
  await expect(page.getByRole('heading', { name: 'Chest Freezer', exact: true })).toBeVisible(); expect(saves).toBe(1);
  await edit.click(); await field.fill('   '); await field.press('Enter');
  await expect(page.getByRole('alert')).toContainText('Enter a freezer name'); expect(saves).toBe(1);
  await field.fill('Kitchen Freezer'); await field.press('Enter');
  await expect(page.getByRole('heading', { name: 'Kitchen Freezer', exact: true })).toBeVisible(); expect(saves).toBe(2);
  await page.route('**/rpc/save_freezer', route => route.fulfill({ status: 400, contentType: 'application/json', body: JSON.stringify({ message: 'A freezer with that name already exists' }) }), { times: 1 });
  await edit.click(); await field.fill('Duplicate'); await page.getByLabel('Item name', { exact: true }).click();
  await expect(page.getByRole('alert')).toContainText('already exists'); await expect(field).toHaveValue('Duplicate');
  await field.fill('Garage Freezer'); await field.press('Enter');
  await expect(page.getByRole('heading', { name: 'Garage Freezer', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Save freezer', exact: true })).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 });
  await edit.click(); await page.screenshot({ path: '.local/inline-freezer-name-mobile.png', fullPage: true });
});

test('profile settings live in the header and close on Escape or outside click', async ({ page }) => {
  const db = backend(); await db.connect(page);
  const profile = page.getByRole('button', { name: 'Profile settings', exact: true });
  const settings = page.getByRole('region', { name: 'App settings', exact: true });
  await expect(page.getByText('GOOD THINGS IN STORE', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Your next meal might already be here.', { exact: true })).toHaveCount(0);
  await expect(page.getByText('Our Freezer', { exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Single item', exact: true })).toHaveCount(0);
  await expect(page.getByRole('button', { name: 'Multiple items', exact: true })).toHaveCount(0);
  await expect(page.getByLabel('Item name', { exact: true })).toBeVisible();
  await expect(page.getByRole('banner').getByRole('button', { name: 'Profile settings', exact: true })).toBeVisible();
  await expect(page.getByRole('button', { name: 'Sign out', exact: true })).toHaveCount(0);
  await profile.click(); await expect(settings.getByRole('button', { name: 'Share household' })).toBeVisible();
  await expect(settings.getByText('Our Freezer', { exact: true })).toBeVisible();
  await expect(settings.getByRole('button', { name: 'Sign out' })).toBeVisible();
  await page.keyboard.press('Escape'); await expect(settings).toHaveCount(0); await expect(profile).toBeFocused();
  await profile.click(); await page.getByRole('heading', { name: 'Your freezers', exact: true }).click(); await expect(settings).toHaveCount(0);
  await page.setViewportSize({ width: 390, height: 844 }); await profile.click();
  expect(await page.evaluate(() => document.documentElement.scrollWidth <= innerWidth)).toBe(true);
  await page.screenshot({ path: '.local/profile-settings-mobile.png', fullPage: true });
});
