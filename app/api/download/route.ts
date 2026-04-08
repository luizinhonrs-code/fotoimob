import { NextRequest } from 'next/server'
import { supabaseServer } from '@/lib/supabase'
import { PRESETS, PresetKey } from '@/lib/presets'
import sharp from 'sharp'
import JSZip from 'jszip'

export const runtime = 'nodejs'
export const maxDuration = 60

export async function POST(request: NextRequest) {
  try {
    const { jobIds, preset } = (await request.json()) as { jobIds: string[]; preset: PresetKey }

    const presetConfig = PRESETS[preset] ?? PRESETS['sem-preset']
    const { brightness, saturation, hue, linearA, linearB } = presetConfig.sharpParams
    const applyPreset = preset !== 'sem-preset'

    const { data: jobs } = await supabaseServer
      .from('jobs')
      .select('id, original_filename, decluttered_url, ai_edited_url, original_url')
      .in('id', jobIds)

    if (!jobs || jobs.length === 0) {
      return Response.json({ error: 'No jobs found' }, { status: 404 })
    }

    const zip = new JSZip()

    await Promise.all(
      jobs.map(async (job, index) => {
        const url = (job.decluttered_url ?? job.ai_edited_url ?? job.original_url) as string | null
        if (!url) return

        try {
          const response = await fetch(url)
          if (!response.ok) return

          // Use Sharp's own fetch+pipeline to avoid Buffer generic issues
          const rawBytes = new Uint8Array(await response.arrayBuffer())

          let finalBytes: Uint8Array
          if (applyPreset) {
            const processed = await sharp(rawBytes)
              .modulate({ brightness, saturation, hue })
              .linear(linearA, linearB)
              .jpeg({ quality: 92 })
              .toBuffer({ resolveWithObject: false })
            // Sharp toBuffer returns Buffer which extends Uint8Array — safe copy
            finalBytes = new Uint8Array(processed)
          } else {
            finalBytes = rawBytes
          }

          const name = `foto_${String(index + 1).padStart(2, '0')}.jpg`
          zip.file(name, finalBytes)
        } catch (err) {
          console.error(`Failed to process job ${job.id}:`, err)
        }
      })
    )

    // generateAsync with arraybuffer avoids JSZip's Buffer<ArrayBufferLike> generics
    const zipArrayBuffer = await zip.generateAsync({ type: 'arraybuffer' }) as ArrayBuffer

    return new Response(zipArrayBuffer, {
      headers: {
        'Content-Type': 'application/zip',
        'Content-Disposition': 'attachment; filename="fotoimob_processadas.zip"',
      },
    })
  } catch (error) {
    console.error('Download error:', error)
    return Response.json(
      { error: error instanceof Error ? error.message : 'Unknown error' },
      { status: 500 }
    )
  }
}
