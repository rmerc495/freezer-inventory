import { authRedirectUrl } from './supabase';

const invitationKey = 'freezer.pending-invitation';
const uuid = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

export function readInvitation(): string | null {
  const url = new URL(window.location.href);
  const token = url.searchParams.get('invite');
  if (token !== null) {
    url.searchParams.delete('invite');
    window.history.replaceState(null, '', url);
    if (uuid.test(token)) {
      localStorage.setItem(invitationKey, JSON.stringify({ token, expires: Date.now() + 7 * 86400000 }));
      return token;
    }
    clearInvitation();
    return null;
  }
  try {
    const saved = JSON.parse(localStorage.getItem(invitationKey) ?? 'null');
    if (saved && uuid.test(saved.token) && saved.expires > Date.now()) return saved.token;
  } catch { /* Invalid browser state is discarded. */ }
  clearInvitation();
  return null;
}

export function clearInvitation() { localStorage.removeItem(invitationKey); }

export function invitationUrl(token: string) {
  const url = new URL(authRedirectUrl);
  url.searchParams.set('invite', token);
  return url.toString();
}

export function confirmationRedirect(invitation: string | null) {
  return invitation ? invitationUrl(invitation) : authRedirectUrl;
}

// Clipboard API is unavailable on a phone's LAN HTTP preview. The synchronous
// fallback also works when a browser requires copying during the button gesture.
export async function copyInviteLink(value: string) {
  if (navigator.clipboard?.writeText) {
    try { await navigator.clipboard.writeText(value); return; } catch { /* Try manual selection below. */ }
  }
  const input = document.createElement('textarea');
  input.value = value;
  input.style.position = 'fixed'; input.style.top = '0'; input.style.left = '-9999px';
  document.body.append(input); input.focus(); input.select(); input.setSelectionRange(0, value.length);
  const copied = document.execCommand('copy'); input.remove();
  if (!copied) throw new Error('Select the invite link below and copy it, then paste it into a text message.');
}
