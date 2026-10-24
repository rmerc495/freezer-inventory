import { useEffect, useRef, useState } from 'react';
import type { Freezer } from './Freezers';

export function FreezerSwap({ name, available, source, freezerId, freezers, busy, pending, error, onSave, onRetry, onCancel }: {
  name: string; available: number; source: string; freezerId: string; freezers: Freezer[]; busy: boolean; pending: boolean; error: string;
  onSave: (destination: string, quantity: number) => void; onRetry: () => void; onCancel: () => void;
}) {
  const dialog = useRef<HTMLDialogElement>(null);
  const destinations = freezers.filter(f => f.id !== freezerId);
  const [destination, setDestination] = useState(() => destinations.length === 1 ? destinations[0].id : '');
  const [quantity, setQuantity] = useState(1);
  const disabled = busy || pending;
  const amount = disabled ? quantity : Math.min(quantity, available);
  useEffect(() => {
    if (!disabled) setQuantity(previous => Math.max(1, Math.min(previous, available)));
  }, [available, disabled]);
  useEffect(() => {
    const element = dialog.current!;
    const overflow = document.body.style.overflow;
    document.body.style.overflow = 'hidden'; element.showModal();
    return () => { element.close(); document.body.style.overflow = overflow; };
  }, []);
  return <dialog ref={dialog} className="swap-dialog" aria-labelledby="swap-title" aria-describedby="swap-description" onCancel={event => { event.preventDefault(); if (!busy) onCancel(); }}>
    <h2 id="swap-title">Freezer swap</h2><p id="swap-description"><strong>{name}</strong><br/>{available} available in {source}.</p>
    <form onSubmit={event => { event.preventDefault(); if (!disabled && destination && amount >= 1 && amount <= available) onSave(destination, amount); }}>
      <label>Destination freezer<select autoFocus value={destination} required disabled={disabled} onChange={event => setDestination(event.target.value)}><option value="">Choose a freezer</option>{freezers.filter(f => f.id !== freezerId).map(f => <option key={f.id} value={f.id}>{f.name}</option>)}</select></label>
      <div role="group" aria-label="Quantity to swap"><span className="swap-quantity-label">Quantity to swap</span><div className="quantity-controls swap-quantity-controls">
        <button type="button" aria-label="Decrease swap quantity" disabled={disabled || amount <= 1} onClick={() => setQuantity(previous => Math.max(1, previous - 1))}>−</button>
        <output className="quantity" aria-label="Swap quantity" aria-live="polite">{amount}</output>
        <button type="button" aria-label="Increase swap quantity" disabled={disabled || amount >= available} onClick={() => setQuantity(previous => Math.min(available, previous + 1))}>+</button>
      </div></div>
      <p className="muted swap-help">Matching items in the destination freezer will combine. You can Undo this swap.</p>
      {available === 0 && !pending && <p className="error" role="alert">This item is no longer in stock in this freezer.</p>}
      {error && <div className="error" role="alert">{error}{pending && <button type="button" className="text-button" disabled={busy} onClick={onRetry}>Retry save</button>}</div>}
      <div className="swap-actions"><button className="primary" disabled={disabled || available < 1}>{busy ? 'Swapping…' : 'Swap items'}</button><button type="button" className="secondary" disabled={busy} onClick={onCancel}>Cancel</button></div>
    </form>
  </dialog>;
}
