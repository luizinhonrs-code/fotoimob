import { NextRequest } from 'next/server'
import { checkExposure } from '@/lib/exposure-check'
import { detectRoom } from '@/lib/room-detect'
import { replicate } from '@/lib/replicate'
import { supabaseServer } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) return Response.json({ error: 'No file provided' }, { status: 400 })

    const bytes = new Uint8Array(await file.arrayBuffer())

    // 1. Upload primeiro (necessário para CLIP precisar de URL pública)
    const timestamp = Date.now()
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const storagePath = `test_${timestamp}_${safeName}`

    const { error: uploadError } = await supabaseServer.storage
      .from('processed')
      .upload(storagePath, Buffer.from(bytes), { contentType: file.type, upsert: false })

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`)

    const { data: urlData } = supabaseServer.storage.from('processed').getPublicUrl(storagePath)
    const originalUrl = urlData.publicUrl

    // 2. Exposição + CLIP em paralelo
    const [exposure, room] = await Promise.all([
      checkExposure(bytes),
      detectRoom(originalUrl),
    ])

    // 3. Exterior — pula bread independente da luminância
    if (room.isExterior) {
      return Response.json({
        status: 'skipped',
        exposure,
        room,
        originalUrl,
        enhancedUrl: null,
        message: `Exterior detectado (${room.label}, ${room.confidence}%) — bread não aplicado`,
      })
    }

    // 4. Interior mas já bem iluminado — pula bread
    if (!exposure.needsAI) {
      return Response.json({
        status: 'skipped',
        exposure,
        room,
        originalUrl,
        enhancedUrl: null,
        message: `${room.label} bem iluminado (L: ${exposure.luminance}) — bread não aplicado`,
      })
    }

    // 5. Cria predição bread e retorna imediatamente
    const prediction = await replicate.predictions.create({
      version: 'bf9f60e777852145e9e6c06fac109c6d55fec43bd535b6b13d3608c34711060b',
      input: {
        image: originalUrl,
        gamma: exposure.breadParams.gamma,
        strength: exposure.breadParams.strength,
      },
    })

    return Response.json({
      status: 'processing',
      predictionId: prediction.id,
      exposure,
      room,
      originalUrl,
      storagePath: `test_${timestamp}_enhanced_${safeName}`,
    })
  } catch (error) {
    console.error('test-lighting error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
