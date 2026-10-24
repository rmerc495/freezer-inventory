import { describe, expect, it } from 'vitest';
import { parseBulk, validateBulk } from './bulk-entry';

describe('bulk entry text and validation', () => {
  it('reads x/× quantities, plain names, blank lines and CRLF without treating product numbers as quantities', () => {
    const preview = validateBulk(parseBulk('Chicken Thighs x 3\r\n\nBroccoli × 2\nPizza\n80/20 Beef\nVitamin B12'));
    expect(preview.errors).toEqual([]);
    expect(preview.items).toEqual([{ name: 'Chicken Thighs', quantity: 3 }, { name: 'Broccoli', quantity: 2 }, { name: 'Pizza', quantity: 1 }, { name: '80/20 Beef', quantity: 1 }, { name: 'Vitamin B12', quantity: 1 }]);
  });
  it('combines whitespace/case duplicates and detects combined overflow', () => {
    expect(validateBulk(parseBulk(' chicken  thighs x 2\nCHICKEN THIGHS x 3')).items).toEqual([{ name: 'chicken thighs', quantity: 5 }]);
    expect(validateBulk(parseBulk('peas x 2147483647\nPEAS')).errors.join()).toContain('Combined quantity');
  });
  it.each(['0', '-1', '1.5', '', 'three', '2147483648', '1e3'])('flags invalid quantity suffix %s instead of adding one', quantity => {
    expect(validateBulk(parseBulk(`peas x ${quantity}`)).errors.join()).toContain('quantity');
  });
  it('rejects empty batches, missing names, overlong names and overlarge batches', () => {
    for (const text of ['', 'x 3', 'a'.repeat(201), Array(101).fill('peas').join('\n')]) expect(validateBulk(parseBulk(text)).errors.length).toBeGreaterThan(0);
  });
});
