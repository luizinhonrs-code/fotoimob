import { NextRequest } from 'next/server'
import { replicate } from '@/lib/replicate'
import { supabaseServer } from '@/lib/supabase'
import { checkExposure } from '@/lib/exposure-check'

export const runtime = 'nodejs'
export const maxDuration = 30

type Intensity = 'low' | 'medium' | 'high'
type Style = 'vivido' | 'quente' | 'externo'

function getIntensity(luminance: number): Intensity {
  if (luminance >= 140) return 'low'
  if (luminance >= 105) return 'medium'
  return 'high'
}

// ── Anti-blowout — instrução comum a todos os prompts internos ──────────────
const ANTI_BLOWOUT = `
⚠️ WINDOW & HIGHLIGHT PROTECTION — HIGHEST PRIORITY RULE — OVERRIDES EVERYTHING:
1. NEVER increase the brightness of any window area, glass door, or skylight under any circumstances.
2. If a window area is already bright or blown out, you MUST darken it slightly to recover frame edges, glass texture, and a hint of the exterior. Do not leave windows as pure featureless white.
3. Window frames (especially dark/black frames) must remain clearly visible and dark — do not bleach them white.
4. Do NOT add, invent, or place curtains, blinds, shutters, or any window covering that does not exist in the original photo. This is absolutely forbidden.
5. Bright ceiling lights and lamp fixtures must not be amplified — hold them at their current brightness or slightly reduce halos around them.
6. This window and highlight protection rule takes absolute precedence over ALL brightness and exposure instructions below.`

// ── Intensidades para fotos internas ────────────────────────────────────────
const INTENSITY_CONFIG: Record<Intensity, { value: number; brightnessInstruction: string }> = {
  low: {
    value: 8,
    brightnessInstruction:
      'The photo is already well-lit. Do NOT increase brightness or exposure anywhere. ' +
      'Apply only: subtle vibrancy boost on colors, gentle micro-contrast on textures (wood, fabric, floor). ' +
      'The result must look nearly identical to the original — a very light polish only.',
  },
  medium: {
    value: 18,
    brightnessInstruction:
      'Apply a minimal brightness lift (Intensity Value: 18) — only the darkest shadow areas. ' +
      'Do NOT brighten walls, ceilings, or any mid-tone area. ' +
      'Boost color vibrancy meaningfully — colors should feel rich and alive, not flat. ' +
      'Remove subtle haze. Enhance micro-contrast on all textures.',
  },
  high: {
    value: 38,
    brightnessInstruction:
      'Apply a moderate brightness lift (Intensity Value: 38) to shadow and mid-tone areas only. ' +
      'Brighten walls and floors naturally — do NOT touch already-bright areas. ' +
      'Maintain absolute fidelity: do not invent, move, or alter any object, surface, or material. ' +
      'Boost color vibrancy significantly. Open shadows gradually, never abruptly.',
  },
}

// ── Prompt para fotos internas ───────────────────────────────────────────────
function buildInteriorPrompt(style: 'vivido' | 'quente', intensity: Intensity): string {
  const { value, brightnessInstruction } = INTENSITY_CONFIG[intensity]

  const colorSection = style === 'vivido'
    ? 'Enhance vibrancy and richness on all existing colors — make them pop without shifting hues. ' +
      'Neutralize unwanted color casts. Keep whites neutral and clean.'
    : 'Enhance warm tones — golden ambers, rich wood browns, soft creams. ' +
      'Add a subtle warm glow. Whites should feel warm and inviting, not sterile.'

  const lightingSection = style === 'vivido'
    ? 'Fill the scene with neutral, bright daylight. Deep blacks, balanced clean whites, vibrant colors.'
    : 'Fill the scene with soft, warm interior lighting reminiscent of late afternoon golden hour. Deep rich blacks, warm clean whites, cozy vibrant colors.'

  return `Intensity Value: ${value}. Act as a surgical photo editor specializing in real estate architectural fidelity.

ABSOLUTE PRESERVATION RULES — NON-NEGOTIABLE:
- Do NOT add, remove, move, or change any object, furniture, or element — not even small ones.
- Do NOT add curtains, blinds, or any window covering that does not exist in the original.
- Do NOT alter what is visible through windows. If night — keep night. If day — keep day. If blurred exterior — keep it blurred.
- Do NOT change the color temperature direction of the scene.
- Do NOT hallucinate or invent any detail in unclear or bright areas.
- Do NOT deform counters, shelves, furniture edges, or architectural lines.
- Do NOT smooth structural features, cracks, pipes, or construction elements.
- Preserve the exact hue and shape of all fabrics, furniture, and surfaces.
- Text on signs, books, labels: do not alter or distort.
${ANTI_BLOWOUT}
BRIGHTNESS & EXPOSURE:
${brightnessInstruction}

TEXTURE & MICRO-CONTRAST:
Significantly enhance local contrast on all textures (wood grain, metal, fabric, floor). Make every contour and edge sharp and distinct.

COLOR:
${colorSection}

LIGHTING & QUALITY:
${lightingSection} Professional real estate photography with a magazine finish.`
}

