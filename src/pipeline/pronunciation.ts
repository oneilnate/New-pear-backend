/**
 * Pre-TTS pronunciation fixes for ElevenLabs.
 *
 * eleven_multilingual_v2 mispronounces certain English and loanword tokens.
 * SSML <phoneme> tags are NOT supported by the multilingual model, so we
 * respell problem words phonetically before sending the script.
 *
 * Whole-word, case-insensitive replacement.
 */

export const PRONUNCIATION_MAP: Array<[RegExp, string]> = [
  // English units that come out wrong
  [/\bounces\b/gi, 'OWN-sez'],
  [/\bounce\b/gi, 'OWN-suh'],
  [/\boz\b/gi, 'ounces'],

  // Loanwords / cuisine vocabulary
  [/\bbanh\s+mi\b/gi, 'bahn mee'],
  [/\bbánh\s+mì\b/gi, 'bahn mee'],
  [/\bquinoa\b/gi, 'KEEN-wah'],
  [/\baçaí\b/gi, 'ah-sah-EE'],
  [/\baçai\b/gi, 'ah-sah-EE'],
  [/\bacai\b/gi, 'ah-sah-EE'],
  [/\bgyros?\b/gi, 'YEER-ohs'],
  [/\bpho\b/gi, 'fuh'],
  [/\bedamame\b/gi, 'eh-dah-MAH-may'],
  [/\bkombucha\b/gi, 'kom-BOO-cha'],
  [/\btahini\b/gi, 'tah-HEE-nee'],
  [/\bbruschetta\b/gi, 'broo-SKET-tah'],
  [/\bgnocchi\b/gi, 'NYOH-kee'],
  [/\bjicama\b/gi, 'HEE-kah-mah'],
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
