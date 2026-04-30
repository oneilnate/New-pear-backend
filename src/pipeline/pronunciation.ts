/**
 * Pre-TTS pronunciation fixes for ElevenLabs.
 *
 * eleven_multilingual_v2 mispronounces certain English and loanword tokens.
 * SSML <phoneme> tags are NOT supported by the multilingual model, so we
 * respell problem words phonetically before sending the script.
 *
 * Whole-word, case-insensitive replacement.
 * All respellings are smooth, unhyphenated, lowercase — no hyphens (pause
 * points) and no ALL-CAPS (unnatural stress) so ElevenLabs reads them as
 * single flowing words.
 */

export const PRONUNCIATION_MAP: Array<[RegExp, string]> = [
  // English units
  [/\bounces\b/gi, 'ownsez'],
  [/\bounce\b/gi, 'ownse'],
  [/\boz\b/gi, 'ounces'],

  // Loanwords — smooth, unhyphenated, lowercase
  [/\bbanh\s+mi\b/gi, 'bon mee'],
  [/\bbánh\s+mì\b/gi, 'bon mee'],
  [/\bquinoa\b/gi, 'keenwah'],
  [/\baçaí\b/gi, 'ahsahee'],
  [/\baçai\b/gi, 'ahsahee'],
  [/\bacai\b/gi, 'ahsahee'],
  [/\bgyros?\b/gi, 'yeerohs'],
  [/\bpho\b/gi, 'fuh'],
  [/\bedamame\b/gi, 'edamamay'],
  [/\bkombucha\b/gi, 'komboocha'],
  [/\btahini\b/gi, 'taheenee'],
  [/\bbruschetta\b/gi, 'brooskettah'],
  [/\bgnocchi\b/gi, 'nyohkee'],
  [/\bjicama\b/gi, 'heekamah'],
];

export function applyPronunciationFixes(text: string): { text: string; replacements: number } {
  let replacements = 0;
  let result = text;
  for (const [pattern, replacement] of PRONUNCIATION_MAP) {
    result = result.replace(pattern, () => {
      replacements++;
      return replacement;
    });
  }
  return { text: result, replacements };
}
