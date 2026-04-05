'use client'

import { useState } from 'react'
import { Download, Zap } from 'lucide-react'
import { Button } from '@/components/ui/button'
import PhotoCard from './PhotoCard'
import { Job } from '@/lib/supabase'

interface PhotoGridProps {
  jobs: Job[]
  onJobsUpdate: () => void
}

export default function PhotoGrid({ jobs, onJobsUpdate }: PhotoGridProps) {
  const [processingAll, setProcessingAll] = useState(false)
  const [downloadingAll, setDownloadingAll] = useState(false)

  const pendingJobs = jobs.filter((j) => j.status === 'pending' || j.status === 'error')
  const doneJobs = jobs.filter((j) => j.status === 'done')

  const handleProcess = async (jobId: string) => {
    try {
      const response = await fetch(`/api/jobs/${jobId}/process`, {
        method: 'POST',
      })
      if (!response.ok) {
        const err = await response.json()
        console.error('Process error:', err)
      }
      onJobsUpdate()
    } catch (err) {
      console.error('Failed to start processing:', err)
    }
  }

  const handleProcessAll = async () => {
    if (pendingJobs.length === 0) return
    setProcessingAll(true)
    try {
      // Start all pending/error jobs simultaneously
      await Promise.all(
        pendingJobs.map((job) =>
          fetch(`/api/jobs/${job.id}/process`, { method: 'POST' }).catch(console.error)
        )
      )
      onJobsUpdate()
    } finally {
      setProcessingAll(false)
    }
  }

  const handleDownloadAll = async () => {
    if (doneJobs.length === 0) return
    setDownloadingAll(true)

    try {
      const JSZip = (await import('jszip')).default
      const zip = new JSZip()

      await Promise.all(
        doneJobs.map(async (job, index) => {
          const url = job.decluttered_url || job.enhanced_url
          if (!url) return
          try {
            const response = await fetch(url)
            const blob = await response.blob()
            const ext = blob.type.includes('png') ? 'png' : 'jpg'
            const name = `foto_${String(index + 1).padStart(2, '0')}.${ext}`
            zip.file(name, blob)
          } catch (err) {
            console.error(`Failed to fetch ${job.id}:`, err)
          }
        })
      )

      const content = await zip.generateAsync({ type: 'blob' })
      const url = URL.createObjectURL(content)
      const a = document.createElement('a')
      a.href = url
      a.download = `fotoimob_processadas.zip`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to zip:', err)
    } finally {
      setDownloadingAll(false)
    }
  }

  if (jobs.length === 0) {
    return null
  }

  return (
    <div className="space-y-4">
      {/* Toolbar */}
      <div className="flex items-center justify-between gap-3 flex-wrap">
        <p className="text-sm text-gray-400">
          {jobs.length} foto(s) &mdash;{' '}
          <span className="text-green-400">{doneJobs.length} pronta(s)</span>
          {pendingJobs.length > 0 && (
            <>
              {', '}
              <span className="text-gray-400">{pendingJobs.length} aguardando</span>
            </>
          )}
        </p>

        <div className="flex gap-2">
          {pendingJobs.length > 0 && (
            <Button
              size="sm"
              onClick={handleProcessAll}
              disabled={processingAll}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              <Zap className="w-3 h-3 mr-1" />
              {processingAll ? 'Iniciando...' : `Processar Todas (${pendingJobs.length})`}
            </Button>
          )}

          {doneJobs.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleDownloadAll}
              disabled={downloadingAll}
              className="border-green-700 text-green-400 hover:bg-green-900/30"
            >
              <Download className="w-3 h-3 mr-1" />
              {downloadingAll ? 'Comprimindo...' : `Baixar Todas (${doneJobs.length})`}
            </Button>
          )}
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {jobs.map((job) => (
          <PhotoCard key={job.id} job={job} onProcess={handleProcess} />
        ))}
      </div>
    </div>
  )
}
