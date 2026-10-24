import { useEffect, useRef, useState, type FormEvent } from 'react';
import { supabase } from './supabase';
import { requestId } from './request-id';
import { ItemSuggestions } from './ItemSuggestions';
import { FreezerSwap } from './FreezerSwap';
import type { Freezer } from './Freezers';
import { matchesInventory } from './inventory-search';
import { ItemNameEditor, type EditableItem } from './ItemNameEditor';

type Item = { id: string; name: string; quantity: number; updated_at: string; tags?: string[]; synonyms?: string[] };
type Spelling = { operation_id: string; original_name: string; corrected_name: string };
type Request = { rpc: 'change_inventory' | 'submit_inventory_item' | 'restore_inventory_spelling' | 'dismiss_inventory_spelling' | 'undo_inventory' | 'move_inventory' | 'rename_inventory_item'; args: Record<string, unknown>; label: string; addition?: boolean };
const errorMessage = (error: unknown) => error && typeof error === 'object' && 'message' in error ? String(error.message) : 'Connection failed. Please try again.';


export function Inventory({ householdId, freezerId, freezerName, freezers }: { householdId: string; freezerId: string; freezerName: string; freezers: Freezer[] }) {
  const [items, setItems] = useState<Item[]>([]);
  const [spelling, setSpelling] = useState<Spelling[]>([]);
  const [loading, setLoading] = useState(true);
  const [readError, setReadError] = useState('');
  const [saveError, setSaveError] = useState('');
  const [busy, setBusy] = useState(false);
  const [pending, setPending] = useState<Request | null>(null);
  const [undo, setUndo] = useState<{ id: string; label: string } | null>(null);
  const [notice, setNotice] = useState('');
  const [name, setName] = useState('');
  const [quantity, setQuantity] = useState('1');
  const [query, setQuery] = useState('');
  const [suggestionsRevision, setSuggestionsRevision] = useState(0);
  const [sort, setSort] = useState(() => localStorage.getItem('freezer.inventory-sort') === 'recent' ? 'recent' : 'name');
  const [moving, setMoving] = useState<Item | null>(null);
  const [editing, setEditing] = useState<EditableItem | null>(null);
  const editTrigger = useRef<HTMLButtonElement | null>(null);
  const swapTrigger = useRef<HTMLButtonElement | null>(null);
  const locked = useRef(false);
  const active = useRef(false);
  const generation = useRef(0);
  const nameInput = useRef<HTMLInputElement>(null);

  async function refreshSpelling(version: number) {
    try {
      const { data, error } = await supabase!.from('inventory_spelling').select('operation_id,original_name,corrected_name')
        .eq('household_id', householdId).eq('freezer_id', freezerId).eq('status', 'corrected').eq('dismissed', false).order('created_at', { ascending: false }).limit(3).retry(false).abortSignal(AbortSignal.timeout(10000));
      if (active.current && version === generation.current && !error) setSpelling(Array.isArray(data) ? data : []);
    } catch { /* A missing correction notice must not block reading or saving stock. */ }
  }

  async function refresh() {
    const version = ++generation.current;
    try {
      const { data, error } = await supabase!.from('inventory_items').select('id,name,quantity,updated_at,tags,synonyms').eq('household_id', householdId).eq('freezer_id', freezerId).gt('quantity', 0).order('name').retry(false).abortSignal(AbortSignal.timeout(15000));
      if (!active.current || version !== generation.current) return;
      if (error) throw error;
      setItems(data); setReadError(''); setSuggestionsRevision(value => value + 1);
      void refreshSpelling(version);
    } catch (error) {
      if (active.current && version === generation.current) setReadError(`Couldn’t refresh inventory: ${errorMessage(error)}`);
    } finally {
      if (active.current && version === generation.current) setLoading(false);
    }
  }

  useEffect(() => {
    active.current = true;
    void refresh();
    const channel = supabase!.channel(`inventory:${householdId}`).on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_items', filter: `household_id=eq.${householdId}` }, () => { void refresh(); }).on('postgres_changes', { event: '*', schema: 'public', table: 'inventory_spelling', filter: `household_id=eq.${householdId}` }, () => { void refresh(); }).subscribe(status => { if (status === 'SUBSCRIBED') void refresh(); });
    const onFocus = () => { void refresh(); };
    const onVisible = () => { if (document.visibilityState === 'visible') void refresh(); };
    window.addEventListener('focus', onFocus);
    window.addEventListener('online', onFocus);
    document.addEventListener('visibilitychange', onVisible);
    return () => { active.current = false; ++generation.current; window.removeEventListener('focus', onFocus); window.removeEventListener('online', onFocus); document.removeEventListener('visibilitychange', onVisible); void supabase!.removeChannel(channel); };
  }, [householdId]);

  async function save(request: Request) {
    if (locked.current) return;
    locked.current = true; setBusy(true); setSaveError(''); setPending(request);
    let focusEntry = false;
    try {
      const { data, error } = await supabase!.rpc(request.rpc, request.args).abortSignal(AbortSignal.timeout(15000));
      if (error) throw error;
      if (!active.current) return;
      setPending(null); setMoving(null); setEditing(null);
      if (request.rpc === 'move_inventory') requestAnimationFrame(() => swapTrigger.current?.focus());
      if (request.rpc === 'restore_inventory_spelling' || request.rpc === 'dismiss_inventory_spelling') {
        setSpelling(values => values.filter(value => value.operation_id !== request.args.p_operation_id));
        if (request.rpc === 'restore_inventory_spelling') setNotice('Original spelling restored. It will be kept next time.');
      } else if (request.rpc === 'rename_inventory_item') {
        setNotice(`${data.merged ? 'Merged into' : 'Renamed to'} ${data.name}.`);
        setName('');
        requestAnimationFrame(() => { if (editTrigger.current?.isConnected) editTrigger.current.focus(); else nameInput.current?.focus(); });
      } else if (request.rpc !== 'undo_inventory') {
        setUndo({ id: data, label: request.label }); setNotice('');
        if (request.addition) { setName(''); setQuantity('1'); focusEntry = true; }
      } else { setUndo(null); setNotice('Change undone.'); }
    } catch (error) {
      if (active.current) {
        const rejected = ['move_inventory', 'rename_inventory_item', 'restore_inventory_spelling', 'dismiss_inventory_spelling'].includes(request.rpc) && error && typeof error === 'object' && 'code' in error && ['22023', '42501'].includes(String(error.code));
        if (rejected) { setPending(null); setSaveError(`Couldn’t ${request.rpc === 'move_inventory' ? 'swap' : 'update the name'}: ${errorMessage(error)}`); }
        else setSaveError(`Couldn’t confirm ${request.rpc === 'undo_inventory' ? 'Undo' : 'the save'}: ${errorMessage(error)} Retry checks the same request without applying it twice.`);
      }
    } finally {
      // A failed response can still mean the transaction committed. Always reread.
      locked.current = false;
      if (active.current) {
        setBusy(false);
        void refresh();
        if (focusEntry) requestAnimationFrame(() => nameInput.current?.focus());
      }
    }
  }

  function change(delta: number, item?: Item) {
    if (locked.current || pending) return;
    const itemName = item?.name ?? name.trim();
    void save({ rpc: item ? 'change_inventory' : 'submit_inventory_item', args: { p_household_id: householdId, p_operation_id: requestId(), p_delta: delta, p_freezer_id: freezerId, ...(item ? { p_item_id: item.id } : { p_name: itemName }) }, label: `${delta > 0 ? 'Added' : 'Removed'} ${Math.abs(delta)} ${itemName}.`, addition: !item });
  }

  function add(event: FormEvent) {
    event.preventDefault();
    const amount = Number(quantity);
    if (!name.trim() || !Number.isInteger(amount) || amount < 1 || amount > 2147483647) { setSaveError('Enter an item name and a whole quantity from 1 to 2,147,483,647.'); return; }
    change(amount);
  }

  const disabled = busy || !!pending;
  const visibleItems = items.filter(item => matchesInventory(item, query)).sort((a, b) => (sort === 'recent' ? (Date.parse(b.updated_at) || 0) - (Date.parse(a.updated_at) || 0) : 0) || a.name.localeCompare(b.name) || a.id.localeCompare(b.id));
  return <>
    <div className="single-entry">
    <form className="item-entry" onSubmit={add} aria-label="Add an item">
      <ItemSuggestions householdId={householdId} freezerId={freezerId} value={name} disabled={disabled} revision={suggestionsRevision} inputRef={nameInput} onChange={setName} onEdit={item => { editTrigger.current = null; setSaveError(''); setEditing(item); }}/>
      <label className="item-amount">Quantity<input type="number" inputMode="numeric" min="1" max="2147483647" step="1" required value={quantity} onChange={e => setQuantity(e.target.value)} disabled={disabled}/></label>
      <button className="primary" disabled={disabled}>{busy ? 'Saving…' : 'Add item'}</button>
    </form>
    </div>
    {saveError && !moving && !editing && <div className="error" role="alert">{saveError}{pending && <div className="save-actions"><button className="text-button" disabled={busy} onClick={() => { void save(pending); }}>Retry save</button><button className="text-button" disabled={busy} onClick={() => { setPending(null); setSaveError(''); }}>Dismiss</button></div>}</div>}
    {editing && <ItemNameEditor item={items.find(item => item.id === editing.id) ?? editing} householdId={householdId} freezerId={freezerId} busy={busy} pending={!!pending} error={saveError}
      onCancel={() => { setEditing(null); setPending(null); setSaveError(''); requestAnimationFrame(() => { if (editTrigger.current?.isConnected) editTrigger.current.focus(); else nameInput.current?.focus(); }); }}
      onRetry={() => { if (pending) void save(pending); }}
      onSave={(newName, targetId) => { if (locked.current || pending) return; void save({ rpc: 'rename_inventory_item', args: { p_household_id: householdId, p_request_id: requestId(), p_item_id: editing.id, p_expected_name: editing.name, p_name: newName, p_merge_target_id: targetId }, label: 'Item name corrected.' }); }}/ >}
    {undo && <div className="undo-notice" role="status"><span>{undo.label}</span><button className="text-button" disabled={disabled} onClick={() => { void save({ rpc: 'undo_inventory', args: { p_household_id: householdId, p_operation_id: undo.id, p_undo_id: requestId() }, label: 'Change undone.' }); }}>Undo</button><button className="text-button" aria-label="Dismiss Undo" disabled={disabled} onClick={() => setUndo(null)}>×</button></div>}
    {moving && <FreezerSwap name={moving.name} available={items.find(item => item.id === moving.id)?.quantity ?? 0} source={freezerName} freezerId={freezerId} freezers={freezers} busy={busy} pending={!!pending} error={saveError}
      onCancel={() => { setMoving(null); setPending(null); setSaveError(''); requestAnimationFrame(() => swapTrigger.current?.focus()); }}
      onRetry={() => { if (pending) void save(pending); }}
      onSave={(destination, quantity) => { if (locked.current || pending) return; void save({ rpc: 'move_inventory', args: { p_household_id: householdId, p_operation_id: requestId(), p_item_id: moving.id, p_to_freezer_id: destination, p_quantity: quantity }, label: `Swapped ${quantity} ${moving.name} to ${freezers.find(f => f.id === destination)?.name}.` }); }}/>}

    {notice && <p className="notice" role="status">{notice}</p>}
    {spelling.map(correction => <div className="undo-notice spelling-notice" role="status" key={correction.operation_id}>
      <span>Corrected {correction.original_name} → {correction.corrected_name}.</span>
      <button type="button" className="text-button" disabled={disabled} aria-label={`Keep original spelling ${correction.original_name}`} onClick={() => { void save({ rpc: 'restore_inventory_spelling', args: { p_household_id: householdId, p_operation_id: correction.operation_id }, label: 'Original spelling restored.' }); }}>Keep my spelling</button>
      <button type="button" className="text-button" disabled={disabled} aria-label={`Dismiss correction ${correction.original_name}`} onClick={() => { void save({ rpc: 'dismiss_inventory_spelling', args: { p_household_id: householdId, p_operation_id: correction.operation_id }, label: '' }); }}>×</button>
    </div>)}
    {readError && <div className="error" role="alert">{readError}<button className="text-button" onClick={() => { void refresh(); }}>Refresh inventory</button></div>}
    <div className="inventory-toolbar"><label className="search"><span className="sr-only">Search inventory</span><input type="search" placeholder="Find something in your freezer…" value={query} onChange={e => setQuery(e.target.value)}/></label><label className="sort-control">Sort by<select value={sort} onChange={event => { setSort(event.target.value); localStorage.setItem('freezer.inventory-sort', event.target.value); }}><option value="name">Name</option><option value="recent">Recently Changed</option></select></label><span className="item-count">{items.length} {items.length === 1 ? 'item' : 'items'} in stock</span></div>
    {loading ? <p role="status">Loading inventory…</p> : items.length === 0 && !readError ? <section className="empty-state"><h2>A fresh start.</h2><p>Add something above to start stocking your shared list.</p></section> : <section className="item-list" aria-label="Freezer inventory">{visibleItems.map(item => <div className="item-row" key={item.id}>
      <div className="item-title"><span>{item.name}</span><div className="item-actions">
        <button className="text-button" disabled={disabled} aria-label={`Edit name ${item.name}`} onClick={event => { editTrigger.current = event.currentTarget; setSaveError(''); setEditing(item); }}>Edit name</button>
        {freezers.length > 1 && <button className="text-button move-button" disabled={disabled} aria-label={`Freezer swap ${item.name}`} onClick={event => { swapTrigger.current = event.currentTarget; setSaveError(''); setMoving(item); }}>Freezer swap</button>}
      </div></div>
      <div className="quantity-controls"><button type="button" aria-label={`Remove one ${item.name}`} disabled={disabled} onClick={() => change(-1, item)}>−</button><span className="quantity" aria-label={`${item.name} quantity`}>{item.quantity}</span><button type="button" aria-label={`Add one ${item.name}`} disabled={disabled} onClick={() => change(1, item)}>+</button></div>
    </div>)}{items.length > 0 && visibleItems.length === 0 && <p className="muted">No matching items.</p>}</section>}
  </>;
}
