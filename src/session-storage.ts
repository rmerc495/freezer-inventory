// Auth tokens use exactly one store. Remember me is a preference, not a password.
export function createSessionStorage(local: Storage, session: Storage) {
  const preferenceKey = 'freezer.remember';
  const keys = new Set<string>();
  const remembered = () => local.getItem(preferenceKey) === 'true';
  const active = () => remembered() ? local : session;
  const inactive = () => remembered() ? session : local;
  return {
    remembered,
    setRemember(value: boolean) {
      const previous = active();
      const entries = [...keys].map(key => [key, previous.getItem(key)] as const);
      local.setItem(preferenceKey, String(value));
      for (const [key, data] of entries) {
        inactive().removeItem(key);
        if (data !== null) active().setItem(key, data);
      }
    },
    getItem(key: string) { keys.add(key); return active().getItem(key); },
    setItem(key: string, value: string) {
      keys.add(key); inactive().removeItem(key); active().setItem(key, value);
    },
    removeItem(key: string) { keys.add(key); local.removeItem(key); session.removeItem(key); },
  };
}
