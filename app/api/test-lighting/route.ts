import { NextRequest } from 'next/server'
import { checkExposure } from '@/lib/exposure-check'
import { replicate } from '@/lib/replicate'
import { supabaseServer } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 30

const CLIP_VERSION = '056324d6fb78878c1016e432a3827fa76950022848c5378681dd99b7dc7dcc24'
const CLIP_TEXT = [
  'living room interior',
  'bedroom interior with bed',
  'kitchen interior with cabinets',
  'bathroom interior with sink or toilet',
  'balcony or terrace outdoor',
  'building facade exterior street view',
  'garage or parking area',
  'laundry room or service area',
  'corridor or hallway interior',
  'home office or study room',
  'dining room with table and chairs',
  'swimming pool outdoor',
].join(' | ')

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null
    if (!file) return Response.json({ error: 'No file provided' }, { status: 400 })

    const bytes = new Uint8Array(await file.arrayBuffer())

    // 1. Upload + exposição (rápidos)
    const timestamp = Date.now()
    const safeName = file.name.replace(/[^a-zA-Z0-9._-]/g, '_')
    const storagePath = `test_${timestamp}_${safeName}`
    const enhancedPath = `test_${timestamp}_enhanced_${safeName}`

    const { error: uploadError } = await supabaseServer.storage
      .from('processed')
      .upload(storagePath, Buffer.from(bytes), { contentType: file.type, upsert: false })
    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`)

    const { data: urlData } = supabaseServer.storage.from('processed').getPublicUrl(storagePath)
    const originalUrl = urlData.publicUrl

    const exposure = await checkExposure(bytes)

    // 2. Dispara CLIP (async — não espera)
    const clipPrediction = await replicate.predictions.create({
      version: CLIP_VERSION,
      input: { image: originalUrl, text: CLIP_TEXT },
    })

    // 3. Retorna imediatamente com clipId — frontend faz polling
    return Response.json({
      phase: 'clip',
      clipId: clipPrediction.id,
      exposure,
      originalUrl,
      storagePath,
      enhancedPath,
    })
  } catch (error) {
    console.error('test-lighting POST error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
