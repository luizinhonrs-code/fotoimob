import { NextRequest } from 'next/server'
import { checkExposure } from '@/lib/exposure-check'
import { replicate } from '@/lib/replicate'
import { supabaseServer } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const formData = await request.formData()
    const file = formData.get('file') as File | null

    if (!file) return Response.json({ error: 'No file provided' }, { status: 400 })

    const bytes = new Uint8Array(await file.arrayBuffer())

    // 1. Analisa exposição
    const exposure = await checkExposure(bytes)

    // 2. Upload para o bucket processed (temporário, prefixo test_)
    const timestamp = Date.now()
    const storagePath = `test_${timestamp}_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`

    const { error: uploadError } = await supabaseServer.storage
      .from('processed')
      .upload(storagePath, Buffer.from(bytes), { contentType: file.type, upsert: false })

    if (uploadError) throw new Error(`Upload failed: ${uploadError.message}`)

    const { data: urlData } = supabaseServer.storage.from('processed').getPublicUrl(storagePath)
    const originalUrl = urlData.publicUrl

    // 3. Se não precisa de AI, retorna só a análise
    if (!exposure.needsAI) {
      return Response.json({
        exposure,
        originalUrl,
        enhancedUrl: null,
        skipped: true,
        message: `Foto já bem iluminada (L: ${exposure.luminance}) — bread não aplicado`,
      })
    }

    // 4. Chama mingcv/bread com os parâmetros automáticos
    const prediction = await replicate.predictions.create({
      version: 'bf9f60e777852145e9e6c06fac109c6d55fec43bd535b6b13d3608c34711060b',
      input: {
        image: originalUrl,
        gamma: exposure.breadParams.gamma,
        strength: exposure.breadParams.strength,
      },
    })

    // 5. Polling até concluir (max 55s)
    let result = prediction
    const deadline = Date.now() + 55_000
    while (
      result.status !== 'succeeded' &&
      result.status !== 'failed' &&
      result.status !== 'canceled' &&
      Date.now() < deadline
    ) {
      await new Promise((r) => setTimeout(r, 3000))
      result = await replicate.predictions.get(prediction.id)
    }

    if (result.status !== 'succeeded') {
      throw new Error(`bread failed: ${result.error ?? result.status}`)
    }

    const outputUrl = Array.isArray(result.output) ? result.output[0] : result.output

    // 6. Salva resultado no bucket
    const enhancedPath = `test_${timestamp}_enhanced_${file.name.replace(/[^a-zA-Z0-9._-]/g, '_')}`
    const imgRes = await fetch(outputUrl)
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer())

    await supabaseServer.storage
      .from('processed')
      .upload(enhancedPath, imgBuffer, { contentType: 'image/jpeg', upsert: false })

    const { data: enhUrlData } = supabaseServer.storage.from('processed').getPublicUrl(enhancedPath)

    return Response.json({
      exposure,
      originalUrl,
      enhancedUrl: enhUrlData.publicUrl,
      skipped: false,
      breadParams: exposure.breadParams,
    })
  } catch (error) {
    console.error('test-lighting error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
