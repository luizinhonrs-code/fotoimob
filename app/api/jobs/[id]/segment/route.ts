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

// Download one mask, resize to image dims, return raw greyscale buffer
async function fetchMaskRaw(url: string, w: number, h: number): Promise<Buffer> {
  const r = await fetch(url)
  const buf = Buffer.from(await r.arrayBuffer())
  return sharp(buf)
    .resize(w, h, { fit: 'fill' })
    .greyscale()
    .raw()
    .toBuffer()
}

export async function POST(
  request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { clickX, clickY, canvasWidth, canvasHeight } = await request.json()

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

    // Image dimensions
    const imgRes = await fetch(imageUrl)
    const imgBuf = Buffer.from(await imgRes.arrayBuffer())
    const meta = await sharp(imgBuf).metadata()
    const imgW = meta.width!
    const imgH = meta.height!

    // Map canvas click → image pixel
    const px = Math.min(imgW - 1, Math.max(0, Math.round((clickX / canvasWidth) * imgW)))
    const py = Math.min(imgH - 1, Math.max(0, Math.round((clickY / canvasHeight) * imgH)))
    const clickIdx = py * imgW + px

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
      return Response.json({ error: 'SAM não retornou masks. Tente novamente.' }, { status: 422 })
    }

    // Download masks in batches of 6, stop as soon as one covers the click.
    // SAM returns masks roughly smallest→largest, so the clicked object
    // is usually found in the first 30 masks.
    const BATCH = 6
    let bestMaskBuf: Buffer | null = null
    let bestArea = Infinity

    for (let i = 0; i < maskUrls.length; i += BATCH) {
      const batch = maskUrls.slice(i, i + BATCH)
      const raws = await Promise.all(batch.map(url => fetchMaskRaw(url, imgW, imgH)))

      for (const raw of raws) {
        if (raw[clickIdx] > 128) {
          // Count pixels to pick the most specific (smallest) matching mask
          let area = 0
          for (let j = 0; j < raw.length; j++) if (raw[j] > 128) area++
          if (area < bestArea) { bestArea = area; bestMaskBuf = raw }
        }
      }

      // Stop once we have a hit and have checked one extra batch
      if (bestMaskBuf && i >= BATCH) break
    }

    // Fallback: if no mask hit the click pixel, use closest centroid
    if (!bestMaskBuf) {
      const FALLBACK_LIMIT = Math.min(maskUrls.length, 30)
      const raws = await Promise.all(
        maskUrls.slice(0, FALLBACK_LIMIT).map(url => fetchMaskRaw(url, imgW, imgH))
      )
      let bestDist = Infinity
      for (const raw of raws) {
        let sx = 0, sy = 0, count = 0
        for (let y = 0; y < imgH; y++)
          for (let x = 0; x < imgW; x++)
            if (raw[y * imgW + x] > 128) { sx += x; sy += y; count++ }
        if (count > 0) {
          const dist = Math.sqrt((sx / count - px) ** 2 + (sy / count - py) ** 2)
          if (dist < bestDist) { bestDist = dist; bestMaskBuf = raw }
        }
      }
    }

    if (!bestMaskBuf) {
      return Response.json({ error: 'Nenhum objeto encontrado. Tente clicar no centro do objeto.' }, { status: 422 })
    }

    // Resize winning mask to canvas size for overlay
    const canvasMask = await sharp(bestMaskBuf, {
      raw: { width: imgW, height: imgH, channels: 1 },
    })
      .resize(canvasWidth, canvasHeight, { fit: 'fill' })
      .threshold(128)
      .png()
      .toBuffer()

    return Response.json({
      mask: `data:image/png;base64,${canvasMask.toString('base64')}`,
    })
  } catch (err) {
    console.error('Segment error:', err)
    return Response.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
