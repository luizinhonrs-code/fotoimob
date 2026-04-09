import { NextRequest } from 'next/server'
import { replicate } from '@/lib/replicate'
import { supabaseServer } from '@/lib/supabase'

export const runtime = 'nodejs'
export const maxDuration = 30

const BREAD_VERSION = 'bf9f60e777852145e9e6c06fac109c6d55fec43bd535b6b13d3608c34711060b'

const ROOM_LABELS: Record<string, string> = {
  'living room interior with sofa couch and television':         'Sala de estar',
  'bedroom interior with bed mattress and pillows':             'Quarto',
  'kitchen interior with stove oven refrigerator and cabinets': 'Cozinha',
  'bathroom interior with toilet sink shower or bathtub':       'Banheiro',
  'open balcony terrace with railing outdoors':                 'Varanda',
  'building exterior facade front view street':                 'Fachada',
  'garage parking area with car or gate':                       'Garagem',
  'laundry service room with washing machine':                  'Área de serviço',
  'narrow corridor hallway entrance hall interior':             'Corredor',
  'home office study room with desk computer':                  'Escritório',
  'dining room with dining table and chairs':                   'Sala de jantar',
  'swimming pool outdoor area':                                 'Piscina',
}

const EXTERIOR_LABELS = new Set([
  'open balcony terrace with railing outdoors',
  'building exterior facade front view street',
  'garage parking area with car or gate',
  'swimming pool outdoor area',
])

const LABEL_KEYS = Object.keys(ROOM_LABELS)

export async function GET(
  request: NextRequest,
  { params }: { params: Promise<{ predictionId: string }> }
) {
  try {
    const { predictionId } = await params
    const sp = request.nextUrl.searchParams
    const phase = sp.get('phase') ?? 'clip'
    const originalUrl = sp.get('originalUrl') ?? ''
    const enhancedPath = sp.get('enhancedPath') ?? ''
    const gamma = parseFloat(sp.get('gamma') ?? '0.9')
    const strength = parseFloat(sp.get('strength') ?? '0.02')

    const prediction = await replicate.predictions.get(predictionId)

    // ── Fase CLIP ─────────────────────────────────────────────────────────────
    if (phase === 'clip') {
      if (prediction.status === 'failed' || prediction.status === 'canceled') {
        return Response.json({ phase: 'clip', status: 'error', error: 'CLIP failed' })
      }
      if (prediction.status !== 'succeeded') {
        return Response.json({ phase: 'clip', status: prediction.status })
      }

      // CLIP concluiu — interpreta scores
      const scores = prediction.output as number[]
      const maxIdx = scores.reduce((best, s, i) => (s > scores[best] ? i : best), 0)
      const labelEn = LABEL_KEYS[maxIdx]
      const room = {
        label: ROOM_LABELS[labelEn],
        labelEn,
        confidence: Math.round(scores[maxIdx] * 100),
        isExterior: EXTERIOR_LABELS.has(labelEn),
      }

      // Exterior ou foto já clara → não precisa de bread
      if (room.isExterior || gamma === 0) {
        return Response.json({
          phase: 'done',
          status: 'skipped',
          room,
          message: room.isExterior
            ? `Exterior (${room.label}) — bread não aplicado`
            : `Bem iluminado — bread não aplicado`,
        })
      }

      // Interior escuro → dispara bread
      const breadPrediction = await replicate.predictions.create({
        version: BREAD_VERSION,
        input: { image: originalUrl, gamma, strength },
      })

      return Response.json({
        phase: 'bread',
        status: 'processing',
        breadId: breadPrediction.id,
        room,
      })
    }

    // ── Fase BREAD ────────────────────────────────────────────────────────────
    if (phase === 'bread') {
      if (prediction.status === 'failed' || prediction.status === 'canceled') {
        return Response.json({ phase: 'bread', status: 'error', error: `bread: ${prediction.error ?? 'failed'}` })
      }
      if (prediction.status !== 'succeeded') {
        return Response.json({ phase: 'bread', status: prediction.status })
      }

      const outputUrl = Array.isArray(prediction.output)
        ? prediction.output[0]
        : (prediction.output as string)

      const imgRes = await fetch(outputUrl)
      const imgBuffer = Buffer.from(await imgRes.arrayBuffer())

      await supabaseServer.storage
        .from('processed')
        .upload(enhancedPath, imgBuffer, { contentType: 'image/jpeg', upsert: true })

      const { data: enhUrlData } = supabaseServer.storage.from('processed').getPublicUrl(enhancedPath)

      return Response.json({
        phase: 'done',
        status: 'done',
        enhancedUrl: enhUrlData.publicUrl,
      })
    }

    return Response.json({ error: 'Invalid phase' }, { status: 400 })
  } catch (error) {
    console.error('test-lighting poll error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
