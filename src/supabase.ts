import { createClient } from '@supabase/supabase-js';
import { createSessionStorage } from './session-storage';

export const sessionStorageAdapter = createSessionStorage(window.localStorage, window.sessionStorage);
const url = import.meta.env.VITE_SUPABASE_URL;
const key = import.meta.env.VITE_SUPABASE_PUBLISHABLE_KEY;
export const supabase = url && key ? createClient(url, key, {
  auth: { storage: sessionStorageAdapter, persistSession: true, autoRefreshToken: true, detectSessionInUrl: true },
}) : null;
