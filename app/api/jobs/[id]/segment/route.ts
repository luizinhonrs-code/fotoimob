import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate } from '@/lib/replicate'
import sharp from 'sharp'

export const runtime = 'nodejs'
export const maxDuration = 60

// Broad prompt — avoid reserved words like "object", avoid multi-word phrases
const SAM_PROMPT = 'bag . bottle . cup . clothing . shoe . toy . trash . box . cable . book . chair . lamp . table . sofa . rug . pillow . plant . basket . keyboard . mouse . phone . remote'

async function pollUntilDone(predictionId: string, maxMs = 55000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const p = await replicate.predictions.get(predictionId)
    if (p.status === 'succeeded') return p
    if (p.status === 'failed' || p.status === 'canceled') {
      throw new Error(`Segmentation ${p.status}: ${p.error ?? 'unknown error'}`)
    }
    await new Promise(r => setTimeout(r, 1500))
  }
  throw new Error('Segmentation timed out')
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

    // Source image URL
    let imageUrl: string
    if (job.decluttered_url) {
      imageUrl = job.decluttered_url
    } else {
      const { data: sd } = await supabaseServer.storage
        .from('originals').createSignedUrl(job.original_filename, 3600)
      if (!sd?.signedUrl) return Response.json({ error: 'Failed to get image URL' }, { status: 500 })
      imageUrl = sd.signedUrl
    }

    // Get image dimensions to map click → image pixel coords
    const imgRes = await fetch(imageUrl)
    const imgBuf = Buffer.from(await imgRes.arrayBuffer())
    const meta = await sharp(imgBuf).metadata()
    const imgWidth = meta.width!
    const imgHeight = meta.height!

    const pixelX = Math.round((clickX / canvasWidth) * imgWidth)
    const pixelY = Math.round((clickY / canvasHeight) * imgHeight)

    // Run grounded_sam — returns one PNG mask per detected object
    const samModel = await replicate.models.get('schananas', 'grounded_sam')
    const samVersion = samModel.latest_version?.id
    if (!samVersion) throw new Error('Could not get grounded_sam model version')

    const pred = await replicate.predictions.create({
      version: samVersion,
      input: {
        image: imageUrl,
        mask_prompt: SAM_PROMPT,
      },
    })

    const result = await pollUntilDone(pred.id)

    const maskUrls: string[] = Array.isArray(result.output) ? result.output : []
    if (maskUrls.length === 0) {
      return Response.json(
        { error: 'Nenhum objeto detectado. Use o modo Pincel para marcar manualmente.' },
        { status: 422 }
      )
    }

    // Download all masks, find which one covers the click point
    const masks = await Promise.all(
      maskUrls.map(async (url) => {
        const r = await fetch(url)
        const buf = Buffer.from(await r.arrayBuffer())
        // Resize to image dimensions for pixel lookup
        const resized = await sharp(buf)
          .resize(imgWidth, imgHeight, { fit: 'fill' })
          .greyscale()
          .raw()
          .toBuffer()
        return { buf, resized }
      })
    )

    // Find the mask where the click pixel is white (object pixel)
    const bytesPerPixel = 1 // greyscale raw
    const clickIdx = (pixelY * imgWidth + pixelX) * bytesPerPixel
    let bestMaskBuf: Buffer | null = null

    for (const { buf, resized } of masks) {
      if (resized[clickIdx] > 128) {
        bestMaskBuf = buf
        break
      }
    }

    // Fallback: pick the mask whose centroid is closest to the click
    if (!bestMaskBuf) {
      let bestDist = Infinity
      for (const { buf, resized } of masks) {
        let sumX = 0, sumY = 0, count = 0
        for (let y = 0; y < imgHeight; y++) {
          for (let x = 0; x < imgWidth; x++) {
            if (resized[y * imgWidth + x] > 128) {
              sumX += x; sumY += y; count++
            }
          }
        }
        if (count > 0) {
          const dist = Math.sqrt((sumX / count - pixelX) ** 2 + (sumY / count - pixelY) ** 2)
          if (dist < bestDist) { bestDist = dist; bestMaskBuf = buf }
        }
      }
    }

    if (!bestMaskBuf) {
      return Response.json({ error: 'Não foi possível identificar o objeto.' }, { status: 422 })
    }

    // Resize winning mask to canvas dimensions for overlay
    const canvasMask = await sharp(bestMaskBuf)
      .resize(canvasWidth, canvasHeight, { fit: 'fill' })
      .greyscale()
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
