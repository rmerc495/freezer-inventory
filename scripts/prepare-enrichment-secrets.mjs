// Prepare ignored upload files. Values are never printed or passed as shell args.
import { existsSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { randomBytes } from 'node:crypto';
process.loadEnvFile('.env.local');
const key = process.env.OPENAI_ENRICHMENT_KEY;
const url = process.env.VITE_SUPABASE_URL;
if (!key || !url || !/^https:\/\/[a-z]+\.supabase\.co$/.test(url)) throw new Error('Missing enrichment key or invalid Supabase URL');
mkdirSync('.local', { recursive: true });
const tokenPath = '.local/enrichment-worker-token';
const token = existsSync(tokenPath) ? readFileSync(tokenPath, 'utf8').trim() : randomBytes(32).toString('hex');
if (!/^[a-f0-9]{64}$/.test(token)) throw new Error('Invalid saved worker token');
writeFileSync(tokenPath, token);
writeFileSync('.local/enrichment-secrets.env', `OPENAI_ENRICHMENT_KEY=${JSON.stringify(key)}\nENRICHMENT_WORKER_SECRET=${token}\n`);
const quote = value => `'${value.replaceAll("'", "''")}'`;
const settings = { enrichment_worker_url: `${url}/functions/v1/enrich-items`, enrichment_worker_token: token };
const commands = Object.entries(settings).map(([name, value]) => `
  select id into secret_id from vault.secrets where name=${quote(name)};
  if secret_id is null then perform vault.create_secret(${quote(value)},${quote(name)});
  else perform vault.update_secret(secret_id,${quote(value)},${quote(name)}); end if;`);
writeFileSync('.local/enrichment-vault.sql', `do $$ declare secret_id uuid; begin ${commands.join('\n')} end; $$;`);
console.log('Prepared ignored secret upload files; no values logged.');
