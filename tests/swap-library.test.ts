import { describe, it, expect } from 'bun:test';
import library, { suggestSwaps } from '../src/data/swap-library';
import type { SwapEntry } from '../src/data/swap-library';

describe('swap-library', () => {
  it('has exactly 25 entries', () => {
    expect(library).toHaveLength(25);
  });

  it('every entry has all required fields with non-empty values', () => {
    const requiredFields: (keyof SwapEntry)[] = ['id', 'category', 'from', 'to', 'why', 'impact'];
    for (const entry of library) {
      for (const field of requiredFields) {
        expect(typeof entry[field]).toBe('string');
        expect((entry[field] as string).length).toBeGreaterThan(0);
      }
    }
  });

  it('all entry ids are unique and follow swap_NN format', () => {
    const ids = library.map((e) => e.id);
    const uniqueIds = new Set(ids);
    expect(uniqueIds.size).toBe(ids.length);
    for (const id of ids) {
      expect(id).toMatch(/^swap_\d{2}$/);
    }
  });

  it('categories are limited to the 6 valid values', () => {
    const validCategories = new Set([
      'fiber', 'sugar', 'protein', 'sodium', 'saturated_fat', 'produce',
    ]);
    for (const entry of library) {
      expect(validCategories.has(entry.category)).toBe(true);
    }
  });

  it('category distribution: 5 fiber, 5 sugar, 5 protein, 3 sodium, 3 saturated_fat, 4 produce', () => {
    const counts: Record<string, number> = {};
    for (const entry of library) {
      counts[entry.category] = (counts[entry.category] ?? 0) + 1;
    }
    expect(counts['fiber']).toBe(5);
    expect(counts['sugar']).toBe(5);
    expect(counts['protein']).toBe(5);
    expect(counts['sodium']).toBe(3);
    expect(counts['saturated_fat']).toBe(3);
    expect(counts['produce']).toBe(4);
  });

  it('suggestSwaps(["fiber"]) returns at least 3 fiber entries', () => {
    const results = suggestSwaps(['fiber']);
    expect(results.length).toBeGreaterThanOrEqual(3);
    for (const entry of results) {
      expect(entry.category).toBe('fiber');
    }
  });

  it('suggestSwaps(["fiber"]) returns at most 3 entries (top 3)', () => {
    const results = suggestSwaps(['fiber']);
    expect(results.length).toBeLessThanOrEqual(3);
  });

  it('suggestSwaps(["fiber","protein"]) returns a mix of both categories', () => {
    const results = suggestSwaps(['fiber', 'protein']);
    const categories = results.map((e) => e.category);
    expect(categories).toContain('fiber');
    expect(categories).toContain('protein');
  });

  it('suggestSwaps(["fiber","protein"]) returns up to 6 entries (3 per category)', () => {
    const results = suggestSwaps(['fiber', 'protein']);
    expect(results.length).toBeGreaterThanOrEqual(2);
    expect(results.length).toBeLessThanOrEqual(6);
  });

  it('suggestSwaps([]) returns empty array', () => {
    expect(suggestSwaps([])).toHaveLength(0);
  });

  it('suggestSwaps with unknown category returns empty array', () => {
    expect(suggestSwaps(['unknown_gap'])).toHaveLength(0);
  });

  it('suggestSwaps is deterministic — same input yields same output', () => {
    const a = suggestSwaps(['sodium']);
    const b = suggestSwaps(['sodium']);
    expect(a.map((e) => e.id)).toEqual(b.map((e) => e.id));
  });
});
