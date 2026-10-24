import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';
import type { Freezer } from './Freezers';

export function FreezerTitle({ freezer, householdId, onSaved }: { freezer: Freezer; householdId: string; onSaved: (name: string) => void }) {
  const [editing, setEditing] = useState(false);
  const [draft, setDraft] = useState(freezer.name);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState('');
  const active = useRef(true);
  const locked = useRef(false);
  const cancelled = useRef(false);
  useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
  async function save() {
    if (cancelled.current || locked.current) return;
    const name = draft.trim().replace(/\s+/g, ' ');
    if (!name) { setError('Enter a freezer name.'); return; }
    if (name === freezer.name) { setEditing(false); setError(''); return; }
    locked.current = true; setSaving(true); setError('');
    try {
      const { error } = await supabase!.rpc('save_freezer', { p_household_id: householdId, p_freezer_id: freezer.id, p_name: name }).abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      if (active.current) { onSaved(name); setEditing(false); }
    } catch (error) {
      if (active.current) setError(`Couldn’t save freezer name: ${String((error as { message?: string })?.message ?? 'Try editing the name again.')}`);
    } finally { locked.current = false; if (active.current) setSaving(false); }
  }
  return <div className="freezer-title-editor">
    <div className="freezer-title-row">{editing ? <input className="freezer-title-input" aria-label="Edit freezer name" autoFocus maxLength={100} value={draft} disabled={saving} aria-invalid={!!error} onFocus={event => event.target.select()} onChange={event => { setDraft(event.target.value); setError(''); }} onBlur={() => { void save(); }} onKeyDown={event => {
      if (event.key === 'Enter') { event.preventDefault(); event.currentTarget.blur(); }
      if (event.key === 'Escape') { event.preventDefault(); cancelled.current = true; setEditing(false); setError(''); }
    }}/> : <><h2 className="freezer-title">{freezer.name}</h2><button className="edit-freezer-icon" aria-label="Edit freezer name" onClick={() => { cancelled.current = false; setDraft(freezer.name); setError(''); setEditing(true); }}><svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><path d="m15 5 4 4M4 20l5-1L20 8a2.8 2.8 0 0 0-4-4L5 15l-1 5Z"/></svg></button></>}
      {saving && <span className="rename-status" role="status">Saving…</span>}
    </div>{error && <p className="error" role="alert">{error}</p>}
  </div>;
}
