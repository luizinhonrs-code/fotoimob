import { NextRequest } from 'next/server'
import { replicate } from '@/lib/replicate'
import { supabaseServer } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 30

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ predictionId: string }> }
) {
  try {
    const { predictionId } = await params
    const { searchParams } = new URL(request.url)
    const resultPath = searchParams.get('resultPath') ?? ''

    const prediction = await replicate.predictions.get(predictionId)

    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      return Response.json({ status: 'error', error: prediction.error ?? 'Falhou' })
    }

    if (prediction.status !== 'succeeded') {
      return Response.json({ status: prediction.status })
    }

    // Sucesso — salva resultado no bucket
    const outputUrl = Array.isArray(prediction.output)
      ? prediction.output[0]
      : (prediction.output as string)

    const imgRes = await fetch(outputUrl)
    const imgBuffer = Buffer.from(await imgRes.arrayBuffer())

    await supabaseServer.storage
      .from('processed')
      .upload(resultPath, imgBuffer, { contentType: 'image/jpeg', upsert: true })

    const { data: resultUrlData } = supabaseServer.storage
      .from('processed')
      .getPublicUrl(resultPath)

    return Response.json({
      status: 'done',
      resultUrl: resultUrlData.publicUrl,
    })
  } catch (error) {
    console.error('test-flux GET error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
