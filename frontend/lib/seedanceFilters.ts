/**
 * Seedance content-filter classifiers — ONE place, because two call sites must agree.
 *
 * The two blocks have opposite remedies: an AUDIO block is retried by resubmitting with
 * `generate_audio: false`, an IDENTITY block by regenerating the keyframe as a fictional
 * face. Routing one into the other's remedy costs a paid render and fixes nothing, and
 * the word "copyright" appears in BOTH messages — so the two tests are written together
 * here rather than as two regexes drifting apart in FinalGenView and StudioView.
 */

/**
 * Seedance refused the render over the audio it was about to GENERATE (not over anything
 * we attached). Two wordings are known to reach us and both must match, or the whole
 * paid render dies on a toast the operator has to redo by hand:
 *
 *   "…audio… sensitive…"                                          the original
 *   "The request failed because the output audio may be related    2026-08-11, Studio,
 *    to copyright restrictions."                                   a product shot with
 *                                                                  one reference and no
 *                                                                  dialogue
 *
 * The second carries no "sensitive", so the original `/audio/ && /sensitive/` pair matched
 * nothing and neither retry branch fired. It trips when audio generation is ON for a shot
 * with no audio direction at all: Seedance invents a score and its own copyright filter
 * rejects it — which is why it happens intermittently, depending on what it composed.
 */
export function isAudioFilterBlock(message: string): boolean {
  return /audio/i.test(message) && /sensitive|copyright|restrict/i.test(message)
}

/**
 * Seedance's real-person / IP filter rejected an INPUT image — typically a keyframe whose
 * face reads as a real or famous person.
 *
 * The `!/audio/i` guard is load-bearing and is kept EXACTLY as it was: it is what stops an
 * audio failure (which also says "copyright") from triggering a keyframe regeneration —
 * an image remedy for a sound problem. Deliberately not `!isAudioFilterBlock(...)`, which
 * would newly admit messages that mention audio without a filter word.
 */
export function isIdentityFilterBlock(message: string): boolean {
  return /privacyinformation|inputimagesensitive|real person|copyright/i.test(message)
    && !/audio/i.test(message)
}
