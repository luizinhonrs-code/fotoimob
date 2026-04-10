import { NextRequest } from 'next/server'
import { replicate } from '@/lib/replicate'
import { supabaseServer } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 30

const PROMPT_VIVIDO = `This is a technical, high-level professional real estate image processing command. Act as a surgical photo editor specializing in architectural fidelity. Apply a professional Real Estate-style clarity and lighting upgrade, aiming to match the crisp, vivid, and textured aesthetic of the provided reference images. The overall brightness and light gain must strictly follow the 40 value provided above: lower numbers mean more conservative lighting, higher numbers mean brighter exposure.

ABSOLUTE AND CRITICAL INSTRUCTION (DISCLAIMER): Under no circumstances are you to add, remove, move, rearrange, or change a single object or element within the composition. The entire scene must remain 100% physically identical. If any part of the scene, especially through windows, is unclear, you are prohibited from hallucinating or inventing new details. Do not smooth over structural features, construction elements, fixed details (exposed pipes, boxes, floor level differences, cracks). If there are cracks or holes, they must remain.

SPECIFIC ENHANCEMENTS & PRESERVATIONS:

EXPOSURE & HIGHLIGHT RECOVERY (ANTI-BLOWN-OUT): Apply precise recovery to all highlights. Prevent any part of the image, especially white walls, light fabrics, and window light, from losing texture or becoming pure, featureless white. The brightness of whites must be tempered by the Intensity Value; do not overexpose. Meticulously recover and preserve details within these bright areas. Softly brighten shadows only as much as the Intensity Value allows. Remove all hazy/foggy overlays.

Text Preservation: Identify any existing text (signs, book titles, labels). Do not alter, hallucinate, or distort these texts. Maintain original characters and fonts with perfect sharpness.

Texture & Micro-Contrast: Significantly enhance local contrast across all textures (wood grain, metal, fabric). Apply a micro-contrast boost to make every single contour, edge, and definition sharp and distinct, creating a textured 'deep' premium Real Estate finish.

Color: Neutralize unwanted yellow/orange casts. Enhance vibrancy and richness on existing colors (teal, crimson, cobalt) to make them pop against the neutral background.

Lighting & Quality: Fill the setup with neutral, bright daylight. The final output must be an immaculate photograph with deep blacks, balanced clean whites, and vibrant colors, showing professional Real Estate photography with a magazine finish.`

const PROMPT_QUENTE = `This is a technical, high-level professional real estate image processing command. Act as a surgical photo editor specializing in architectural fidelity. Apply a professional Real Estate-style warm and inviting lighting upgrade. The overall brightness and light gain must strictly follow the 40 value provided above: lower numbers mean more conservative lighting, higher numbers mean brighter exposure.

ABSOLUTE AND CRITICAL INSTRUCTION (DISCLAIMER): Under no circumstances are you to add, remove, move, rearrange, or change a single object or element within the composition. The entire scene must remain 100% physically identical. If any part of the scene, especially through windows, is unclear, you are prohibited from hallucinating or inventing new details. Do not smooth over structural features, construction elements, fixed details (exposed pipes, boxes, floor level differences, cracks). If there are cracks or holes, they must remain.

SPECIFIC ENHANCEMENTS & PRESERVATIONS:

EXPOSURE & HIGHLIGHT RECOVERY (ANTI-BLOWN-OUT): Apply precise recovery to all highlights. Prevent any part of the image, especially white walls, light fabrics, and window light, from losing texture or becoming pure, featureless white. The brightness of whites must carry a soft warm glow without overexposing. Meticulously recover and preserve details within bright areas. Softly brighten shadows with a warm golden undertone. Remove all hazy/foggy overlays.

Text Preservation: Identify any existing text (signs, book titles, labels). Do not alter, hallucinate, or distort these texts. Maintain original characters and fonts with perfect sharpness.

Texture & Micro-Contrast: Significantly enhance local contrast across all textures (wood grain, metal, fabric). Warm wood tones (oak, walnut, pine) must feel rich, deep and tactile. Apply a micro-contrast boost to make every contour, edge, and definition sharp and distinct.

Color: Enhance warm tones — golden ambers, rich wood browns, soft creams and ivories. Add a subtle warm golden-hour glow to the overall scene. Boost richness on existing warm colors without turning cool surfaces orange. Whites should feel warm and inviting, not sterile.

Lighting & Quality: Fill the setup with soft, warm interior lighting reminiscent of late afternoon golden hour. The final output must be an immaculate photograph with deep rich blacks, warm clean whites, and cozy vibrant colors, showing premium Real Estate photography with a lifestyle magazine finish.`

const PROMPTS: Record<string, string> = {
  vivido: PROMPT_VIVIDO,
  quente: PROMPT_QUENTE,
}

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    const preset = (formData.get('preset') as string | null) ?? 'vivido'

    if (!file) return Response.json({ error: 'No file provided' }, { status: 400 })
    if (!PROMPTS[preset]) return Response.json({ error: 'Invalid preset' }, { status: 400 })

    const bytes = new Uint8Array(await file.arrayBuffer())
    const timestamp = Date.now()
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const storagePath  = `flux_${timestamp}_original_${safeName}`
    const resultPath   = `flux_${timestamp}_${preset}_${safeName.replace(/\.[^.]+$/, '')}.jpg`

    // Upload original para URL pública
    const { error: uploadError } = await supabaseServer.storage
      .from('processed')
      .upload(storagePath, Buffer.from(bytes), { contentType: file.type, upsert: false })
    if (uploadError) throw new Error(`Upload falhou: ${uploadError.message}`)

    const { data: urlData } = supabaseServer.storage.from('processed').getPublicUrl(storagePath)
    const originalUrl = urlData.publicUrl

    // Converte para base64 data URI — Replicate não acessa URLs do Supabase diretamente
    const mime = file.type || 'image/jpeg'
    const dataUri = `data:${mime};base64,${Buffer.from(bytes).toString('base64')}`

    // Dispara FLUX (async)
    const prediction = await replicate.predictions.create({
      model: 'black-forest-labs/flux-2-klein-4b',
      input: {
        images:            [dataUri],
        prompt:            PROMPTS[preset],
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
    })
  } catch (error) {
    console.error('test-flux POST error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
