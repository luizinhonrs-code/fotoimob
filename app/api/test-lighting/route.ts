import { NextRequest } from 'next/server'
import { checkExposure } from '@/lib/exposure-check'
import { replicate } from '@/lib/replicate'
import { supabaseServer } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 30

const CLIP_VERSION = '566ab1f111e526640c5154e712d4d54961414278f89d36590f1425badc763ecb'
const CLIP_TEXT = [
  'living room interior with sofa couch and television',
  'bedroom interior with bed mattress and pillows',
  'kitchen interior with stove oven refrigerator and cabinets',
  'bathroom interior with toilet sink shower or bathtub',
  'open balcony terrace with railing outdoors',
  'building exterior facade front view street',
  'garage parking area with car or gate',
  'laundry service room with washing machine',
  'narrow corridor hallway entrance hall interior',
  'home office study room with desk computer',
  'dining room with dining table and chairs',
  'swimming pool outdoor area',
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
