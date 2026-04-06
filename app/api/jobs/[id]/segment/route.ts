import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { replicate } from '@/lib/replicate'
import sharp from 'sharp'

export const runtime = 'nodejs'
export const maxDuration = 60

async function pollUntilDone(predictionId: string, maxMs = 50000) {
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
      .from('jobs')
      .select('*')
      .eq('id', id)
      .single()
    if (error || !job) return Response.json({ error: 'Job not found' }, { status: 404 })

    // Source image URL
    let imageUrl: string
    if (job.decluttered_url) {
      imageUrl = job.decluttered_url
    } else {
      const { data: sd } = await supabaseServer.storage
        .from('originals')
        .createSignedUrl(job.original_filename, 3600)
      if (!sd?.signedUrl) return Response.json({ error: 'Failed to get image URL' }, { status: 500 })
      imageUrl = sd.signedUrl
    }

    // Get actual image dimensions
    const imgResponse = await fetch(imageUrl)
    const imgBuffer = Buffer.from(await imgResponse.arrayBuffer())
    const meta = await sharp(imgBuffer).metadata()
    const imgWidth = meta.width!
    const imgHeight = meta.height!

    // Map canvas click → image pixel coordinates
    const pixelX = Math.round((clickX / canvasWidth) * imgWidth)
    const pixelY = Math.round((clickY / canvasHeight) * imgHeight)

    // Run SAM 2 (meta/sam-2-video supports click-point segmentation on images)
    const samModel = await replicate.models.get('meta', 'sam-2-video')
    const samVersion = samModel.latest_version?.id
    if (!samVersion) throw new Error('Could not get sam-2-video model version')

    const prediction = await replicate.predictions.create({
      version: samVersion,
      input: {
        input_video: imageUrl,
        click_coordinates: `[${pixelX},${pixelY}]`,
        click_labels: '1',
        click_frames: '0',
        mask_type: 'binary',
        output_video: false,
        output_format: 'png',
      },
    })

    const result = await pollUntilDone(prediction.id)

    // Output is array of mask URIs (one per detected object)
    let maskUrl: string
    if (Array.isArray(result.output) && result.output.length > 0) {
      maskUrl = result.output[0]
    } else if (typeof result.output === 'string') {
      maskUrl = result.output
    } else {
      throw new Error('No mask returned from segmentation model')
    }

    // Fetch mask, resize to canvas dimensions, return base64
    const maskResponse = await fetch(maskUrl)
    const maskRaw = Buffer.from(await maskResponse.arrayBuffer())

    // Convert mask to strict black/white then resize to canvas size
    const maskResized = await sharp(maskRaw)
      .resize(canvasWidth, canvasHeight, { fit: 'fill' })
      .greyscale()
      .threshold(128)
      .png()
      .toBuffer()

    return Response.json({
      mask: `data:image/png;base64,${maskResized.toString('base64')}`,
    })
  } catch (error) {
    console.error('Segment error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
