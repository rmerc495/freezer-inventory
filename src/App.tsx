import { useEffect, useState, type FormEvent } from 'react';
import type { Session } from '@supabase/supabase-js';
import { supabase, sessionStorageAdapter, authRedirectUrl } from './supabase';

type Household = { id: string; name: string; owner_id: string };
type Item = { id: string; name: string; quantity: number };
type Mode = 'login' | 'signup' | 'forgot' | 'reset';
const message = (error: unknown) => error instanceof Error ? error.message : typeof error === 'object' && error && 'message' in error ? String(error.message) : 'Something went wrong. Please try again.';
const recoveryKey = 'freezer.password-recovery';

function Mark() {
  return <span className="brand-mark" aria-hidden="true"><svg viewBox="0 0 32 32" fill="none"><path d="M16 3v26M5 9l22 14M5 23 27 9M12 6l4 4 4-4M12 26l4-4 4 4M6 13l6-1-1-6M26 19l-6 1 1 6M6 19l6 1-1 6M26 13l-6-1 1-6" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/></svg></span>;
}

export function App() {
  const [session, setSession] = useState<Session | null>(null);
  const [loading, setLoading] = useState(true);
  const [mode, setMode] = useState<Mode>(() => sessionStorage.getItem(recoveryKey) ? 'reset' : 'login');
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
    <header className="brand"><Mark/><span>freezer<span className="brand-light"> inventory</span></span><span className="brand-caption">A LITTLE LESS DIGGING.</span></header>
    {loading ? <main className="loading" role="status">Opening your freezer…</main> : !session || mode === 'reset' ?
      <Auth mode={mode} setMode={setMode} authError={authError} onPasswordSaved={() => { sessionStorage.removeItem(recoveryKey); setMode('login'); }}/>
      : <HouseholdApp session={session}/>}
    <footer>Less wondering what’s in there. More knowing what’s for dinner.</footer>
  </div>;
}

