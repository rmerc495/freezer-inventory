export type BulkRow = { line: number; name: string; quantity: string };
export type BulkItem = { name: string; quantity: number };
export const cleanName = (name: string) => name.trim().replace(/\s+/g, ' ');
export const validQuantity = (quantity: string) => /^\d+$/.test(quantity) && Number(quantity) >= 1 && Number(quantity) <= 2147483647;

export function parseBulk(text: string): BulkRow[] {
  return text.split(/\r?\n/).flatMap((text, index) => {
    const line = text.trim();
    if (!line) return [];
    // Only a trailing x/× quantity is syntax; numbers elsewhere stay in the name.
    const match = line.match(/^(.*?)\s+[x×]\s*(.*)$/i) ?? line.match(/^()[x×]\s+(\d+)$/i);
    return [{ line: index + 1, name: cleanName(match ? match[1] : line), quantity: match ? match[2].trim() : '1' }];
  });
}

export function validateBulk(rows: BulkRow[]): { items: BulkItem[]; errors: string[] } {
  if (!rows.length) return { items: [], errors: ['Enter at least one item.'] };
  if (rows.length > 100) return { items: [], errors: ['Use no more than 100 item lines per batch.'] };
  const combined = new Map<string, BulkItem>();
  const errors: string[] = [];
  for (const row of rows) {
    const name = cleanName(row.name);
    if (Array.from(name).length < 1 || Array.from(name).length > 200) errors.push(`Line ${row.line}: enter a name of 1–200 characters.`);
    if (!validQuantity(row.quantity)) { errors.push(`Line ${row.line}: enter a whole quantity from 1 to 2,147,483,647.`); continue; }
    const key = name.toLowerCase();
    const existing = combined.get(key);
    const quantity = (existing?.quantity ?? 0) + Number(row.quantity);
    if (quantity > 2147483647) errors.push(`Combined quantity is too large for ${name}.`);
    combined.set(key, { name: existing?.name ?? name, quantity });
  }
  return { items: [...combined.values()], errors };
}
