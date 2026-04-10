import { NextRequest } from 'next/server'
import { replicate } from '@/lib/replicate'
import { supabaseServer } from '@/lib/supabase'
import { checkExposure } from '@/lib/exposure-check'

export const runtime = 'nodejs'
export const maxDuration = 30

// ── Intensidade adaptativa por luminância ──────────────────────────────────
// low   → foto já clara (140+)   : só vibrância, sem clareamento
// medium → normal (105–140)      : leve clareamento + vibrância
// high  → escura (< 105)         : clareamento completo + vibrância
type Intensity = 'low' | 'medium' | 'high'

function getIntensity(luminance: number): Intensity {
  if (luminance >= 140) return 'low'
  if (luminance >= 105) return 'medium'
  return 'high'
}

const INTENSITY_CONFIG: Record<Intensity, { value: number; brightnessInstruction: string }> = {
  low: {
    value: 15,
    brightnessInstruction:
      'The photo is already well-lit. DO NOT increase overall brightness. ' +
      'Apply zero exposure gain. Focus exclusively on vibrancy, micro-contrast, and texture enhancement.',
  },
  medium: {
    value: 30,
    brightnessInstruction:
      'Apply a conservative brightness lift (Intensity Value: 30). ' +
      'Gently open shadows. Avoid overexposing highlights. Preserve the original ambient light mood.',
  },
  high: {
    value: 55,
    brightnessInstruction:
      'Apply a significant brightness lift (Intensity Value: 55) to correct the underexposed image. ' +
      'Fill shadows with natural light while carefully protecting all highlight details from blowing out.',
  },
}

// ── Prompt builder ──────────────────────────────────────────────────────────
function buildPrompt(style: 'vivido' | 'quente', intensity: Intensity): string {
  const { value, brightnessInstruction } = INTENSITY_CONFIG[intensity]

  const colorSection =
    style === 'vivido'
      ? 'Enhance vibrancy and richness on existing colors to make them pop against the neutral background. ' +
        'Neutralize unwanted color casts. Keep whites neutral and clean.'
      : 'Enhance warm tones — golden ambers, rich wood browns, soft creams. ' +
        'Add a subtle warm glow. Boost richness on warm colors without turning cool surfaces orange. ' +
        'Whites should feel warm and inviting, not sterile.'

  const lightingSection =
    style === 'vivido'
      ? 'Fill the scene with neutral, bright daylight. ' +
        'The final output must have deep blacks, balanced clean whites, and vibrant colors.'
      : 'Fill the scene with soft, warm interior lighting reminiscent of late afternoon golden hour. ' +
        'The final output must have deep rich blacks, warm clean whites, and cozy vibrant colors.'

  return `Intensity Value: ${value}. Act as a surgical photo editor specializing in real estate architectural fidelity.

ABSOLUTE PRESERVATION RULES — NON-NEGOTIABLE:
- Do NOT add, remove, move, or change any object, furniture, or element in the scene.
- Do NOT alter what is visible through windows. If the window shows night/dark, keep it night. If it shows day, keep it day.
- Do NOT change the color temperature direction of the scene (do not turn a warm room cold or vice versa beyond the selected style).
- Do NOT hallucinate or invent any detail in unclear areas.
- Do NOT smooth structural features, cracks, pipes, or construction elements.
- Preserve the exact hue of all fabrics, furniture, and surfaces — only adjust brightness and saturation within the original color family.
- Text on signs, books, labels: do not alter, distort, or hallucinate.

BRIGHTNESS & EXPOSURE:
${brightnessInstruction}
Apply precise highlight recovery. Prevent white walls, fabrics, and window light from becoming featureless white. Remove hazy/foggy overlays.

TEXTURE & MICRO-CONTRAST:
Significantly enhance local contrast on all textures (wood grain, metal, fabric, floor). Make every contour and edge sharp and distinct, creating a premium real estate finish.

COLOR:
${colorSection}

LIGHTING & QUALITY:
${lightingSection} Professional real estate photography with a magazine finish.`
}

// ── POST ────────────────────────────────────────────────────────────────────
export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file   = formData.get('file')   as File | null
    const preset = (formData.get('preset') as string | null) ?? 'vivido'

    if (!file) return Response.json({ error: 'No file provided' }, { status: 400 })
    if (preset !== 'vivido' && preset !== 'quente')
      return Response.json({ error: 'Invalid preset' }, { status: 400 })

    const bytes = new Uint8Array(await file.arrayBuffer())

    // Analisa luminância para escolher intensidade
    const exposure  = await checkExposure(bytes)
    const intensity = getIntensity(exposure.luminance)
    const prompt    = buildPrompt(preset as 'vivido' | 'quente', intensity)

    // Upload original para exibição no frontend
    const timestamp  = Date.now()
    const safeName   = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const storagePath = `flux_${timestamp}_original_${safeName}`
    const resultPath  = `flux_${timestamp}_${preset}_${safeName.replace(/\.[^.]+$/, '')}.jpg`

    const { error: uploadError } = await supabaseServer.storage
      .from('processed')
      .upload(storagePath, Buffer.from(bytes), { contentType: file.type, upsert: false })
    if (uploadError) throw new Error(`Upload falhou: ${uploadError.message}`)

    const { data: urlData } = supabaseServer.storage.from('processed').getPublicUrl(storagePath)
    const originalUrl = urlData.publicUrl

    // Imagem como base64 — Replicate não acessa URLs do Supabase diretamente
    const mime    = file.type || 'image/jpeg'
    const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`

    // Dispara FLUX
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
      intensity,
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
