import { useState } from 'react';
import { parseBulk, validateBulk, type BulkRow, type BulkItem } from './bulk-entry';

export function BulkEntry({ freezerName, disabled, onSave }: { freezerName: string; disabled: boolean; onSave: (items: BulkItem[]) => void }) {
  const [text, setText] = useState('');
  const [rows, setRows] = useState<BulkRow[] | null>(null);
  const preview = rows ? validateBulk(rows) : null;
  const update = (line: number, patch: Partial<BulkRow>) => setRows(previous => previous!.map(row => row.line === line ? { ...row, ...patch } : row));
  return <section className="bulk-entry" aria-label="Bulk item entry">
    <p>Add to <strong>{freezerName}</strong>. One food per line; use “Chicken Thighs x 3” for quantities. A name on its own adds one.</p>
    {!rows ? <form onSubmit={event => { event.preventDefault(); setRows(parseBulk(text)); }}><label>Items to add<textarea value={text} onChange={event => setText(event.target.value)} rows={6} maxLength={30000} disabled={disabled} placeholder={'Chicken Thighs x 3\nBroccoli x 2\nPizza'} required/></label><button className="secondary" disabled={disabled}>Preview items</button></form> : <form onSubmit={event => { event.preventDefault(); if (!disabled && preview && !preview.errors.length) onSave(preview.items); }}>
      <h3>Review your items</h3><p>Edit or remove lines before saving. Repeated names combine automatically. Save up to 100 lines in one batch.</p>
      {rows.length <= 100 && <div className="bulk-rows">{rows.map(row => <div className="bulk-row" key={row.line}>
        <label>Item name<span className="sr-only"> on line {row.line}</span><input aria-label={`Item name on line ${row.line}`} value={row.name} maxLength={200} required disabled={disabled} onChange={event => update(row.line, { name: event.target.value })}/></label>
        <label>Quantity<span className="sr-only"> on line {row.line}</span><input aria-label={`Quantity on line ${row.line}`} type="number" inputMode="numeric" min={1} max={2147483647} step={1} value={row.quantity} required disabled={disabled} onChange={event => update(row.line, { quantity: event.target.value })}/></label>
        <button type="button" className="text-button" aria-label={`Remove line ${row.line}`} disabled={disabled} onClick={() => setRows(previous => previous!.filter(value => value.line !== row.line))}>Remove</button>
      </div>)}</div>}
      {preview && preview.errors.length > 0 && <div className="error" role="alert">{preview.errors.map((error, index) => <p key={index}>{error}</p>)}</div>}
      {preview && !preview.errors.length && <p className="bulk-summary">{preview.items.length} distinct {preview.items.length === 1 ? 'item' : 'items'} · {preview.items.reduce((sum, item) => sum + item.quantity, 0)} packages will be added. Undo reverses the whole batch.</p>}
      <div className="bulk-actions"><button className="primary" disabled={disabled || !preview || !!preview.errors.length}>Save batch</button><button type="button" className="text-button" disabled={disabled} onClick={() => setRows(null)}>Edit original text</button></div>
    </form>}
  </section>;
}
