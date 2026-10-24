import { readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';
process.loadEnvFile('.env.local');
const values = [process.env.OPENAI_ENRICHMENT_KEY, readFileSync('.local/enrichment-worker-token', 'utf8').trim()];
if (values.some(value => !value)) throw new Error('Secret check not configured');
function check(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    const file = join(path, entry.name);
    if (entry.isDirectory()) check(file);
    else if (values.some(value => readFileSync(file, 'utf8').includes(value))) throw new Error('Secret found in client bundle');
  }
}
check('dist');
console.log('Production bundle contains neither enrichment key nor worker credential.');
