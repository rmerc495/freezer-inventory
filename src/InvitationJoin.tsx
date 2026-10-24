import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

export function InvitationJoin({ token, onJoined, onCancel }: { token: string; onJoined: (id: string) => void; onCancel: () => void }) {
  const [attempt, setAttempt] = useState(0);
  const [error, setError] = useState('');
  const joined = useRef(onJoined);
  joined.current = onJoined;
  useEffect(() => {
    let active = true;
    setError('');
    void supabase!.rpc('join_household', { p_code: token }).abortSignal(AbortSignal.timeout(15000)).then(({ data, error }) => {
      if (!active) return;
      if (error) setError(error.message); else joined.current(data);
    });
    return () => { active = false; };
  }, [token, attempt]);
  return <main className="confirmation-layout"><section className="auth-card confirmation-card"><h1>Join your household</h1>{error ? <><p className="error" role="alert">{error}</p><button className="primary" onClick={() => setAttempt(n => n + 1)}>Try invitation again</button><button className="text-button" onClick={onCancel}>Continue without this invitation</button></> : <p role="status">Connecting your account to the shared household…</p>}</section></main>;
}
