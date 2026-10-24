import { useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { Freezers } from './Freezers';
import { ProfileMenu } from './ProfileMenu';
import { InvitationJoin } from './InvitationJoin';
import { readInvitation, clearInvitation, invitationUrl, confirmationRedirect, copyInviteLink } from './invitation';
import { supabase, sessionStorageAdapter } from './supabase';

type Household = { id: string; name: string; owner_id: string };
type Mode = 'login' | 'signup' | 'forgot' | 'reset';
const message = (error: unknown) => error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : 'Something went wrong. Please try again.';
const recoveryKey = 'freezer.password-recovery';

function Mark() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M16 3v26M5 9l22 14M5 23 27 9M12 6l4 4 4-4M12 26l4-4 4 4M6 13l6-1-1-6M26 19l-6 1 1 6M6 19l6 1-1 6M26 13l-6-1 1-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg></span>;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [invitation, setInvitation] = useState(readInvitation);
  const [joinedHousehold, setJoinedHousehold] = useState('');
  const [mode, setMode] = useState<Mode>(() => sessionStorage.getItem(recoveryKey) ? 'reset' : invitation ? 'signup' : 'login');
  const [authError, setAuthError] = useState('');
  useEffect(() => {
    if (!supabase) { setLoading(false); return; }
    // Supabase handles confirmation and recovery redirects before INITIAL_SESSION.
    const { data } = supabase.auth.onAuthStateChange((event, next) => {
      if (event === 'PASSWORD_RECOVERY') { sessionStorage.setItem(recoveryKey, 'true'); setMode('reset'); }
      if (event === 'SIGNED_OUT') { sessionStorage.removeItem(recoveryKey); setMode('login'); }
      setSession(next); setLoading(false);
    });
    void supabase.auth.getSession().then(({ error }) => { if (error) { setAuthError(message(error)); setLoading(false); } });
    return () => data.subscription.unsubscribe();
  }, []);

  if (!supabase) return <main className="setup-error"><Mark/><h1>A little setup first</h1><p>Add the public Supabase URL and key to your environment, then restart the app.</p></main>;
  return <div className="app-shell">
    <header className="brand"><Mark/><span>freezer<span className="brand-light"> inventory</span></span><span className="brand-caption">A LITTLE LESS DIGGING.</span><div id="profile-slot"/></header>
    {loading ? <main className="loading" role="status">Opening your freezer…</main> : !session || mode === 'reset' ?
      <Auth invitation={invitation} mode={mode} setMode={setMode} authError={authError} onPasswordSaved={() => { sessionStorage.removeItem(recoveryKey); setMode('login'); }}/>
      : invitation ? <InvitationJoin token={invitation} onJoined={id => { clearInvitation(); setInvitation(null); setJoinedHousehold(id); }} onCancel={() => { clearInvitation(); setInvitation(null); }}/> : <HouseholdApp key={session.user.id} session={session} initialHousehold={joinedHousehold}/>}
    <footer>Less wondering what’s in there. More knowing what’s for dinner.</footer>
  </div>;
}