// ── Prompt para fotos externas ───────────────────────────────────────────────
function buildExteriorPrompt(): string {
  return `Act as a surgical photo editor specializing in real estate architectural fidelity. This is an EXTERIOR photograph. Apply subtle enhancement only.

ABSOLUTE PRESERVATION RULES — NON-NEGOTIABLE:
- Do NOT add, remove, move, or change any architectural element, vehicle, plant, or object.
- Do NOT alter the building structure, windows, doors, roof, or facade in any way.
- Do NOT change the time of day or weather conditions.
- Do NOT hallucinate trees, clouds, or landscaping that do not exist.
- Preserve the exact color of all building materials (concrete, brick, wood, metal).

SPECIFIC ENHANCEMENTS:
Sky: The sky must ALWAYS look clean, open, and beautiful. If it is blue, make it more vivid and rich. If it is light gray or hazy, gently push it toward a cleaner, brighter tone. NEVER darken the sky. NEVER add black patches, dark gradients, or artificial shadows to the sky. If clouds exist, keep them — do not remove. Do not invent clouds where there are none.

Grass & Vegetation: Enhance the green saturation of grass and plants to make them look lush and healthy. Do not invent vegetation.

Facade & Building: Enhance micro-contrast and texture on walls, stone, and wood. Clean up any hazy or flat areas. Do not brighten already-bright walls beyond their natural tone.

Shadows: Gently lift the darkest shadow areas under eaves or in the garage to reveal detail. Do not overdo it.

Overall: The result must look like the same photo taken on a slightly better day — same scene, same time, just crisper, more vivid, and more inviting. Professional real estate exterior photography.`
}

// ── Main prompt builder ──────────────────────────────────────────────────────
function buildPrompt(style: Style, intensity: Intensity): string {
  if (style === 'externo') return buildExteriorPrompt()
  return buildInteriorPrompt(style, intensity)
}

// ── POST ─────────────────────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file   = formData.get('file')   as File | null
    const preset = (formData.get('preset') as string | null) ?? 'vivido'

    if (!file) return Response.json({ error: 'No file provided' }, { status: 400 })
    if (!['vivido', 'quente', 'externo'].includes(preset))
      return Response.json({ error: 'Invalid preset' }, { status: 400 })

    const bytes = new Uint8Array(await file.arrayBuffer())

    const exposure  = await checkExposure(bytes)
    const intensity = getIntensity(exposure.luminance)
    const prompt    = buildPrompt(preset as Style, intensity)

    const timestamp   = Date.now()
    const safeName    = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const storagePath = `flux_${timestamp}_original_${safeName}`
    const resultPath  = `flux_${timestamp}_${preset}_${safeName.replace(/\.[^.]+$/, '')}.jpg`

    const { error: uploadError } = await supabaseServer.storage
      .from('processed')
      .upload(storagePath, Buffer.from(bytes), { contentType: file.type, upsert: false })
    if (uploadError) throw new Error(`Upload falhou: ${uploadError.message}`)

    const { data: urlData } = supabaseServer.storage.from('processed').getPublicUrl(storagePath)
    const originalUrl = urlData.publicUrl

    const mime    = file.type || 'image/jpeg'
    const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`

    const prediction = await replicate.predictions.create({
      model: 'black-forest-labs/flux-2-klein-4b',
      input: {
        images:            [dataUri],
        prompt,
        seed:              1734845908,
        aspect_ratio:      'match_input_image',
        output_megapixels: '4',
        output_format:     'jpg',
        output_quality:    100,
      },
    })

    return Response.json({
      predictionId: prediction.id,
      originalUrl,
      resultPath,
      preset,
      intensity: preset === 'externo' ? 'low' : intensity,
      luminance: exposure.luminance,
    })
  } catch (error) {
    console.error('test-flux POST error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
