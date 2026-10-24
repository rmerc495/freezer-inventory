import { useEffect, useId, useState, type RefObject } from 'react';
import { supabase } from './supabase';
import type { EditableItem } from './ItemNameEditor';

export function ItemSuggestions({ householdId, freezerId, value, disabled, revision, inputRef, onChange, onEdit }: { householdId: string; freezerId: string; value: string; disabled: boolean; revision: number; inputRef: RefObject<HTMLInputElement | null>; onChange: (name: string) => void; onEdit?: (item: EditableItem) => void }) {
  const id = useId();
  const listId = `${id}-matches`;
  const [matches, setMatches] = useState<EditableItem[]>([]);
  const names = matches.map(item => item.name);
  const exact = matches.find(item => item.name.toLowerCase() === value.trim().replace(/\s+/g, ' ').toLowerCase());
  const [focused, setFocused] = useState(false);
  const [dismissed, setDismissed] = useState(false);
  const [highlight, setHighlight] = useState(-1);
  const [error, setError] = useState(false);
  const term = value.trim().replace(/\s+/g, ' ');
  const expanded = focused && !dismissed && !disabled && !!term && names.length > 0;
  useEffect(() => {
    setMatches([]); setHighlight(-1); setError(false);
    if (!focused || disabled || !term) return;
    let active = true;
    const timer = window.setTimeout(() => {
      const escaped = term.replace(/[\\%_]/g, '\\$&');
      void supabase!.from('inventory_items').select('id,name,quantity').eq('household_id', householdId).eq('freezer_id', freezerId)
        .ilike('name', `%${escaped}%`).order('updated_at', { ascending: false }).order('name').limit(6).retry(false).abortSignal(AbortSignal.timeout(10000)).then(({ data, error }) => {
        if (!active) return;
        if (error) setError(true); else setMatches(data.sort((a, b) => Number(b.name.toLowerCase().startsWith(term.toLowerCase())) - Number(a.name.toLowerCase().startsWith(term.toLowerCase())) || a.name.localeCompare(b.name)));
      });
    }, 150);
    return () => { active = false; window.clearTimeout(timer); };
  }, [householdId, freezerId, value, term, focused, disabled, revision]);
  function choose(name: string) { onChange(name); inputRef.current?.focus(); setDismissed(true); setHighlight(-1); }
  return <div className="item-name" onBlur={event => { if (!event.currentTarget.contains(event.relatedTarget as Node | null)) { setFocused(false); setHighlight(-1); } }}>
    <div className="item-name-heading"><label htmlFor={id}>Item name</label>{exact && onEdit && <button type="button" className="text-button saved-name-edit" disabled={disabled} onClick={() => { setDismissed(true); onEdit(exact); }}>Edit saved name</button>}</div><div className="name-autocomplete">
      <input id={id} ref={inputRef} role="combobox" aria-autocomplete="list" aria-expanded={expanded} aria-controls={expanded ? listId : undefined} aria-activedescendant={expanded && highlight >= 0 ? `${listId}-${highlight}` : undefined} aria-describedby={error ? `${id}-error` : undefined}
        autoComplete="off" value={value} required maxLength={200} disabled={disabled} placeholder="e.g. Chicken thighs"
        onFocus={() => { setFocused(true); setDismissed(false); }} onChange={event => { onChange(event.target.value); setMatches([]); setHighlight(-1); setDismissed(false); }}
        onKeyDown={event => {
          if ((event.key === 'ArrowDown' || event.key === 'ArrowUp') && names.length && term) {
            event.preventDefault(); setDismissed(false); setHighlight(previous => event.key === 'ArrowDown' ? (previous + 1) % names.length : (previous <= 0 ? names.length - 1 : previous - 1));
          } else if (event.key === 'Enter' && expanded && highlight >= 0) { event.preventDefault(); choose(names[highlight]); }
          else if (event.key === 'Escape') { if (expanded) { event.preventDefault(); event.stopPropagation(); } setDismissed(true); setHighlight(-1); }
          else if (event.key === 'Tab') { setDismissed(true); setHighlight(-1); }
        }}/>
      {expanded && <div className="suggestion-dropdown" id={listId} role="listbox" aria-label="Matching item names">{names.map((name, index) => <button type="button" role="option" tabIndex={-1} id={`${listId}-${index}`} key={name} aria-selected={highlight === index} onMouseDown={event => event.preventDefault()} onMouseEnter={() => setHighlight(index)} onClick={() => choose(name)}>{name}</button>)}</div>}
    </div>{error && focused && <p id={`${id}-error`} className="suggestions-note">Suggestions couldn’t load. You can still enter any item name.</p>}
  </div>;
}
