import { enrichmentRequest, parseMetadata, MODEL } from './enrichment.ts';
import { drainQueue, type JobResult } from './queue.ts';

// No browser access: pg_cron supplies a dedicated random worker secret.
// The service key is used only for the tightly scoped database worker RPCs.
const env = (name: string) => Deno.env.get(name) ?? '';
async function rpc(name: string, args: Record<string, unknown> = {}, deadline = Date.now() + 15000) {
  const key = env('SUPABASE_SERVICE_ROLE_KEY');
  const response = await fetch(`${env('SUPABASE_URL')}/rest/v1/rpc/${name}`, {
    method: 'POST', headers: { apikey: key, Authorization: `Bearer ${key}`, 'Content-Type': 'application/json' },
    body: JSON.stringify(args), signal: AbortSignal.timeout(Math.max(1, Math.min(15000, deadline - Date.now()))),
  });
  if (!response.ok) throw new Error('database_request_failed');
  return await response.json();
}

Deno.serve(async (request: Request) => {
  if (request.method !== 'POST') return new Response('Method not allowed', { status: 405 });
  const secret = env('ENRICHMENT_WORKER_SECRET');
  if (!secret || request.headers.get('x-worker-secret') !== secret) return new Response('Unauthorized', { status: 401 });
  const apiKey = env('OPENAI_ENRICHMENT_KEY');
  if (!apiKey) return new Response('Enrichment not configured', { status: 503 });
  try {
    type Job = { household_id: string; normalized_name: string; lease_token: string };
    const result = await drainQueue<Job>({
      claim: deadline => rpc('claim_item_enrichment', {}, deadline),
      process: async (job, deadline): Promise<JobResult> => {
      const args = { p_household_id: job.household_id, p_name: job.normalized_name, p_lease_token: job.lease_token };
      try {
        const response = await fetch('https://api.openai.com/v1/responses', {
          method: 'POST', headers: { Authorization: `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
          body: JSON.stringify(enrichmentRequest(job.normalized_name)), signal: AbortSignal.timeout(Math.max(1, Math.min(25000, deadline - Date.now() - 3000))),
        });
        if (!response.ok) throw new Error(`openai_http_${response.status}`);
        const metadata = parseMetadata(await response.json());
        const applied = await rpc('finish_item_enrichment_with_spelling', { ...args, p_tags: metadata.tags, p_synonyms: metadata.synonyms, p_model: MODEL, p_corrected_name: metadata.corrected_name ?? null }, deadline);
        return applied ? 'completed' : 'failed';
      } catch (error) {
        // Only safe error codes are stored; never provider bodies, names, or keys.
        const code = error instanceof Error && /^openai_http_\d{3}$/.test(error.message) ? error.message : 'enrichment_failed';
        await rpc('finish_item_enrichment_with_spelling', { ...args, p_error: code }, deadline);
        return code === 'openai_http_429' ? 'rate_limited' : 'failed';
      }
      },
    });
    return Response.json(result, { status: result.stopped === 'worker_error' ? 503 : 200 });
  } catch {
    return Response.json({ error: 'worker_failed' }, { status: 503 });
  }
});
