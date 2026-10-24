import { describe, expect, it } from 'vitest';
import { matchesInventory } from './inventory-search';

describe('inventory search', () => {
  const broccoli = { name: 'Broccoli Florets', tags: ['vegetables', 'side dishes'], synonyms: ['broccoli'] };
  it('searches names, tags and synonyms with all query words', () => {
    expect(matchesInventory(broccoli, 'VEGETABLES')).toBe(true);
    expect(matchesInventory(broccoli, 'vegetables florets')).toBe(true);
    expect(matchesInventory(broccoli, 'vegetables chicken')).toBe(false);
    expect(matchesInventory({ name: 'Chicken Nuggets', tags: ['snacks'], synonyms: ['nuggets'] }, 'chicken')).toBe(true);
    expect(matchesInventory({ name: 'Green Beans', tags: ['vegetables'] }, 'vegetables')).toBe(true);
  });
  it('tolerates edits, transpositions and accents without fuzzing short words', () => {
    expect(matchesInventory(broccoli, 'brocoli')).toBe(true);
    expect(matchesInventory(broccoli, 'vegtables')).toBe(true);
    expect(matchesInventory({ name: 'Chicken' }, 'chikcen')).toBe(true);
    expect(matchesInventory({ name: 'Jalapeño Poppers' }, 'jalapeno')).toBe(true);
    expect(matchesInventory({ name: 'Peas' }, 'pie')).toBe(false);
    expect(matchesInventory(broccoli, 'snacks')).toBe(false);
  });
  it('works before enrichment and handles whitespace/punctuation literally', () => {
    expect(matchesInventory({ name: 'Chicken Thighs' }, 'chick')).toBe(true);
    expect(matchesInventory(broccoli, '  ')).toBe(true);
    expect(matchesInventory(broccoli, '% _')).toBe(true);
  });
});
