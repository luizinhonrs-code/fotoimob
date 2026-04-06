'use client'

import { useState } from 'react'
import Image from 'next/image'
import { Download, Play, RotateCcw, ImageIcon, Paintbrush } from 'lucide-react'
import { Card, CardContent } from '@/components/ui/card'
import { Badge } from '@/components/ui/badge'
import { Button } from '@/components/ui/button'
import { Job } from '@/lib/supabase'
import BrushEditor from './BrushEditor'

interface PhotoCardProps {
  job: Job
  onProcess: (jobId: string) => void
  onJobsUpdate: () => void
  isStarting?: boolean
}

function StatusBadge({ status }: { status: Job['status'] }) {
  switch (status) {
    case 'pending':
      return <Badge className="bg-gray-700 text-gray-300 border-0">Aguardando</Badge>
    case 'enhancing':
      return (
        <Badge className="bg-blue-500/20 text-blue-300 border border-blue-500/40 animate-pulse">
          Detectando...
        </Badge>
      )
    case 'decluttering':
      return (
        <Badge className="bg-purple-500/20 text-purple-300 border border-purple-500/40 animate-pulse">
          Removendo...
        </Badge>
      )
    case 'polishing':
      return (
        <Badge className="bg-amber-500/20 text-amber-300 border border-amber-500/40 animate-pulse">
          Melhorando...
        </Badge>
      )
    case 'done':
      return (
        <Badge className="bg-green-500/20 text-green-300 border border-green-500/40">
          Pronto!
        </Badge>
      )
    case 'error':
      return (
        <Badge className="bg-red-500/20 text-red-300 border border-red-500/40">
          Erro
        </Badge>
      )
  }
}

export default function PhotoCard({ job, onProcess, onJobsUpdate, isStarting }: PhotoCardProps) {
  const [showOriginal, setShowOriginal] = useState(false)
  const [showBrush, setShowBrush] = useState(false)

  const displayName = job.original_filename
    .replace(/^\d+_/, '')
    .replace(/_/g, ' ')

  const displayUrl =
    job.status === 'done' && !showOriginal
      ? (job.decluttered_url || job.enhanced_url || job.original_url)
      : job.original_url

  const finalUrl = job.decluttered_url || job.enhanced_url

  const isProcessing = job.status === 'enhancing' || job.status === 'decluttering' || job.status === 'polishing'

  const handleDownload = async () => {
    if (!finalUrl) return
    try {
      const response = await fetch(finalUrl)
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      const ext = blob.type.includes('png') ? 'png' : 'jpg'
      a.download = `fotoimob_${job.id}.${ext}`
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Download failed:', err)
    }
  }

  return (
    <>
      <Card className="bg-gray-900 border-gray-800 overflow-hidden group">
        {/* Thumbnail */}
        <div className="relative aspect-video bg-gray-800 overflow-hidden">
          {displayUrl ? (
            <Image
              src={displayUrl}
              alt={displayName}
              fill
              className="object-cover"
              unoptimized
            />
          ) : (
            <div className="flex items-center justify-center h-full">
              <ImageIcon className="w-8 h-8 text-gray-600" />
            </div>
          )}

          {/* Before/after toggle */}
          {job.status === 'done' && finalUrl && (
            <button
              onClick={() => setShowOriginal((prev) => !prev)}
              className="absolute bottom-2 left-2 text-xs bg-black/60 text-white px-2 py-1 rounded-md hover:bg-black/80 transition-colors"
            >
              {showOriginal ? 'Ver processada' : 'Ver original'}
            </button>
          )}

          {/* Processing spinner */}
          {isProcessing && (
            <div className="absolute inset-0 bg-black/40 flex items-center justify-center">
              <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
            </div>
          )}
        </div>

        <CardContent className="p-3 space-y-3">
          {/* Filename + status */}
          <div className="flex items-start justify-between gap-2">
            <p className="text-sm text-gray-300 truncate flex-1 font-medium" title={displayName}>
              {displayName}
            </p>
            <StatusBadge status={job.status} />
          </div>

          {/* Error message */}
          {job.status === 'error' && job.error_message && (
            <p className="text-xs text-red-400 bg-red-500/10 rounded p-2 break-words">
              {job.error_message}
            </p>
          )}

          {/* Actions */}
          <div className="flex gap-2">
            {job.status === 'pending' && (
              <Button
                size="sm"
                onClick={() => onProcess(job.id)}
                disabled={isStarting}
                className="flex-1 bg-blue-600 hover:bg-blue-700 text-white disabled:opacity-60"
              >
                {isStarting ? (
                  <>
                    <div className="w-3 h-3 mr-1 border border-white border-t-transparent rounded-full animate-spin" />
                    Iniciando...
                  </>
                ) : (
                  <>
                    <Play className="w-3 h-3 mr-1" />
                    Processar
                  </>
                )}
              </Button>
            )}

            {job.status === 'error' && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onProcess(job.id)}
                className="flex-1 border-gray-700 text-gray-300 hover:bg-gray-800"
              >
                <RotateCcw className="w-3 h-3 mr-1" />
                Tentar novamente
              </Button>
            )}

            {job.status === 'done' && finalUrl && (
              <Button
                size="sm"
                onClick={handleDownload}
                className="flex-1 bg-green-600 hover:bg-green-700 text-white"
              >
                <Download className="w-3 h-3 mr-1" />
                Baixar
              </Button>
            )}

            {/* Pincel button — available when not actively processing */}
            {!isProcessing && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => setShowBrush(true)}
                className="border-gray-700 text-gray-300 hover:bg-gray-800"
                title="Pintar para remover objetos"
              >
                <Paintbrush className="w-3 h-3" />
              </Button>
            )}
          </div>
        </CardContent>
      </Card>

      {showBrush && (
        <BrushEditor
          job={job}
          onClose={() => setShowBrush(false)}
          onDone={onJobsUpdate}
        />
      )}
    </>
  )
}