function Auth({ invitation, mode, setMode, onPasswordSaved, authError }: { invitation: string | null; mode: Mode; setMode: (mode: Mode) => void; onPasswordSaved: () => void; authError: string }) {
  const [email, setEmail] = useState('');
  const [password, setPassword] = useState('');
  const [confirm, setConfirm] = useState('');
  const [remember, setRemember] = useState(sessionStorageAdapter.remembered());
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [notice, setNotice] = useState('');
  const [confirmationEmail, setConfirmationEmail] = useState('');
  function switchMode(next: Mode) { setMode(next); setError(''); setNotice(''); setPassword(''); setConfirm(''); }
  async function submit(event: FormEvent) {
    event.preventDefault(); setError(''); setNotice(''); setBusy(true);
    try {
      if ((mode === 'signup' || mode === 'reset') && password !== confirm) throw new Error('Your passwords don’t match.');
      const redirectTo = confirmationRedirect(invitation);
      if (mode === 'forgot') {
        const { error } = await supabase!.auth.resetPasswordForEmail(email.trim(), { redirectTo });
        if (error) throw error;
        setNotice('If an account exists for that email, you’ll receive a password reset link.');
      } else if (mode === 'reset') {
        const { error } = await supabase!.auth.updateUser({ password });
        if (error) throw error;
        onPasswordSaved();
      } else {
        sessionStorageAdapter.setRemember(remember);
        if (mode === 'signup') {
          const { data, error } = await supabase!.auth.signUp({ email: email.trim(), password, options: { emailRedirectTo: redirectTo } });
          if (error) throw error;
          if (!data.session) { setConfirmationEmail(email.trim()); setPassword(''); setConfirm(''); }
        } else {
          const { error } = await supabase!.auth.signInWithPassword({ email: email.trim(), password });
          if (error) throw error;
        }
      }
    } catch (e) { setError(message(e)); } finally { setBusy(false); }
  }
  if (confirmationEmail) return <main className="confirmation-layout"><section className="auth-card confirmation-card" aria-labelledby="confirmation-title"><span className="card-icon" aria-hidden="true">✉</span><h1 id="confirmation-title">Check your email</h1><p className="muted">We sent a confirmation link to <strong>{confirmationEmail}</strong>.</p><p>Tap the confirmation button in that email to verify your account and return to your freezer.</p><p className="muted">Can’t find it? Check your spam folder, or request a fresh link below.</p>{error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}<button className="primary" disabled={busy} onClick={() => { setBusy(true); setError(''); setNotice(''); void supabase!.auth.resend({ type: 'signup', email: confirmationEmail, options: { emailRedirectTo: confirmationRedirect(invitation) } }).then(({ error }) => { if (error) setError(message(error)); else setNotice('A fresh confirmation email is on its way. Please use the newest link.'); }).catch(e => setError(message(e))).finally(() => setBusy(false)); }}>{busy ? 'Sending…' : 'Send a new confirmation email'}</button><button className="text-button" onClick={() => { setConfirmationEmail(''); switchMode('login'); }}>Back to sign in</button></section></main>;
  const title = { login: 'Good food.\nAlready home.', signup: 'Make room for\na little less chaos.', forgot: 'Let’s get you\nback in.', reset: 'A fresh start\nfor your password.' }[mode];
  return <main className="auth-layout">
    <section className="welcome"><span className="eyebrow">YOUR HOUSEHOLD, IN STOCK</span><h1>{title}</h1><p>Everything in your freezer, in one place.<br/>A quick look now. An easier dinner later.</p><div className="freezer-art" aria-hidden="true"><div className="freezer-lid"/><div className="freezer-body"><span className="freezer-handle"/><span className="freezer-note">already<br/>got it. <span>✓</span></span><span className="freezer-light"/></div><div className="art-shadow"/></div><span className="welcome-note">Your shared list. Always within reach.</span></section>
    <section className="auth-card" aria-labelledby="auth-title">{invitation && <p className="notice">You’ve been invited to a shared household. Create your account, or sign in below, to join.</p>}<span className="card-icon" aria-hidden="true">↗</span><h2 id="auth-title">{{ login: 'Open your freezer', signup: 'Create your account', forgot: 'Forgot your password?', reset: 'Choose a new password' }[mode]}</h2><p className="muted">{{ login: 'Sign in to see what’s waiting inside.', signup: 'You’ll each have a login and share one inventory.', forgot: 'We’ll send you a link to reset it.', reset: 'Use at least 8 characters.' }[mode]}</p>
      <form onSubmit={submit}>
        {mode !== 'reset' && <label>Email address<input type="email" autoComplete="email" value={email} onChange={e => setEmail(e.target.value)} placeholder="you@example.com" required maxLength={254}/></label>}
        {mode !== 'forgot' && <label>Password<input type="password" autoComplete={mode === 'login' ? 'current-password' : 'new-password'} value={password} onChange={e => setPassword(e.target.value)} minLength={mode === 'login' ? 1 : 8} maxLength={128} required placeholder={mode === 'login' ? 'Your password' : 'At least 8 characters'}/></label>}
        {(mode === 'signup' || mode === 'reset') && <label>Confirm password<input type="password" autoComplete="new-password" value={confirm} onChange={e => setConfirm(e.target.value)} minLength={8} maxLength={128} required/></label>}
        {(mode === 'login' || mode === 'signup') && <div className="form-options"><label className="checkbox"><input type="checkbox" checked={remember} onChange={e => setRemember(e.target.checked)}/>Remember me</label>{mode === 'login' && <button type="button" className="text-button" onClick={() => switchMode('forgot')}>Forgot password?</button>}</div>}
        {(error || authError) && <p className="error" role="alert">{error || authError}</p>}{notice && <p className="notice" role="status">{notice}</p>}
        <button className="primary" disabled={busy}>{busy ? 'One moment…' : { login: 'Sign in', signup: 'Create account', forgot: 'Send reset link', reset: 'Save new password' }[mode]}<span aria-hidden="true">→</span></button>
      </form>
      {mode !== 'reset' && <p className="auth-switch">{mode === 'login' ? <>First time here? <button className="text-button" onClick={() => switchMode('signup')}>Create an account</button></> : <button className="text-button" onClick={() => switchMode('login')}>Back to sign in</button>}</p>}
      <div className="privacy-note"><span aria-hidden="true">◈</span> Just your household. Just your inventory.</div>
    </section>
  </main>;
}

