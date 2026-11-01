import { invitationHandler } from './handler.ts';

Deno.serve(invitationHandler({
  url: Deno.env.get('SUPABASE_URL')!,
  anonKey: Deno.env.get('SUPABASE_ANON_KEY')!,
  serviceKey: Deno.env.get('SUPABASE_SERVICE_ROLE_KEY')!,
  appUrl: Deno.env.get('HOUSEHOLD_APP_URL') || 'https://freezer-inventory.ryanmercier88.workers.dev/',
}));
