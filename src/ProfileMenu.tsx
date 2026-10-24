import { useEffect, useId, useRef, useState, type ReactNode } from 'react';
import { createPortal } from 'react-dom';

export function ProfileMenu({ email, householdName, busy, canShare, onShare, onSignOut, children }: { email?: string; householdName?: string; busy: boolean; canShare: boolean; onShare: () => void; onSignOut: () => void; children: ReactNode }) {
  const [open, setOpen] = useState(false);
  const root = useRef<HTMLDivElement>(null);
  const toggle = useRef<HTMLButtonElement>(null);
  const id = useId();
  useEffect(() => {
    if (!open) return;
    const outside = (event: PointerEvent) => { if (!root.current?.contains(event.target as Node)) setOpen(false); };
    const escape = (event: KeyboardEvent) => { if (event.key === 'Escape') { setOpen(false); toggle.current?.focus(); } };
    document.addEventListener('pointerdown', outside); document.addEventListener('keydown', escape);
    return () => { document.removeEventListener('pointerdown', outside); document.removeEventListener('keydown', escape); };
  }, [open]);
  const slot = document.getElementById('profile-slot');
  if (!slot) return null;
  return createPortal(<div className="profile-menu" ref={root} onKeyDown={event => { if (event.key === 'Tab') requestAnimationFrame(() => { if (!root.current?.contains(document.activeElement)) setOpen(false); }); }}>
    <button className="profile-toggle" ref={toggle} aria-label="Profile settings" aria-expanded={open} aria-controls={open ? id : undefined} onClick={() => setOpen(value => !value)}>
      <svg viewBox="0 0 24 24" fill="none" aria-hidden="true"><circle cx="12" cy="8" r="3.5"/><path d="M4.5 21v-2a7.5 7.5 0 0 1 15 0v2"/></svg>
    </button>
    {open && <div id={id} className="profile-panel" role="region" aria-label="App settings"><h2>App settings</h2><p className="profile-email">{email}</p>{householdName && <div className="profile-household"><span>Household</span><p>{householdName}</p></div>}
      <div className="profile-actions">{canShare && <button className="secondary" disabled={busy} onClick={onShare}>Share household</button>}<button className="text-button" disabled={busy} onClick={onSignOut}>Sign out</button></div>
      {children}
    </div>}
  </div>, slot);
}
