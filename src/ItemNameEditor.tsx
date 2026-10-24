import { useEffect, useRef, useState } from 'react';
import { supabase } from './supabase';

export type EditableItem = { id: string; name: string; quantity: number };
export function ItemNameEditor({ item, householdId, freezerId, busy, pending, error, onSave, onRetry, onCancel }: {
  item: EditableItem; householdId: string; freezerId: string; busy: boolean; pending: boolean; error: string;
  onSave: (name: string, targetId: string | null) => void; onRetry: () => void; onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const [name, setName] = useState(item.name);
  const [target, setTarget] = useState<EditableItem | null>(null);
  const [checking, setChecking] = useState(true);
  const [lookupError, setLookupError] = useState('');
  const [revision, setRevision] = useState(0);
  const clean = name.trim().replace(/\s+/g, ' ');
  const disabled = busy || pending;
  useEffect(() => {
    const element = dialog.current!;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; element.showModal();
    return () => { element.close(); document.body.style.overflow = overflow; };
  }, []);
  useEffect(() => {
    if (disabled) return;
    let active = true;
    setChecking(true); setTarget(null); setLookupError('');
    const timer = setTimeout(async () => {
      try {
        if (clean && clean.length <= 200) {
          const { data, error } = await supabase!.from('inventory_items').select('id,name,quantity')
            .eq('household_id', householdId).eq('freezer_id', freezerId)
            .eq('normalized_name', clean.toLowerCase()).neq('id', item.id)
            .retry(false).abortSignal(AbortSignal.timeout(10000)).maybeSingle();
          if (error) throw error;
          if (active) setTarget(data);
        }
      } catch { if (active) setLookupError('Couldn’t check for an existing item. Try again.'); }
      finally { if (active) setChecking(false); }
    }, 150);
    return () => { active = false; clearTimeout(timer); };
  }, [name, clean, householdId, freezerId, item.id, disabled, revision]);
  const unchanged = clean.toLowerCase() === item.name.toLowerCase();
  const overflow = target && item.quantity + target.quantity > 2147483647;
  return <dialog ref={dialog} className="swap-dialog" aria-labelledby="item-name-title" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="item-name-title">Edit item name</h2>
    <p>Correct <strong>{item.name}</strong> in this freezer.</p>
    <form onSubmit={event => { event.preventDefault(); if (!disabled && !checking && !lookupError && !overflow && clean && !unchanged) onSave(clean, target?.id ?? null); }}>
      <label>New item name<input autoFocus required maxLength={200} value={name} disabled={disabled} onChange={event => { setName(event.target.value); setChecking(true); }}/></label>
      {checking && !disabled && <p className="muted" role="status">Checking saved names…</p>}
      {target && <p className="merge-preview" role="status"><strong>{target.name}</strong> already exists in this freezer. Merge {item.quantity} + {target.quantity} into <strong>{item.quantity + target.quantity}</strong> total. The corrected name will replace the old spelling in suggestions.</p>}
      {overflow && <p className="error" role="alert">Combined quantity would be too large.</p>}
      {lookupError && <p className="error" role="alert">{lookupError} <button type="button" className="text-button" onClick={() => setRevision(value => value + 1)}>Check again</button></p>}
      <p className="muted swap-help">Other freezers keep their own items. Name corrections and merges cannot be undone here; quantity Undo remains available.</p>
      {error && <div className="error" role="alert">{error}{pending && <button type="button" className="text-button" disabled={busy} onClick={onRetry}>Retry save</button>}</div>}
      <div className="swap-actions"><button className="primary" disabled={disabled || checking || !!lookupError || !!overflow || !clean || unchanged}>{busy ? 'Saving…' : target ? 'Merge items' : 'Save name'}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
    </form>
  </dialog>;
}
