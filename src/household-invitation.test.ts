import { describe, it, expect, vi } from 'vitest';
import { invitationHandler } from '../supabase/functions/invite-household/handler';

const env = { url: 'https://project.supabase.co', anonKey: 'public-key', serviceKey: 'server-only-key', appUrl: 'https://freezer.example/' };
const household = '44444444-4444-4444-8444-444444444444';
const token = '12345678-1234-4234-8234-123456789abc';
const request = () => new Request('https://example/invite', { method: 'POST', headers: { Authorization: 'Bearer user-token', 'Content-Type': 'application/json' }, body: JSON.stringify({ email: ' Partner@Example.com ', household_id: household }) });
describe('household invitation handler', () => {
  it('rejects anonymous callers without contacting the admin API', async () => {
    const fetcher = vi.fn();
    expect((await invitationHandler(env, fetcher)(new Request('https://example', { method: 'POST' }))).status).toBe(401);
    expect(fetcher).not.toHaveBeenCalled();
  });
  it('checks household ownership before creating any Auth account', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: 'owner', email_confirmed_at: 'today' }))
      .mockResolvedValueOnce(Response.json({ message: 'Household owner required' }, { status: 403 }));
    expect((await invitationHandler(env, fetcher)(request())).status).toBe(403);
    expect(fetcher).toHaveBeenCalledTimes(2);
  });
  it('normalizes the recipient and sends an email with the bound callback without exposing secrets', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: 'owner', email_confirmed_at: 'today' }))
      .mockResolvedValueOnce(Response.json(token)).mockResolvedValueOnce(Response.json({ id: 'new-user' }));
    const result = await invitationHandler(env, fetcher)(request());
    expect(await result.json()).toEqual({ sent: true });
    expect(JSON.parse(fetcher.mock.calls[1][1].body)).toEqual({ p_household_id: household, p_email: 'partner@example.com' });
    expect(new URL(fetcher.mock.calls[2][0]).searchParams.get('redirect_to')).toBe(env.appUrl + '?invite=' + token);
    expect(JSON.parse(fetcher.mock.calls[2][1].body)).toEqual({ email: 'partner@example.com' });
  });
  it('sends existing users a sign-in email without creating or resetting their account', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: 'owner', email_confirmed_at: 'today' }))
      .mockResolvedValueOnce(Response.json(token)).mockResolvedValueOnce(Response.json({ code: 'email_exists' }, { status: 422 }))
      .mockResolvedValueOnce(Response.json({}));
    expect((await invitationHandler(env, fetcher)(request())).status).toBe(200);
    expect(JSON.parse(fetcher.mock.calls[3][1].body).create_user).toBe(false);
  });
  it('reports an email rejection instead of claiming that the invite was sent', async () => {
    const fetcher = vi.fn().mockResolvedValueOnce(Response.json({ id: 'owner', email_confirmed_at: 'today' }))
      .mockResolvedValueOnce(Response.json(token)).mockResolvedValueOnce(Response.json({ code: 'email_address_not_authorized' }, { status: 403 }));
    const result = await invitationHandler(env, fetcher)(request());
    expect(result.status).toBe(502);
    expect(await result.json()).not.toHaveProperty('sent');
  });
});
