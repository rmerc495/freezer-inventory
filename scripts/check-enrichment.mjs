// A tiny paid smoke check. Never logs the API key or provider error bodies.
import { enrichmentRequest, parseMetadata } from '../supabase/functions/enrich-items/enrichment.ts';
process.loadEnvFile('.env.local');
const key = process.env.OPENAI_ENRICHMENT_KEY;
if (!key) throw new Error('OPENAI_ENRICHMENT_KEY is missing');
for (const name of ['chicken nuggets', 'broccoli', 'green beans']) {
  const response = await fetch('https://api.openai.com/v1/responses', {
    method: 'POST', headers: { Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(enrichmentRequest(name)), signal: AbortSignal.timeout(30000),
  });
  if (!response.ok) throw new Error(`OpenAI check failed (HTTP ${response.status}); key not logged`);
  const body = await response.json();
  console.log(JSON.stringify({ name, metadata: parseMetadata(body), usage: body.usage }));
}
