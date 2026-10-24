export type SearchableItem = { name: string; tags?: string[]; synonyms?: string[] };

function words(value: string): string[] {
  return value.normalize('NFKD').replace(/\p{M}/gu, '').toLowerCase().match(/[\p{L}\p{N}]+/gu) ?? [];
}

// Small household lists can search locally, including while offline. Each query
// word must match; short words stay exact to avoid broad accidental matches.
function near(a: string, b: string): boolean {
  const limit = a.length >= 8 ? 2 : 1;
  if (Math.abs(a.length - b.length) > limit) return false;
  const rows: number[][] = [Array.from({ length: b.length + 1 }, (_, i) => i)];
  for (let i = 1; i <= a.length; i++) {
    const row = [i];
    for (let j = 1; j <= b.length; j++) {
      row[j] = Math.min(rows[i - 1][j] + 1, row[j - 1] + 1, rows[i - 1][j - 1] + Number(a[i - 1] !== b[j - 1]));
      if (i > 1 && j > 1 && a[i - 1] === b[j - 2] && a[i - 2] === b[j - 1]) row[j] = Math.min(row[j], rows[i - 2][j - 2] + 1);
    }
    rows.push(row);
  }
  return rows[a.length][b.length] <= limit;
}

export function matchesInventory(item: SearchableItem, query: string): boolean {
  const terms = words(query).slice(0, 20);
  const candidates = words([item.name, ...(item.tags ?? []), ...(item.synonyms ?? [])].join(' '));
  return terms.every(term => candidates.some(candidate => candidate.includes(term) || (term.length >= 4 && near(term, candidate))));
}
