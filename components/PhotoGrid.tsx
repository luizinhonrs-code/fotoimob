'use client'

import { useState } from 'react'
import { Download, Zap, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import PhotoCard from './PhotoCard'
import { Job } from '@/lib/supabase'
import { PRESET_LIST, PresetKey } from '@/lib/presets'
import Image from 'next/image'

interface PhotoGridProps {
  jobs: Job[]
  onJobsUpdate: () => void
  onJobDelete: (jobId: string) => void
}

export default function PhotoGrid({ jobs, onJobsUpdate, onJobDelete }: PhotoGridProps) {
  const [processingAll, setProcessingAll] = useState(false)
  const [downloadingAll, setDownloadingAll] = useState(false)
  const [processingIds, setProcessingIds] = useState<Set<string>>(new Set())
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set())
  const [activePreset, setActivePreset] = useState<PresetKey>('sem-preset')

  const pendingJobs = jobs.filter((j) => j.status === 'pending' || j.status === 'error')
  const doneJobs = jobs.filter((j) => j.status === 'done')
  const selectedPendingJobs = jobs.filter(
    (j) => selectedIds.has(j.id) && (j.status === 'pending' || j.status === 'error')
  )

  const handleProcess = async (jobId: string) => {
    setProcessingIds((prev) => new Set(prev).add(jobId))
    try {
      const response = await fetch(`/api/jobs/${jobId}/process`, { method: 'POST' })
      if (!response.ok) {
        const err = await response.json()
        console.error('Process error:', err)
        alert(`Erro ao processar: ${err.error || 'Erro desconhecido'}`)
      }
      onJobsUpdate()
    } catch (err) {
      console.error('Failed to start processing:', err)
      alert('Falha ao conectar com o servidor.')
    } finally {
      setProcessingIds((prev) => {
        const next = new Set(prev)
        next.delete(jobId)
        return next
      })
    }
  }

  const handleProcessSelected = async () => {
    if (selectedPendingJobs.length === 0) return
    setProcessingAll(true)
    try {
      await Promise.all(
        selectedPendingJobs.map((job) =>
          fetch(`/api/jobs/${job.id}/process`, { method: 'POST' }).catch(console.error)
        )
      )
      setSelectedIds(new Set())
      onJobsUpdate()
    } finally {
      setProcessingAll(false)
    }
  }

  const handleToggleSelect = (jobId: string) => {
    setSelectedIds((prev) => {
      const next = new Set(prev)
      if (next.has(jobId)) next.delete(jobId)
      else next.add(jobId)
      return next
    })
  }

  const handleSelectAllPending = () => {
    if (selectedIds.size === pendingJobs.length) {
      setSelectedIds(new Set())
    } else {
      setSelectedIds(new Set(pendingJobs.map((j) => j.id)))
    }
  }

  const handleDownloadAll = async () => {
    if (doneJobs.length === 0) return
    setDownloadingAll(true)
    try {
      const response = await fetch('/api/download', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          jobIds: doneJobs.map((j) => j.id),
          preset: activePreset,
        }),
      })
      if (!response.ok) throw new Error('Download failed')
      const blob = await response.blob()
      const url = URL.createObjectURL(blob)
      const a = document.createElement('a')
      a.href = url
      a.download = 'fotoimob_processadas.zip'
      document.body.appendChild(a)
      a.click()
      document.body.removeChild(a)
      URL.revokeObjectURL(url)
    } catch (err) {
      console.error('Failed to download:', err)
      alert('Erro ao baixar as fotos.')
    } finally {
      setDownloadingAll(false)
    }
  }

  if (jobs.length === 0) return null

  const activePresetConfig = PRESET_LIST.find((p) => p.key === activePreset)

  return (
    <div className="space-y-6">
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

        <div className="flex gap-2 flex-wrap">
          {pendingJobs.length > 0 && (
            <Button
              size="sm"
              variant="outline"
              onClick={handleSelectAllPending}
              className="border-gray-700 text-gray-300 hover:bg-gray-800"
            >
              {selectedIds.size === pendingJobs.length ? 'Desselecionar' : 'Selecionar pendentes'}
            </Button>
          )}

          {selectedPendingJobs.length > 0 && (
            <Button
              size="sm"
              onClick={handleProcessSelected}
              disabled={processingAll}
              className="bg-blue-600 hover:bg-blue-700 text-white"
            >
              <Zap className="w-3 h-3 mr-1" />
              {processingAll
                ? 'Iniciando...'
                : `Processar com IA (${selectedPendingJobs.length})`}
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
              {downloadingAll
                ? 'Preparando...'
                : `Baixar Todas (${doneJobs.length})${activePreset !== 'sem-preset' ? ` · ${activePresetConfig?.label}` : ''}`}
            </Button>
          )}
        </div>
      </div>

      {/* Preset selector */}
      <div className="space-y-2">
        <div className="flex items-center gap-2 text-xs text-gray-500">
          <SlidersHorizontal className="w-3 h-3" />
          <span>Preset de cor</span>
        </div>
        <div className="flex flex-wrap gap-2">
          {PRESET_LIST.map((preset) => (
            <button
              key={preset.key}
              onClick={() => setActivePreset(preset.key)}
              className={`px-3 py-1.5 rounded-full text-xs font-medium transition-all border
                ${activePreset === preset.key
                  ? 'bg-blue-600 border-blue-500 text-white'
                  : 'bg-gray-800 border-gray-700 text-gray-400 hover:border-gray-500 hover:text-gray-200'
                }`}
            >
              {preset.label}
            </button>
          ))}
        </div>
      </div>

      {/* Grid */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
        {jobs.map((job) => (
          <PhotoCard
            key={job.id}
            job={job}
            onProcess={handleProcess}
            onDelete={onJobDelete}
            onJobsUpdate={onJobsUpdate}
            isStarting={processingIds.has(job.id)}
            isSelected={selectedIds.has(job.id)}
            onToggleSelect={handleToggleSelect}
          />
        ))}
      </div>

      {/* Preview panel — shown when there are done jobs and a preset is active */}
      {doneJobs.length > 0 && activePreset !== 'sem-preset' && activePresetConfig && (
        <div className="space-y-3 border border-gray-800 rounded-xl p-4 bg-gray-900/50">
          <div className="flex items-center justify-between">
            <div>
              <p className="text-sm font-medium text-white">
                Preview: {activePresetConfig.label}
              </p>
              <p className="text-xs text-gray-500 mt-0.5">
                Visualização aproximada do preset — resultado final aplicado via processamento de imagem
              </p>
            </div>
            <Button
              size="sm"
              onClick={handleDownloadAll}
              disabled={downloadingAll}
              className="bg-green-600 hover:bg-green-700 text-white shrink-0"
            >
              <Download className="w-3 h-3 mr-1" />
              {downloadingAll ? 'Preparando...' : 'Baixar com preset'}
            </Button>
          </div>

          <div className="flex gap-3 overflow-x-auto pb-2">
            {doneJobs.map((job) => {
              const url = job.decluttered_url || job.ai_edited_url || job.enhanced_url || job.original_url
              if (!url) return null
              return (
                <div key={job.id} className="shrink-0 w-48 space-y-1">
                  <div className="relative aspect-video rounded-lg overflow-hidden bg-gray-800">
                    <Image
                      src={url}
                      alt={job.original_filename}
                      fill
                      className="object-cover"
                      unoptimized
                      style={{ filter: activePresetConfig.cssFilter }}
                    />
                  </div>
                  <p className="text-xs text-gray-500 truncate">
                    {job.original_filename.replace(/^\d+_/, '').replace(/_/g, ' ')}
                  </p>
                </div>
              )
            })}
          </div>
        </div>
      )}
    </div>
  )
}
