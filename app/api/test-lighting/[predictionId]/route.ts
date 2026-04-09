import { NextRequest } from 'next/server'
import { replicate } from '@/lib/replicate'
import { supabaseServer } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function GET(
  _request: NextRequest,
  { params }: { params: Promise<{ predictionId: string }> }
) {
  try {
    const { predictionId } = await params
    const storagePath = _request.nextUrl.searchParams.get('storagePath') ?? ''

    const prediction = await replicate.predictions.get(predictionId)

    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      return Response.json({
        status: 'error',
        error: `bread failed: ${prediction.error ?? prediction.status}`,
      })
    }

    if (prediction.status !== 'succeeded') {
      return Response.json({ status: prediction.status }) // starting | processing
    }

    // Succeeded — salva resultado no bucket
    const outputUrl = Array.isArray(prediction.output)
      ? prediction.output[0]
      : prediction.output

    const imgRes = await fetch(outputUrl)
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer())

    await supabaseServer.storage
      .from('processed')
      .upload(storagePath, imgBuffer, { contentType: 'image/jpeg', upsert: true })

    const { data: urlData } = supabaseServer.storage
      .from('processed')
      .getPublicUrl(storagePath)

    return Response.json({
      status: 'done',
      enhancedUrl: urlData.publicUrl,
    })
  } catch (error) {
    console.error('test-lighting poll error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
