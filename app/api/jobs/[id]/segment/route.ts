import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate } from '@/lib/replicate'
import sharp from 'sharp'

export const runtime = 'nodejs'
export const maxDuration = 60

// Broad detection prompt to find anything the user might click on
const DETECT_PROMPT =
  'object . furniture . electronic . bag . clothing . bottle . cup . bowl . box . cable . remote control . book . toy . trash . basket . chair . table . lamp . plant . pillow . rug . shoe . clutter'

async function pollUntilDone(predictionId: string, maxMs = 50000) {
  const start = Date.now()
  while (Date.now() - start < maxMs) {
    const p = await replicate.predictions.get(predictionId)
    if (p.status === 'succeeded') return p
    if (p.status === 'failed' || p.status === 'canceled') {
      throw new Error(`Detection ${p.status}: ${p.error ?? 'unknown error'}`)
    }
    await new Promise(r => setTimeout(r, 1500))
  }
  throw new Error('Detection timed out')
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

    // Image dimensions
    const imgRes = await fetch(imageUrl)
    const imgBuf = Buffer.from(await imgRes.arrayBuffer())
    const meta = await sharp(imgBuf).metadata()
    const imgWidth = meta.width!
    const imgHeight = meta.height!

    // Map canvas click → image pixel coords
    const px = (clickX / canvasWidth) * imgWidth
    const py = (clickY / canvasHeight) * imgHeight

    // Run Grounding DINO
    const dinoModel = await replicate.models.get('adirik', 'grounding-dino')
    const dinoVersion = dinoModel.latest_version?.id
    if (!dinoVersion) throw new Error('Could not get DINO model version')

    const dinoPred = await replicate.predictions.create({
      version: dinoVersion,
      input: {
        image: imageUrl,
        prompt: DETECT_PROMPT,
        box_threshold: 0.25,
        text_threshold: 0.25,
      },
    })

    const dinoResult = await pollUntilDone(dinoPred.id)
    type Detection = { bbox: number[]; confidence: number; label: string }
    const detections: Detection[] =
      (dinoResult.output as { detections?: Detection[] })?.detections ?? []

    if (detections.length === 0) {
      return Response.json(
        { error: 'Nenhum objeto detectado neste ponto. Use o modo Pincel para marcar manualmente.' },
        { status: 422 }
      )
    }

    // Find smallest bbox that contains the click point
    let best: Detection | null = null
    let bestScore = Infinity

    for (const det of detections) {
      const [x1, y1, x2, y2] = det.bbox
      if (px >= x1 && px <= x2 && py >= y1 && py <= y2) {
        const area = (x2 - x1) * (y2 - y1)
        if (area < bestScore) { bestScore = area; best = det }
      }
    }

    // Fallback: closest detection center to click point
    if (!best) {
      bestScore = Infinity
      for (const det of detections) {
        const [x1, y1, x2, y2] = det.bbox
        const dist = Math.sqrt(((x1 + x2) / 2 - px) ** 2 + ((y1 + y2) / 2 - py) ** 2)
        if (dist < bestScore) { bestScore = dist; best = det }
      }
    }

    if (!best) {
      return Response.json({ error: 'Nenhum objeto encontrado.' }, { status: 422 })
    }

    // Build binary mask at image resolution
    const [x1, y1, x2, y2] = best.bbox
    const bx = Math.max(0, Math.round(x1))
    const by = Math.max(0, Math.round(y1))
    const bw = Math.max(1, Math.round(x2 - x1))
    const bh = Math.max(1, Math.round(y2 - y1))

    const svgMask = `<svg width="${imgWidth}" height="${imgHeight}">` +
      `<rect x="${bx}" y="${by}" width="${bw}" height="${bh}" fill="white"/></svg>`

    const maskFull = await sharp({
      create: { width: imgWidth, height: imgHeight, channels: 3, background: { r: 0, g: 0, b: 0 } },
    })
      .composite([{ input: Buffer.from(svgMask), top: 0, left: 0 }])
      .png()
      .toBuffer()

    // Resize to canvas dimensions for display overlay
    const maskCanvas = await sharp(maskFull)
      .resize(canvasWidth, canvasHeight, { fit: 'fill' })
      .png()
      .toBuffer()

    return Response.json({
      mask: `data:image/png;base64,${maskCanvas.toString('base64')}`,
      label: best.label,
    })
  } catch (err) {
    console.error('Segment error:', err)
    return Response.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
