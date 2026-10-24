import { readFileSync } from 'node:fs';
process.loadEnvFile('.env.local');
const url = `${process.env.VITE_SUPABASE_URL}/functions/v1/enrich-items`;
const unauthorized = await fetch(url, { method: 'POST', body: '{}' });
if (unauthorized.status !== 401) throw new Error(`Expected 401, received ${unauthorized.status}`);
const secret = readFileSync('.local/enrichment-worker-token', 'utf8').trim();
const authorized = await fetch(url, { method: 'POST', headers: { 'Content-Type': 'application/json', 'x-worker-secret': secret }, body: '{}', signal: AbortSignal.timeout(55000) });
if (!authorized.ok) throw new Error(`Worker check failed (HTTP ${authorized.status})`);
console.log(JSON.stringify({ unauthorized: unauthorized.status, authorized: authorized.status, worker: await authorized.json() }));
