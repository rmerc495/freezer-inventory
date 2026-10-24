import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from './supabase';
import { Inventory } from './Inventory';
import { FreezerTitle } from './FreezerTitle';
import { requestId } from './request-id';

export type Freezer = { id: string; name: string; is_default: boolean };

export function Freezers({ householdId }: { householdId: string }) {
  const [freezers, setFreezers] = useState<Freezer[]>([]);
  const [selected, setSelected] = useState('');
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState('');
  const [form, setForm] = useState<{ id: string } | null>(null);
  const [name, setName] = useState('');
  const [busy, setBusy] = useState(false);
  const [saveError, setSaveError] = useState('');
  const active = useRef(false);
  const generation = useRef(0);
  const locked = useRef(false);
  const freezer = freezers.find(f => f.id === selected);

  async function refresh() {
    const version = ++generation.current;
    try {
      const { data, error } = await supabase!.from('freezers').select('id,name,is_default').eq('household_id', householdId).order('created_at').retry(false).abortSignal(AbortSignal.timeout(15000));
      if (!active.current || version !== generation.current) return;
      if (error) throw error;
      setFreezers(data); setError('');
      setSelected(previous => data.some(f => f.id === previous) ? previous : data.find(f => f.is_default)?.id ?? data[0]?.id ?? '');
    } catch (error) {
      if (active.current && version === generation.current) setError(`Couldn’t load freezers: ${error instanceof Error ? error.message : String((error as { message?: string })?.message ?? error)}`);
    } finally { if (active.current && version === generation.current) setLoading(false); }
  }

  useEffect(() => {
    active.current = true; void refresh();
    const channel = supabase!.channel(`freezers:${householdId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'freezers', filter: `household_id=eq.${householdId}` }, () => { void refresh(); }).subscribe(status => { if (status === 'SUBSCRIBED') void refresh(); });
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus); window.addEventListener('online', onFocus); document.addEventListener('visibilitychange', onVisible);
    return () => { active.current = false; ++generation.current; window.removeEventListener('focus', onFocus); window.removeEventListener('online', onFocus); document.removeEventListener('visibilitychange', onVisible); void supabase!.removeChannel(channel); };
  }, [householdId]);

  async function save(event: FormEvent) {
    event.preventDefault();
    if (!form || locked.current) return;
    locked.current = true; setBusy(true); setSaveError('');
    try {
      const { error } = await supabase!.rpc('save_freezer', { p_household_id: householdId, p_freezer_id: form.id, p_name: name.trim() }).abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      if (!active.current) return;
      setSelected(form.id); setForm(null); setName(''); await refresh();
    } catch (error) {
      if (active.current) setSaveError(String((error as { message?: string })?.message ?? 'Couldn’t save the freezer. Try again.'));
    } finally { locked.current = false; if (active.current) setBusy(false); }
  }

  return <section className="freezers" aria-label="Household freezers">
    <div className="freezer-heading"><h2>Your freezers</h2><button className="add-freezer-icon" aria-label="Add freezer" disabled={busy} onClick={() => { setForm({ id: requestId() }); setName(''); setSaveError(''); }}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="M12 5v14M5 12h14"/></svg></button></div>
    {error && <div className="error" role="alert">{error}<button className="text-button" onClick={() => { void refresh(); }}>Reload freezers</button></div>}
    {loading ? <p role="status">Loading freezers…</p> : <nav className="freezer-folders" aria-label="Choose a freezer">{freezers.map(f => <button key={f.id} className="secondary" aria-pressed={f.id === selected} onClick={() => setSelected(f.id)}><span aria-hidden="true">▱ </span>{f.name}</button>)}</nav>}
    {form && <form className="freezer-form" onSubmit={save}><label>Freezer name<input autoFocus required maxLength={100} value={name} disabled={busy} onChange={e => setName(e.target.value)} placeholder="e.g. Garage freezer"/></label>{saveError && <p className="error" role="alert">{saveError}</p>}<button className="secondary" disabled={busy}>{busy ? 'Saving…' : 'Save freezer'}</button><button type="button" className="text-button" disabled={busy} onClick={() => setForm(null)}>Cancel</button></form>}
    {freezer && <FreezerTitle key={`title:${freezer.id}`} freezer={freezer} householdId={householdId} onSaved={name => { setFreezers(previous => previous.map(item => item.id === freezer.id ? { ...item, name } : item)); void refresh(); }}/>}
    {freezer && <Inventory key={freezer.id} householdId={householdId} freezerId={freezer.id} freezerName={freezer.name} freezers={freezers}/>}
  </section>;
}
