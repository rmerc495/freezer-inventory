type Environment = { url: string; anonKey: string; serviceKey: string; appUrl: string };
type Fetcher = typeof fetch;
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function invitationHandler(env: Environment, requestFetch: Fetcher = fetch) {
  return async (request: Request): Promise<Response> => {
    const cors = { 'Access-Control-Allow-Origin': '*', 'Access-Control-Allow-Headers': 'authorization, x-client-info, apikey, content-type', 'Access-Control-Allow-Methods': 'POST, OPTIONS' };
    const reply = (status: number, body: unknown) => Response.json(body, { status, headers: cors });
    if (request.method === 'OPTIONS') return new Response(null, { status: 204, headers: cors });
    if (request.method !== 'POST') return reply(405, { error: 'Method not allowed.' });
    const authorization = request.headers.get('Authorization') ?? '';
    if (!authorization.startsWith('Bearer ')) return reply(401, { error: 'Please sign in again.' });
    try {
      const headers = { apikey: env.anonKey, Authorization: authorization, 'Content-Type': 'application/json' };
      const userResponse = await requestFetch(env.url + '/auth/v1/user', { headers, signal: AbortSignal.timeout(10000) });
      if (!userResponse.ok) return reply(401, { error: 'Please sign in again.' });
      const user = await userResponse.json();
      if (!user.id || !user.email_confirmed_at) return reply(403, { error: 'Confirm your email before inviting someone.' });
      let input;
      try { input = await request.json(); } catch { return reply(400, { error: 'Enter a valid email address.' }); }
      const email = typeof input.email === 'string' ? input.email.trim().toLowerCase() : '';
      if (!uuid.test(input.household_id ?? '') || email.length > 254 || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))
        return reply(400, { error: 'Enter a valid email address and household.' });
      // Authorization, rate limiting, and token creation occur atomically in the owner-only RPC.
      const prepared = await requestFetch(env.url + '/rest/v1/rpc/create_household_email_invite', {
        method: 'POST', headers, body: JSON.stringify({ p_household_id: input.household_id, p_email: email }), signal: AbortSignal.timeout(10000),
      });
      if (!prepared.ok) {
        const failure = await prepared.json();
        return reply(prepared.status === 403 ? 403 : 400, { error: failure.message || 'Could not prepare the invitation.' });
      }
      const token = await prepared.json();
      const redirect = new URL(env.appUrl);
      redirect.searchParams.set('invite', token);
      const invited = await requestFetch(env.url + '/auth/v1/invite?redirect_to=' + encodeURIComponent(redirect.toString()), {
        method: 'POST', headers: { apikey: env.serviceKey, Authorization: 'Bearer ' + env.serviceKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ email }), signal: AbortSignal.timeout(20000),
      });
      if (invited.ok) return reply(200, { sent: true });
      const failure = await invited.json();
      // Existing accounts receive an email sign-in link without changing their password.
      if (failure.error_code === 'email_exists' || failure.code === 'email_exists') {
        const existing = await requestFetch(env.url + '/auth/v1/otp?redirect_to=' + encodeURIComponent(redirect.toString()), {
          method: 'POST', headers: { apikey: env.anonKey, 'Content-Type': 'application/json' },
          body: JSON.stringify({ email, create_user: false }), signal: AbortSignal.timeout(20000),
        });
        if (existing.ok) return reply(200, { sent: true });
      }
      // Do not return provider details or claim delivery when SMTP rejected the request.
      return reply(502, { error: 'The email provider could not send the invitation. Check Supabase email settings, then try again in a minute.' });
    } catch {
      return reply(502, { error: 'Could not finish sending the invitation. Please wait a minute and try again.' });
    }
  };
}

