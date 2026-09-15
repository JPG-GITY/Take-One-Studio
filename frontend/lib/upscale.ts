// AI MediaKit Video Enhancement — the picker values shared by the Studio "Upscale"
// action and Stage 6's "Upscale master". They are the vendor's own (enhance-video:
// resolution 2k|4k|8k, tool_version standard|professional, enhance_style hd|natural);
// the backend refuses anything else before a clip is hosted or paid for.
export const UPSCALE_RES = [{ id: '2k', label: '2K' }, { id: '4k', label: '4K' }, { id: '8k', label: '8K' }] as const
export const UPSCALE_TIERS = [{ id: 'standard', label: 'Standard' }, { id: 'professional', label: 'Professional' }] as const
export const UPSCALE_STYLES = [{ id: 'hd', label: 'HD' }, { id: 'natural', label: 'Natural' }] as const
export type UpRes = typeof UPSCALE_RES[number]['id']
export type UpTier = typeof UPSCALE_TIERS[number]['id']
export type UpStyle = typeof UPSCALE_STYLES[number]['id']

/** What POST /api/studio/upscale/quote answers. `input_note` is non-empty when the
 *  vendor would refuse the source (its input ceiling is 2K). */
export interface UpscaleQuote { usd: number; seconds: number; width?: number | null; height?: number | null; input_note?: string }
