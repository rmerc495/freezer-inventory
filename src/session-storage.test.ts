import { describe, expect, it } from 'vitest';
import { createSessionStorage } from './session-storage';

function memoryStorage(): Storage {
  const map = new Map<string, string>();
  return { get length() { return map.size; }, clear: () => map.clear(), getItem: key => map.get(key) ?? null,
    key: index => [...map.keys()][index] ?? null, removeItem: key => { map.delete(key); }, setItem: (key, value) => { map.set(key, value); } };
}
describe('Remember me session storage', () => {
  it('keeps unchecked sessions out of persistent storage', () => {
    const local = memoryStorage(), session = memoryStorage();
    const storage = createSessionStorage(local, session);
    storage.setItem('auth-token', 'session');
    expect(local.getItem('auth-token')).toBeNull();
    expect(session.getItem('auth-token')).toBe('session');
    expect(createSessionStorage(local, memoryStorage()).getItem('auth-token')).toBeNull();
  });
  it('retains checked sessions on a fresh browser session', () => {
    const local = memoryStorage(), session = memoryStorage();
    const storage = createSessionStorage(local, session);
    storage.setRemember(true); storage.setItem('auth-token', 'persisted');
    expect(session.getItem('auth-token')).toBeNull();
    expect(createSessionStorage(local, memoryStorage()).getItem('auth-token')).toBe('persisted');
  });
  it('moves tracked tokens when preference changes and removes both copies on signout', () => {
    const local = memoryStorage(), session = memoryStorage();
    const storage = createSessionStorage(local, session);
    storage.setItem('auth-token', 'token'); storage.setRemember(true);
    expect(session.getItem('auth-token')).toBeNull(); expect(local.getItem('auth-token')).toBe('token');
    storage.setRemember(false);
    expect(local.getItem('auth-token')).toBeNull(); expect(session.getItem('auth-token')).toBe('token');
    storage.removeItem('auth-token');
    expect(local.getItem('auth-token')).toBeNull(); expect(session.getItem('auth-token')).toBeNull();
  });
});
