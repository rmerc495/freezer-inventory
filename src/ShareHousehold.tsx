import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from './supabase';

export function ShareHousehold({ householdId, onClose }: { householdId: string; onClose: () => void }) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [email, setEmail] = useState('');
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [sent, setSent] = useState('');
  useEffect(() => { dialog.current?.showModal(); }, []);
  async function send(event: FormEvent) {
    event.preventDefault(); setBusy(true); setError('');
    try {
      const { data, error } = await supabase!.functions.invoke('invite-household', {
        body: { household_id: householdId, email: email.trim().toLowerCase() },
      });
      if (error) {
        let detail = '';
        try { detail = (await error.context?.json())?.error ?? ''; } catch { /* Use the connection error below. */ }
        throw new Error(detail || 'Could not send the invitation. Please try again.');
      }
      if (!data?.sent) throw new Error('The invitation was not sent. Please try again.');
      setSent(email.trim());
    } catch (error) { setError(error instanceof Error ? error.message : 'Could not send the invitation.'); }
    finally { setBusy(false); }
  }
  return <dialog ref={dialog} className="swap-dialog" onCancel={event => { if (busy) event.preventDefault(); }} onClose={onClose} aria-labelledby="share-title">
    <h2 id="share-title">Share your household</h2>
    {sent ? <><p role="status">Invitation sent to <strong>{sent}</strong>. They can open the email to set up their account and join your household.</p><button className="primary" onClick={() => dialog.current?.close()}>Done</button></> : <>
      <p>Enter the email address they’ll use to sign in. We’ll email an invitation to join your shared freezers.</p>
      <form onSubmit={send}>
        <label>Their email address<input type="email" autoComplete="email" autoFocus required maxLength={254} value={email} disabled={busy} onChange={event => setEmail(event.target.value)}/></label>
        {error && <p className="error" role="alert">{error}</p>}
        <div className="swap-actions"><button type="button" className="secondary" disabled={busy} onClick={() => dialog.current?.close()}>Cancel</button><button className="primary" disabled={busy}>{busy ? 'Sending…' : 'Send invitation'}</button></div>
      </form>
    </>}
  </dialog>;
}
