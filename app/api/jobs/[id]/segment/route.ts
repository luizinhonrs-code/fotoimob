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

    // Download first N masks. SAM returns smallest→largest so objects appear early.
    const BATCH = 6
    const SCAN_LIMIT = Math.min(maskUrls.length, 48)
    const allRaws: Buffer[] = []

    for (let i = 0; i < SCAN_LIMIT; i += BATCH) {
      const batch = maskUrls.slice(i, i + BATCH)
      const raws = await Promise.all(batch.map(url => fetchMaskRaw(url, imgW, imgH)))
      allRaws.push(...raws)
    }

    // Compute area + centroid for every mask in one pass
    interface MaskInfo { raw: Buffer; area: number; cx: number; cy: number }
    const infos: MaskInfo[] = allRaws.map(raw => {
      let area = 0, sx = 0, sy = 0
      for (let y = 0; y < imgH; y++)
        for (let x = 0; x < imgW; x++)
          if (raw[y * imgW + x] > 128) { area++; sx += x; sy += y }
      return { raw, area, cx: area > 0 ? sx / area : 0, cy: area > 0 ? sy / area : 0 }
    })

    // Primary: smallest mask that covers the click pixel
    let primary: MaskInfo | null = null
    for (const m of infos) {
      if (m.raw[clickIdx] > 128 && m.area > 0) {
        if (!primary || m.area < primary.area) primary = m
      }
    }

    // Fallback: closest centroid to click (if no mask covered the pixel exactly)
    if (!primary) {
      let bestDist = Infinity
      for (const m of infos) {
        if (m.area === 0) continue
        const dist = Math.hypot(m.cx - px, m.cy - py)
        if (dist < bestDist) { bestDist = dist; primary = m }
      }
    }

    if (!primary) {
      return Response.json({ error: 'Nenhum objeto encontrado. Tente clicar no centro do objeto.' }, { status: 422 })
    }

    // Merge adjacent sub-parts: SAM often splits one object into several small masks.
    // Merge all masks whose centroid is within 2× the object's estimated radius from
    // the click point, provided they're not huge (e.g., the whole wall or floor).
    const objRadius = Math.sqrt(primary.area / Math.PI) * 2
    const maxMergeArea = primary.area * 10 // don't swallow objects far larger than primary
    const merged = Buffer.from(primary.raw)  // start with primary, union others into it

    for (const m of infos) {
      if (m === primary || m.area === 0 || m.area > maxMergeArea) continue
      const dist = Math.hypot(m.cx - px, m.cy - py)
      if (dist <= objRadius) {
        for (let j = 0; j < merged.length; j++) {
          if (m.raw[j] > 128) merged[j] = 255
        }
      }
    }

    // Upload full-resolution mask to Supabase so inpaint can use it directly
    // (bypasses lossy canvas round-trip that collapses thin objects)
    const fullResMask = await sharp(merged, {
      raw: { width: imgW, height: imgH, channels: 1 },
    })
      .threshold(128)
      .png()
      .toBuffer()

    const maskStoredPath = `${id}_click_mask.png`
    await supabaseServer.storage.from('processed').upload(maskStoredPath, fullResMask, {
      contentType: 'image/png',
      upsert: true,
    })
    const { data: maskUrlData } = supabaseServer.storage.from('processed').getPublicUrl(maskStoredPath)
    const maskPublicUrl = maskUrlData.publicUrl

    // Resize to canvas size only for the browser overlay display
    const canvasMask = await sharp(merged, {
      raw: { width: imgW, height: imgH, channels: 1 },
    })
      .resize(canvasWidth, canvasHeight, { fit: 'fill' })
      .threshold(128)
      .png()
      .toBuffer()

    return Response.json({
      mask: `data:image/png;base64,${canvasMask.toString('base64')}`,
      maskPublicUrl,
    })
  } catch (err) {
    console.error('Segment error:', err)
    return Response.json(
      { error: err instanceof Error ? err.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
