import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate } from '@/lib/replicate'
import sharp from 'sharp'

export const runtime = 'nodejs'
export const maxDuration = 60

async function pollUntilDone(predictionId: string, maxMs = 55000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const p = await replicate.predictions.get(predictionId)
    if (p.status === 'succeeded') return p
    if (p.status === 'failed' || p.status === 'canceled') {
      throw new Error(`SAM ${p.status}: ${p.error ?? 'unknown'}`)
    }
    await new Promise(r => setTimeout(r, 1500))
  }
  throw new Error('SAM timed out')
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { canvasWidth, canvasHeight } = await request.json()

    const { data: job, error } = await supabaseServer
      .from('jobs').select('*').eq('id', id).single()
    if (error || !job) return Response.json({ error: 'Job not found' }, { status: 404 })

    let imageUrl: string
    if (job.decluttered_url) {
      imageUrl = job.decluttered_url
    } else {
      const { data: sd } = await supabaseServer.storage
        .from('originals').createSignedUrl(job.original_filename, 3600)
      if (!sd?.signedUrl) return Response.json({ error: 'Failed to get image URL' }, { status: 500 })
      imageUrl = sd.signedUrl
    }

    // Run SAM-2
    const samModel = await replicate.models.get('meta', 'sam-2')
    const samVersion = samModel.latest_version?.id
    if (!samVersion) throw new Error('Could not get sam-2 version')

    const pred = await replicate.predictions.create({
      version: samVersion,
      input: {
        image: imageUrl,
        points_per_side: 32,
        pred_iou_thresh: 0.80,
        stability_score_thresh: 0.85,
        use_m2m: true,
      },
    })

    const result = await pollUntilDone(pred.id)
    const output = result.output as { individual_masks?: string[] }
    const maskUrls: string[] = output?.individual_masks ?? []

    if (maskUrls.length === 0) {
      return Response.json({ error: 'SAM não retornou masks.' }, { status: 422 })
    }

    // Process up to 50 masks in parallel batches
    const LIMIT = Math.min(maskUrls.length, 50)
    const BATCH = 8
    const results: Array<{ index: number; area: number; cx: number; cy: number; storedPath: string; canvasB64: string } | null> = []

    for (let i = 0; i < LIMIT; i += BATCH) {
      const batch = maskUrls.slice(i, i + BATCH).map((url, j) => ({ url, index: i + j }))
      const batchResults = await Promise.all(batch.map(async ({ url, index }) => {
        try {
          // Download the PNG from Replicate
          const res = await fetch(url)
          const pngBuf = Buffer.from(await res.arrayBuffer())

          // Upload original full-res mask to Supabase (for inpaint use)
          const storedPath = `${id}_sam_${index}.png`
          await supabaseServer.storage.from('processed').upload(storedPath, pngBuf, {
            contentType: 'image/png',
            upsert: true,
          })

          // Canvas-size version: resize, compute stats, get pixels
          const { data: rawPixels } = await sharp(pngBuf)
            .resize(canvasWidth, canvasHeight, { fit: 'fill' })
            .greyscale()
            .raw()
            .toBuffer({ resolveWithObject: true })

          // Compute area and centroid at canvas resolution
          let area = 0, sx = 0, sy = 0
          for (let y = 0; y < canvasHeight; y++) {
            for (let x = 0; x < canvasWidth; x++) {
              if (rawPixels[y * canvasWidth + x] > 128) { area++; sx += x; sy += y }
            }
          }

          if (area === 0) return null

          // Canvas PNG as base64 for browser display
          const canvasPng = await sharp(rawPixels, { raw: { width: canvasWidth, height: canvasHeight, channels: 1 } })
            .threshold(128)
            .png()
            .toBuffer()

          return {
            index,
            area,
            cx: Math.round(sx / area),
            cy: Math.round(sy / area),
            storedPath,
            canvasB64: canvasPng.toString('base64'),
          }
        } catch {
          return null
        }
      }))
      results.push(...batchResults)
    }

    const masks = results.filter((m): m is NonNullable<typeof m> => m !== null)

    return Response.json({ masks })
  } catch (err) {
    console.error('Segment-all error:', err)
    return Response.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