function HouseholdApp({ session, initialHousehold }: { session: Session; initialHousehold: string }) {
  const [households, setHouseholds] = useState<Household[]>([]);
  const [selected, setSelected] = useState(initialHousehold);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('Our Freezer');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState('');
  const [showShare, setShowShare] = useState(false);
  const [shareNotice, setShareNotice] = useState('');
  const [onboard, setOnboard] = useState<'create' | 'join'>('create');
  const household = households.find(h => h.id === selected);
  useEffect(() => { setInvite(''); setShareNotice(''); setShowShare(false); }, [selected]);
  async function loadHouseholds() {
    const { data, error } = await supabase!.from('households').select('id,name,owner_id').order('created_at');
    if (error) throw error;
    setHouseholds(data); setSelected(previous => data.some(h => h.id === previous) ? previous : data[0]?.id ?? '');
  }
  useEffect(() => { let active = true; void loadHouseholds().catch(e => { if (active) setError(message(e)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [session.user.id]);
  async function action(work: () => Promise<void>) { setBusy(true); setError(''); try { await work(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function signOut() { await action(async () => { const { error } = await supabase!.auth.signOut({ scope: 'local' }); if (error) throw error; }); }
  async function setup(event: FormEvent) {
    event.preventDefault(); await action(async () => {
      const { error } = onboard === 'create' ? await supabase!.rpc('create_household', { p_name: name.trim() }) : await supabase!.rpc('join_household', { p_code: code.trim() });
      if (error) throw error;
      await loadHouseholds();
    });
  }
  return <main className="inventory-layout">
    <ProfileMenu householdName={household?.name} email={session.user.email} busy={busy} canShare={household?.owner_id === session.user.id} onShare={() => setShowShare(value => !value)} onSignOut={() => { void signOut(); }}>
      {households.length > 1 && <label>Switch household<select disabled={busy} value={selected} onChange={e => setSelected(e.target.value)}>{households.map(h => <option value={h.id} key={h.id}>{h.name}</option>)}</select></label>}
      {showShare && <section className="share-panel"><h2>Invite your household</h2><p>Copy a one-time invite link and paste it into a text message. It opens account creation and connects them to your household after they confirm their email. The link expires in 7 days.</p>
        {invite && <label>Invite link<input readOnly value={invitationUrl(invite)} onFocus={e => e.target.select()}/></label>}
        <button className="secondary" disabled={busy} onClick={() => { void action(async () => {
          let token = invite;
          if (!token) { const { data, error } = await supabase!.rpc('create_household_invite', { p_household_id: selected }); if (error) throw error; token = data; setInvite(token); }
          await copyInviteLink(invitationUrl(token)); setShareNotice('Invite link copied. Paste it into a text message.');
        }); }}>Copy invite link</button>
        {invite && <button className="text-button" disabled={busy} onClick={() => { void action(async () => { const { data, error } = await supabase!.rpc('create_household_invite', { p_household_id: selected }); if (error) throw error; setInvite(data); setShareNotice('New link created. Previous unused links no longer work. Copy this link to share it.'); }); }}>Replace invite link</button>}
        {shareNotice && <p className="notice" role="status">{shareNotice}</p>}
      </section>}
    </ProfileMenu>
    {error && <div className="error" role="alert">{error}<button className="text-button" onClick={() => { void action(loadHouseholds); }}>Try again</button></div>}
    {loading ? <p role="status">Finding your household…</p> : !household ? <section className="onboarding auth-card"><span className="eyebrow">YOUR HOME. YOUR SHARED FREEZERS.</span><h1>Welcome home.</h1><p className="muted">Start your household, or join the one your partner created.</p><div className="tabs"><button aria-pressed={onboard === 'create'} onClick={() => setOnboard('create')}>Start a household</button><button aria-pressed={onboard === 'join'} onClick={() => setOnboard('join')}>Join your household</button></div><form onSubmit={setup}>{onboard === 'create' ? <label>Household name<input value={name} onChange={e => setName(e.target.value)} required maxLength={100}/></label> : <label>Invitation code<input value={code} onChange={e => setCode(e.target.value)} placeholder="Paste the code from your partner" autoCapitalize="none" spellCheck={false} required maxLength={100}/></label>}<button className="primary" disabled={busy}>{busy ? 'One moment…' : onboard === 'create' ? 'Create household' : 'Join household'}<span aria-hidden="true">→</span></button></form></section> : <>

      <Freezers key={selected} householdId={selected}/>
    </>}
  </main>;
}
