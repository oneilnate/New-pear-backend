/**
 * Smoke tests for src/pipeline/pronunciation.ts
 *
 * Covers: ounces, oz, banh mi, quinoa, empty string,
 * no-match passthrough, and replacement count tracking.
 */

import { describe, it, expect } from 'vitest';
import { applyPronunciationFixes } from '../src/pipeline/pronunciation.js';

describe('applyPronunciationFixes', () => {
  it('replaces "ounces" with OWN-sez', () => {
    const { text, replacements } = applyPronunciationFixes('Add 6 ounces of water.');
    expect(text).toBe('Add 6 OWN-sez of water.');
    expect(replacements).toBe(1);
  });

  it('replaces "8 oz of yogurt" → "8 ounces of yogurt"', () => {
    const { text, replacements } = applyPronunciationFixes('8 oz of yogurt');
    expect(text).toBe('8 ounces of yogurt');
    expect(replacements).toBe(1);
  });

  it('replaces "Banh Mi" (mixed case) → "bahn mee"', () => {
    const { text, replacements } = applyPronunciationFixes('Order a Banh Mi sandwich.');
    expect(text).toBe('Order a bahn mee sandwich.');
    expect(replacements).toBe(1);
  });

  it('replaces "quinoa" → "KEEN-wah"', () => {
    const { text, replacements } = applyPronunciationFixes('Serve with quinoa on the side.');
    expect(text).toBe('Serve with KEEN-wah on the side.');
    expect(replacements).toBe(1);
  });

  it('handles empty string — returns empty, replacements=0', () => {
    const { text, replacements } = applyPronunciationFixes('');
    expect(text).toBe('');
    expect(replacements).toBe(0);
  });

  it('passes through text with no matches unchanged, replacements=0', () => {
    const input = 'This is a perfectly normal sentence about food.';
    const { text, replacements } = applyPronunciationFixes(input);
    expect(text).toBe(input);
    expect(replacements).toBe(0);
  });

  it('counts multiple replacements correctly', () => {
    const { text, replacements } = applyPronunciationFixes(
      'Use 4 oz of quinoa and 2 ounces of tahini.'
    );
    expect(text).toBe('Use 4 ounces of KEEN-wah and 2 OWN-sez of tah-HEE-nee.');
    expect(replacements).toBe(4); // oz→ounces + ounces→OWN-sez + quinoa→KEEN-wah + tahini→tah-HEE-nee
  });

  it('is case-insensitive for ounces', () => {
    const { text } = applyPronunciationFixes('OUNCES and Ounces and ounces');
    expect(text).toBe('OWN-sez and OWN-sez and OWN-sez');
  });

  it('does not replace "oz" inside a longer word', () => {
    // "ozzie" should NOT be replaced since \b ensures whole-word match
    const { text, replacements } = applyPronunciationFixes('ozzie the dog');
    expect(text).toBe('ozzie the dog');
    expect(replacements).toBe(0);
  });
});
