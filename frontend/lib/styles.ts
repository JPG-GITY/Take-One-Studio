import type { ProjectStyle, StyleId } from '@/lib/types/pipeline.types'

export const STYLE_PRESETS: Record<Exclude<StyleId, 'custom'>, ProjectStyle> = {
  cinematic: {
    id: 'cinematic',
    label: 'Cinematic',
    promptSuffix: 'cinematic film photography, anamorphic lens, film grain, dramatic lighting, shallow depth of field, golden hour, RAW photo, ultra detailed, 35mm film',
    negativePrompt: 'cartoon, anime, drawing, illustration, painting, sketch, CGI, render',
    anchorImageRefs: [],
  },
  photoreal: {
    id: 'photoreal',
    label: 'Photoreal',
    promptSuffix: 'photorealistic, hyperdetailed, 8k resolution, studio lighting, DSLR photo, sharp focus, professional photography, ultra-high detail',
    negativePrompt: 'cartoon, anime, painterly, illustration, low quality, blurry',
    anchorImageRefs: [],
  },
  anime: {
    id: 'anime',
    label: 'Anime',
    promptSuffix: 'anime art style, cel shaded, vibrant colors, clean line art, detailed anime illustration, Studio Ghibli quality, key visual',
    negativePrompt: 'photorealistic, photograph, 3D render, western cartoon, sketch, low quality',
    anchorImageRefs: [],
  },
  pixar3d: {
    id: 'pixar3d',
    label: 'Pixar 3D',
    promptSuffix: 'Pixar animation style, high quality 3D render, subsurface scattering, appealing character design, warm lighting, rendered in Renderman, family friendly, polished production',
    negativePrompt: 'photorealistic, anime, 2D, flat, sketch, low quality, uncanny valley',
    anchorImageRefs: [],
  },
  cartoon2d: {
    id: 'cartoon2d',
    label: '2D Cartoon',
    promptSuffix: 'stylized 2D cartoon, flat design, bold outlines, vibrant saturated colors, character design sheet, clean vector style, expressive',
    negativePrompt: '3D render, photorealistic, anime, complex textures, film grain',
    anchorImageRefs: [],
  },
  comic: {
    id: 'comic',
    label: 'Comic / Graphic Novel',
    promptSuffix: 'comic book art style, bold ink outlines, halftone dots, high contrast, graphic novel illustration, dramatic panel composition, inked',
    negativePrompt: 'photorealistic, 3D render, anime, digital painting, blurry',
    anchorImageRefs: [],
  },
}

export const CUSTOM_STYLE_DEFAULT: ProjectStyle = {
  id: 'custom',
  label: 'Custom',
  promptSuffix: '',
  negativePrompt: '',
  anchorImageRefs: [],
}

export const DEFAULT_STYLE: ProjectStyle = STYLE_PRESETS.cinematic

export function getStyleById(id: StyleId): ProjectStyle {
  if (id === 'custom') return CUSTOM_STYLE_DEFAULT
  return STYLE_PRESETS[id] ?? DEFAULT_STYLE
}