function Auth({ mode, setMode, onPasswordSaved, authError }: { mode: Mode; setMode: (mode: Mode) => void; onPasswordSaved: () => void; authError: string }) {
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
      const redirectTo = authRedirectUrl;
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
  if (confirmationEmail) return <main className="confirmation-layout"><section className="auth-card confirmation-card" aria-labelledby="confirmation-title"><span className="card-icon" aria-hidden="true">✉</span><h1 id="confirmation-title">Check your email</h1><p className="muted">We sent a confirmation link to <strong>{confirmationEmail}</strong>.</p><p>Tap the confirmation button in that email to verify your account and return to your freezer.</p><p className="muted">Can’t find it? Check your spam folder, or request a fresh link below.</p>{error && <p className="error" role="alert">{error}</p>}{notice && <p className="notice" role="status">{notice}</p>}<button className="primary" disabled={busy} onClick={() => { setBusy(true); setError(''); setNotice(''); void supabase!.auth.resend({ type: 'signup', email: confirmationEmail, options: { emailRedirectTo: authRedirectUrl } }).then(({ error }) => { if (error) setError(message(error)); else setNotice('A fresh confirmation email is on its way. Please use the newest link.'); }).catch(e => setError(message(e))).finally(() => setBusy(false)); }}>{busy ? 'Sending…' : 'Send a new confirmation email'}</button><button className="text-button" onClick={() => { setConfirmationEmail(''); switchMode('login'); }}>Back to sign in</button></section></main>;
  const title = { login: 'Good food.\nAlready home.', signup: 'Make room for\na little less chaos.', forgot: 'Let’s get you\nback in.', reset: 'A fresh start\nfor your password.' }[mode];
  return <main className="auth-layout">
    <section className="welcome"><span className="eyebrow">YOUR HOUSEHOLD, IN STOCK</span><h1>{title}</h1><p>Everything in your freezer, in one place.<br/>A quick look now. An easier dinner later.</p><div className="freezer-art" aria-hidden="true"><div className="freezer-lid"/><div className="freezer-body"><span className="freezer-handle"/><span className="freezer-note">already<br/>got it. <span>✓</span></span><span className="freezer-light"/></div><div className="art-shadow"/></div><span className="welcome-note">Your shared list. Always within reach.</span></section>
    <section className="auth-card" aria-labelledby="auth-title"><span className="card-icon" aria-hidden="true">↗</span><h2 id="auth-title">{{ login: 'Open your freezer', signup: 'Create your account', forgot: 'Forgot your password?', reset: 'Choose a new password' }[mode]}</h2><p className="muted">{{ login: 'Sign in to see what’s waiting inside.', signup: 'You’ll each have a login and share one inventory.', forgot: 'We’ll send you a link to reset it.', reset: 'Use at least 8 characters.' }[mode]}</p>
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

function HouseholdApp({ session }: { session: Session }) {
  const [households, setHouseholds] = useState<Household[]>([]);
  const [selected, setSelected] = useState('');
  const [items, setItems] = useState<Item[]>([]);
  const [loading, setLoading] = useState(true);
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState('');
  const [name, setName] = useState('Our Freezer');
  const [code, setCode] = useState('');
  const [invite, setInvite] = useState('');
  const [showShare, setShowShare] = useState(false);
  const [onboard, setOnboard] = useState<'create' | 'join'>('create');
  const [query, setQuery] = useState('');
  const household = households.find(h => h.id === selected);
  async function loadHouseholds() {
    const { data, error } = await supabase!.from('households').select('id,name,owner_id').order('created_at');
    if (error) throw error;
    setHouseholds(data); setSelected(previous => data.some(h => h.id === previous) ? previous : data[0]?.id ?? '');
  }
  useEffect(() => { let active = true; void loadHouseholds().catch(e => { if (active) setError(message(e)); }).finally(() => { if (active) setLoading(false); }); return () => { active = false; }; }, [session.user.id]);
  useEffect(() => {
    setItems([]); setInvite(''); setShowShare(false); setQuery('');
    if (!selected) return;
    let active = true;
    async function refresh() {
      const { data, error } = await supabase!.from('inventory_items').select('id,name,quantity').eq('household_id', selected).gt('quantity', 0).order('name');
      if (!active) return;
      if (error) setError(message(error)); else setItems(data);
    }
    void refresh();
    const channel = supabase!.channel(`inventory:${selected}`).on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_items', filter: `household_id=eq.${selected}` }, () => { void refresh(); }).subscribe(status => { if (status === 'SUBSCRIBED') void refresh(); });
    const onFocus = () => { void refresh(); };
    window.addEventListener('focus', onFocus);
    return () => { active = false; window.removeEventListener('focus', onFocus); void supabase!.removeChannel(channel); };
  }, [selected]);
  async function action(work: () => Promise<void>) { setBusy(true); setError(''); try { await work(); } catch (e) { setError(message(e)); } finally { setBusy(false); } }
  async function signOut() { await action(async () => { const { error } = await supabase!.auth.signOut({ scope: 'local' }); if (error) throw error; }); }
  async function setup(event: FormEvent) {
    event.preventDefault(); await action(async () => {
      const { error } = onboard === 'create' ? await supabase!.rpc('create_household', { p_name: name.trim() }) : await supabase!.rpc('join_household', { p_code: code.trim() });
      if (error) throw error;
      await loadHouseholds();
    });
  }
  return <main className="inventory-layout"><div className="account-bar"><span>{session.user.email}</span><button className="text-button" onClick={signOut} disabled={busy}>Sign out</button></div>
    {error && <div className="error" role="alert">{error}<button className="text-button" onClick={() => { void action(loadHouseholds); }}>Try again</button></div>}
    {loading ? <p role="status">Finding your household…</p> : !household ? <section className="onboarding auth-card"><span className="eyebrow">ONE FREEZER. ONE SHARED LIST.</span><h1>Welcome home.</h1><p className="muted">Start your household, or join the one your partner created.</p><div className="tabs"><button aria-pressed={onboard === 'create'} onClick={() => setOnboard('create')}>Start a household</button><button aria-pressed={onboard === 'join'} onClick={() => setOnboard('join')}>Join your household</button></div><form onSubmit={setup}>{onboard === 'create' ? <label>Household name<input value={name} onChange={e => setName(e.target.value)} required maxLength={100}/></label> : <label>Invitation code<input value={code} onChange={e => setCode(e.target.value)} placeholder="Paste the code from your partner" autoCapitalize="none" spellCheck={false} required maxLength={100}/></label>}<button className="primary" disabled={busy}>{busy ? 'One moment…' : onboard === 'create' ? 'Create household' : 'Join household'}<span aria-hidden="true">→</span></button></form></section> : <>
      <div className="inventory-heading"><div><span className="eyebrow">GOOD THINGS IN STORE</span><h1>{household.name}</h1><p className="muted">Your next meal might already be here.</p></div>{household.owner_id === session.user.id && <button className="secondary" onClick={() => setShowShare(!showShare)}>Share household</button>}</div>
      {households.length > 1 && <label>Switch household<select value={selected} onChange={e => setSelected(e.target.value)}>{households.map(h => <option value={h.id} key={h.id}>{h.name}</option>)}</select></label>}
      {showShare && <section className="share-panel"><h2>Bring your partner in</h2><p>They’ll create their own account, choose “Join your household,” and paste this one-time code. It expires in 7 days.</p>{invite && <label>Invitation code<input readOnly value={invite} onFocus={e => e.target.select()}/></label>}<button className="secondary" disabled={busy} onClick={() => { void action(async () => { const { data, error } = await supabase!.rpc('create_household_invite', { p_household_id: selected }); if (error) throw error; setInvite(data); }); }}>{invite ? 'Replace code' : 'Create invitation code'}</button>{invite && <button className="text-button" onClick={() => { void action(async () => { await navigator.clipboard.writeText(invite); }); }}>Copy code</button>}</section>}
      <div className="inventory-toolbar"><label className="search"><span className="sr-only">Search inventory</span><input type="search" placeholder="Find something in your freezer…" value={query} onChange={e => setQuery(e.target.value)}/></label><span className="item-count">{items.length} {items.length === 1 ? 'item' : 'items'} in stock</span></div>
      {items.length === 0 ? <section className="empty-state"><Mark/><h2>A fresh start.</h2><p>Your household is connected.<br/>This is where your freezer inventory will live.</p><span className="stage-note">Item entry and quantity controls are coming in the next step.</span></section> : <section className="item-list" aria-label="Freezer inventory">{items.filter(i => i.name.toLowerCase().includes(query.toLowerCase())).map(i => <div className="item-row" key={i.id}><span>{i.name}</span><span className="quantity">{i.quantity}</span></div>)}{!items.some(i => i.name.toLowerCase().includes(query.toLowerCase())) && <p className="muted">No matching items.</p>}</section>}
    </>}
  </main>;
}
