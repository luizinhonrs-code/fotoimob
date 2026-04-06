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

    let imageUrl: string
    if (job.decluttered_url) {
      imageUrl = job.decluttered_url
    } else {
      const { data: sd } = await supabaseServer.storage
        .from('originals').createSignedUrl(job.original_filename, 3600)
      if (!sd?.signedUrl) return Response.json({ error: 'Failed to get image URL' }, { status: 500 })
      imageUrl = sd.signedUrl
    }

    // Get image dimensions
    const imgRes = await fetch(imageUrl)
    const imgBuf = Buffer.from(await imgRes.arrayBuffer())
    const meta = await sharp(imgBuf).metadata()
    const imgWidth = meta.width!
    const imgHeight = meta.height!

    // Map canvas click → image pixel coords
    const pixelX = Math.min(imgWidth - 1, Math.max(0, Math.round((clickX / canvasWidth) * imgWidth)))
    const pixelY = Math.min(imgHeight - 1, Math.max(0, Math.round((clickY / canvasHeight) * imgHeight)))

    // Run meta/sam-2 — automatic segmentation, returns combined_mask
    const samModel = await replicate.models.get('meta', 'sam-2')
    const samVersion = samModel.latest_version?.id
    if (!samVersion) throw new Error('Could not get sam-2 model version')

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

    const output = result.output as { combined_mask?: string; individual_masks?: string[] }
    const combinedMaskUrl = output?.combined_mask
    if (!combinedMaskUrl) throw new Error('No combined mask returned from SAM')

    // Download combined_mask — each object has a unique color, background = black
    const cmRes = await fetch(combinedMaskUrl)
    const cmBuf = Buffer.from(await cmRes.arrayBuffer())

    // Resize to image dimensions and get raw pixel data
    const { data: rawData, info } = await sharp(cmBuf)
      .resize(imgWidth, imgHeight, { fit: 'fill' })
      .removeAlpha()
      .raw()
      .toBuffer({ resolveWithObject: true })

    const ch = info.channels // 3 (RGB)

    // Find the segment color at click point.
    // SAM has 1-2px black borders between segments — search in a spiral
    // radius up to 8px to find the nearest non-black pixel.
    let cr = 0, cg = 0, cb = 0
    let found = false
    outer: for (let radius = 0; radius <= 8; radius++) {
      for (let dy = -radius; dy <= radius; dy++) {
        for (let dx = -radius; dx <= radius; dx++) {
          if (Math.abs(dx) !== radius && Math.abs(dy) !== radius) continue
          const nx = Math.min(imgWidth - 1, Math.max(0, pixelX + dx))
          const ny = Math.min(imgHeight - 1, Math.max(0, pixelY + dy))
          const pi = (ny * imgWidth + nx) * ch
          const r = rawData[pi], g = rawData[pi + 1], b = rawData[pi + 2]
          if (r > 20 || g > 20 || b > 20) { // non-black = a segment
            cr = r; cg = g; cb = b; found = true; break outer
          }
        }
      }
    }

    if (!found) {
      return Response.json(
        { error: 'Nenhum objeto detectado nesse ponto. Tente clicar no centro do objeto.' },
        { status: 422 }
      )
    }

    // Tight tolerance — SAM segment colors are unique, no need for > 12
    const colorTolerance = 12
    const binaryData = Buffer.alloc(imgWidth * imgHeight)
    let whiteCount = 0
    for (let i = 0; i < imgWidth * imgHeight; i++) {
      const pi = i * ch
      const dr = rawData[pi] - cr
      const dg = rawData[pi + 1] - cg
      const db = rawData[pi + 2] - cb
      if (Math.sqrt(dr * dr + dg * dg + db * db) < colorTolerance) {
        binaryData[i] = 255; whiteCount++
      } else {
        binaryData[i] = 0
      }
    }

    if (whiteCount < 50) {
      return Response.json(
        { error: 'Seleção muito pequena. Clique no centro do objeto.' },
        { status: 422 }
      )
    }

    // Convert to PNG and resize to canvas dimensions for overlay
    const maskPng = await sharp(binaryData, {
      raw: { width: imgWidth, height: imgHeight, channels: 1 },
    })
      .resize(canvasWidth, canvasHeight, { fit: 'fill' })
      .png()
      .toBuffer()

    return Response.json({
      mask: `data:image/png;base64,${maskPng.toString('base64')}`,
    })
  } catch (err) {
    console.error('Segment error:', err)
    return Response.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
