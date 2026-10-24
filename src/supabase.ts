import { createClient } from '@supabase/supabase-js';
import { createSessionStorage } from './session-storage';

export const sessionStorageAdapter = createSessionStorage(window.localStorage, window.sessionStorage);
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
// A LAN preview needs one callback address reachable from both the PC and phone.
export const authRedirectUrl = import.meta.env.VITE_AUTH_REDIRECT_URL || `${window.location.origin}/`;
export const supabase = url && key ? createClient(url, key, {
  auth: { storage: sessionStorageAdapter, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
}) : null;
