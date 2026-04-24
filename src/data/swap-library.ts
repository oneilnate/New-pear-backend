import swapData from './swap-library.json' assert { type: 'json' };

export interface SwapEntry {
  id: string;
  category: 'fiber' | 'sugar' | 'protein' | 'sodium' | 'saturated_fat' | 'produce';
  from: string;
  to: string;
  why: string;
  impact: string;
}

const library: SwapEntry[] = swapData as SwapEntry[];

/**
 * Returns the top 3 swap suggestions for each supplied gap category, in
 * deterministic order (preserves JSON declaration order within each category).
 *
 * @param gaps - Array of nutrient gap category names to look up.
 * @returns   Flat array of SwapEntry objects, up to 3 per supplied category.
 *
 * @example
 * suggestSwaps(['fiber'])          // 3 fiber swap entries
 * suggestSwaps(['fiber','protein']) // up to 3 fiber + 3 protein entries
 */
export function suggestSwaps(gaps: string[]): SwapEntry[] {
  const results: SwapEntry[] = [];
  for (const gap of gaps) {
    const matches = library.filter((entry) => entry.category === gap);
    results.push(...matches.slice(0, 3));
  }
  return results;
}

export default library;
