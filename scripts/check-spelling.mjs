// Tiny paid checks against the same schema/prompt used by the worker.
import assert from 'node:assert/strict';
import { enrichmentRequest, parseMetadata } from '../supabase/functions/enrich-items/enrichment.ts';
process.loadEnvFile('.env.local');
const key = process.env.OPENAI_ENRICHMENT_KEY;
if (!key) throw new Error('Missing enrichment key');
for (const [name, expected] of [['peperoni', 'pepperoni'], ['chikcen', 'chicken'], ['Tillamook', null], ['chicken wings', null], ['popsicle', null]]) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(enrichmentRequest(name)), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`Spelling check failed (HTTP ${response.status})`);
  const body = await response.json();
  const metadata = parseMetadata(body);
  assert.equal(metadata.corrected_name ?? null, expected, `Unexpected correction for ${name}`);
  console.log(JSON.stringify({ name, corrected_name: metadata.corrected_name ?? null, usage: body.usage }));
}
