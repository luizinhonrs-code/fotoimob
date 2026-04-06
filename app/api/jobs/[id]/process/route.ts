import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate } from '@/lib/replicate'
import sharp from 'sharp'

export const runtime = 'nodejs'
export const maxDuration = 60

const CLUTTER_PROMPT = 'bottle . bag . handbag . cup . dish . bowl . cosmetics . toiletries . personal care product . clothing . shoe . sock . toy . trash . clutter . laundry . towel on floor'

// LaMa inpainting - version fetched dynamically

async function pollPredictionSync(predictionId: string, maxWaitMs = 45000): Promise<any> {
  const start = Date.now()
  while (Date.now() - start < maxWaitMs) {
    const prediction = await replicate.predictions.get(predictionId)
    if (prediction.status === 'succeeded') return prediction
    if (prediction.status === 'failed' || prediction.status === 'canceled') {
      throw new Error(`Prediction ${predictionId} failed: ${prediction.error}`)
    }
    await new Promise(r => setTimeout(r, 2000))
  }
  throw new Error('Prediction timed out')
}

async function createMaskFromBoxes(
  imageUrl: string,
  boxes: number[][], // PIXEL coordinates [[x1, y1, x2, y2], ...]
  padding = 20 // extra pixels around each box for better coverage
): Promise<Buffer> {
  // Get image dimensions
  const response = await fetch(imageUrl)
  const arrayBuffer = await response.arrayBuffer()
  const imageBuffer = Buffer.from(arrayBuffer)
  const metadata = await sharp(imageBuffer).metadata()
  const width = metadata.width || 1024
  const height = metadata.height || 768

  // Create SVG with white rectangles for each detected box (pixel coords directly)
  const rectSvgs = boxes.map(([x1, y1, x2, y2]) => {
    const px1 = Math.max(0, x1 - padding)
    const py1 = Math.max(0, y1 - padding)
    const px2 = Math.min(width, x2 + padding)
    const py2 = Math.min(height, y2 + padding)
    const w = px2 - px1
    const h = py2 - py1
    return `<rect x="${px1}" y="${py1}" width="${w}" height="${h}" fill="white" rx="4" ry="4"/>`
  }).join('\n')

  const svg = `<svg width="${width}" height="${height}" xmlns="http://www.w3.org/2000/svg">
    <rect width="100%" height="100%" fill="black"/>
    ${rectSvgs}
  </svg>`

  return sharp(Buffer.from(svg))
    .png()
    .toBuffer()
}

export async function POST(
  _request: NextRequest,
  { params }: { params: Promise<{ id: string }> }
) {
  const { id } = await params
  try {
    const { data: job, error } = await supabaseServer
      .from('jobs')
      .select('*')
      .eq('id', id)
      .single()

    if (error || !job) {
      return Response.json({ error: 'Job not found' }, { status: 404 })
    }

    if (job.status !== 'pending' && job.status !== 'error') {
      return Response.json({ error: `Job is already ${job.status}` }, { status: 400 })
    }

    // Get signed URL for original image
    const { data: signedUrlData, error: signedUrlError } = await supabaseServer.storage
      .from('originals')
      .createSignedUrl(job.original_filename, 3600)

    if (signedUrlError || !signedUrlData?.signedUrl) {
      return Response.json({ error: 'Failed to get signed URL' }, { status: 500 })
    }

    const originalSignedUrl = signedUrlData.signedUrl

    // Update status to 'enhancing' (detecting stage)
    await supabaseServer.from('jobs').update({
      status: 'enhancing',
      updated_at: new Date().toISOString(),
    }).eq('id', id)

    // Step 1: Run Grounding DINO synchronously (it's fast ~2-5s)
    const dinoModel = await replicate.models.get('adirik', 'grounding-dino')
    const dinoVersion = dinoModel.latest_version?.id
    if (!dinoVersion) throw new Error('Could not get grounding-dino version')

    const dinoPrediction = await replicate.predictions.create({
      version: dinoVersion,
      input: {
        image: originalSignedUrl,
        query: CLUTTER_PROMPT,
        box_threshold: 0.3,
        text_threshold: 0.25,
      },
    })

    await supabaseServer.from('jobs').update({
      replicate_id_enhance: dinoPrediction.id,
      updated_at: new Date().toISOString(),
    }).eq('id', id)

    // Poll until Grounding DINO finishes (max 45s - it's usually 2-5s)
    const dinoResult = await pollPredictionSync(dinoPrediction.id, 45000)

    // Parse bounding boxes from DINO output
    // Format: { detections: [{ bbox: [x1, y1, x2, y2], confidence, label }] }
    // Coordinates are in PIXELS (not normalized)
    let boxes: number[][] = []
    const dinoOutput = dinoResult.output as { detections?: Array<{ bbox: number[], confidence: number, label: string }> }

    if (dinoOutput?.detections && Array.isArray(dinoOutput.detections)) {
      boxes = dinoOutput.detections.map(d => d.bbox)
    }

    console.log(`DINO found ${boxes.length} objects to remove`)

    if (boxes.length === 0) {
      // No clutter detected - use original as final
      const origResponse = await fetch(originalSignedUrl)
      const origBuffer = Buffer.from(await origResponse.arrayBuffer())
      const ext = job.original_filename.split('.').pop() || 'jpg'

      await supabaseServer.storage.from('processed').upload(
        `${id}_final.${ext}`, origBuffer, { contentType: 'image/jpeg', upsert: true }
      )
      const { data: finalUrlData } = supabaseServer.storage.from('processed').getPublicUrl(`${id}_final.${ext}`)

      await supabaseServer.from('jobs').update({
        decluttered_url: finalUrlData.publicUrl,
        status: 'done',
        updated_at: new Date().toISOString(),
      }).eq('id', id)

      return Response.json({ message: 'No clutter detected', jobId: id })
    }

    // Step 2: Create binary mask from bounding boxes
    const maskBuffer = await createMaskFromBoxes(originalSignedUrl, boxes)

    // Upload mask to Supabase
    const maskPath = `${id}_mask.png`
    await supabaseServer.storage.from('processed').upload(maskPath, maskBuffer, {
      contentType: 'image/png',
      upsert: true,
    })
    const { data: maskUrlData } = supabaseServer.storage.from('processed').getPublicUrl(maskPath)
    const maskPublicUrl = maskUrlData.publicUrl

    // Step 3: Start LaMa inpainting — fetch latest version dynamically
    const { data: freshSignedUrl } = await supabaseServer.storage
      .from('originals')
      .createSignedUrl(job.original_filename, 3600)

    const lamaModel = await replicate.models.get('zylim0702', 'remove-object')
    const lamaVersion = lamaModel.latest_version?.id
    if (!lamaVersion) throw new Error('Could not get latest version of zylim0702/remove-object')

    const lamaPrediction = await replicate.predictions.create({
      version: lamaVersion,
      input: {
        image: freshSignedUrl?.signedUrl || originalSignedUrl,
        mask: maskPublicUrl,
      },
    })

    await supabaseServer.from('jobs').update({
      status: 'decluttering',
      replicate_id_inpaint: lamaPrediction.id,
      updated_at: new Date().toISOString(),
    }).eq('id', id)

    return Response.json({ message: 'Processing started', jobId: id, boxesFound: boxes.length })
  } catch (error) {
    console.error('Failed to start processing:', error)
    await supabaseServer.from('jobs').update({
      status: 'error',
      error_message: error instanceof Error ? error.message : 'Unknown error',
      updated_at: new Date().toISOString(),
    }).eq('id', id)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
