'use client'

import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'

type Preset = 'vivido' | 'quente'
type Status = 'processing' | 'done' | 'error'

type Intensity = 'low' | 'medium' | 'high'

interface Result {
  file: string
  preset: Preset
  status: Status
  originalUrl?: string
  resultUrl?: string
  luminance?: number
  intensity?: Intensity
  error?: string
}

const INTENSITY_LABEL: Record<Intensity, { label: string; color: string }> = {
  low:    { label: 'Leve (foto clara)',    color: 'bg-yellow-900 text-yellow-300' },
  medium: { label: 'Médio (normal)',       color: 'bg-blue-900 text-blue-300'    },
  high:   { label: 'Forte (foto escura)', color: 'bg-purple-900 text-purple-300' },
}

const PRESET_LABELS: Record<Preset, { label: string; icon: string; color: string }> = {
  vivido: { label: 'Vívido',  icon: '✨', color: 'bg-blue-600 hover:bg-blue-500'   },
  quente: { label: 'Quente',  icon: '🔆', color: 'bg-amber-600 hover:bg-amber-500' },
}

async function pollPrediction(
  predictionId: string,
  resultPath: string,
  onDone: (resultUrl: string) => void,
  onError: (msg: string) => void
) {
  const MAX = 75 // 5 min
  for (let i = 0; i < MAX; i++) {
    await new Promise((r) => setTimeout(r, 4000))
    try {
      const qs = new URLSearchParams({ resultPath })
      const res = await fetch(`/api/test-flux/${predictionId}?${qs}`)
      if (!res.ok) continue
      const data = await res.json()
      if (data.status === 'done') { onDone(data.resultUrl); return }
      if (data.status === 'error') { onError(data.error || 'Erro'); return }
    } catch { /* ignora erros temporários */ }
  }
  onError('Timeout — processo demorou mais de 5 minutos')
}

export default function TestFluxPage() {
  const [preset, setPreset]       = useState<Preset>('vivido')
  const [results, setResults]     = useState<Result[]>([])
  const [processing, setProcessing] = useState(false)

  const updateResult = useCallback((key: string, patch: Partial<Result>) => {
    setResults((prev) => prev.map((r) => (r.file === key ? { ...r, ...patch } : r)))
  }, [])

  const processFile = useCallback(async (file: File, selectedPreset: Preset) => {
    const key = `${file.name}-${selectedPreset}-${Date.now()}`
    setResults((prev) => [{ file: file.name, preset: selectedPreset, status: 'processing' }, ...prev])

    try {
      const form = new FormData()
      form.append('file', file)
      form.append('preset', selectedPreset)

      const res  = await fetch('/api/test-flux', { method: 'POST', body: form })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erro')

      updateResult(file.name, {
        originalUrl: data.originalUrl,
        luminance:   data.luminance,
        intensity:   data.intensity,
      })

      await pollPrediction(
        data.predictionId,
        data.resultPath,
        (resultUrl) => updateResult(file.name, { status: 'done', resultUrl }),
        (error)     => updateResult(file.name, { status: 'error', error })
      )
    } catch (e) {
      updateResult(file.name, { status: 'error', error: e instanceof Error ? e.message : 'Erro' })
    }
  }, [updateResult])

  const onDrop = useCallback(async (acceptedFiles: File[]) => {
    setProcessing(true)
    for (const file of acceptedFiles) {
      await processFile(file, preset)
    }
    setProcessing(false)
  }, [processFile, preset])

  const { getRootProps, getInputProps, isDragActive } = useDropzone({
    onDrop,
    accept: { 'image/*': ['.jpg', '.jpeg', '.png', '.webp'] },
    multiple: true,
  })

  return (
    <div className="min-h-screen bg-gray-950 text-white p-6">
      <div className="max-w-5xl mx-auto space-y-6">

        {/* Header */}
        <div>
          <h1 className="text-2xl font-bold">🎨 Teste de Presets FLUX</h1>
          <p className="text-gray-400 mt-1 text-sm">
            Testa os presets de edição com{' '}
            <code className="bg-gray-800 px-1 rounded">black-forest-labs/flux-2-klein-4b</code>
          </p>
        </div>

        {/* Seletor de preset */}
        <div className="bg-gray-900 rounded-xl p-4">
          <p className="text-sm text-gray-400 mb-3 font-medium">Selecione o preset</p>
          <div className="flex gap-3">
            {(Object.keys(PRESET_LABELS) as Preset[]).map((p) => {
              const { label, icon, color } = PRESET_LABELS[p]
              return (
                <button
                  key={p}
                  onClick={() => setPreset(p)}
                  className={`px-5 py-2.5 rounded-lg font-medium text-sm transition-colors ${
                    preset === p
                      ? color + ' text-white ring-2 ring-white/30'
                      : 'bg-gray-800 text-gray-400 hover:bg-gray-700'
                  }`}
                >
                  {icon} {label}
                </button>
              )
            })}
          </div>
        </div>

        {/* Dropzone */}
        <div
          {...getRootProps()}
          className={`border-2 border-dashed rounded-xl p-10 text-center cursor-pointer transition-colors ${
            isDragActive
              ? 'border-blue-500 bg-blue-950/30'
              : 'border-gray-700 hover:border-gray-500 bg-gray-900'
          }`}
        >
          <input {...getInputProps()} />
          <p className="text-lg">
            {isDragActive ? '📂 Solte as fotos aqui...' : '📁 Arraste fotos ou clique para selecionar'}
          </p>
          <p className="text-gray-500 text-sm mt-1">
            Preset ativo: <span className="text-white font-medium">{PRESET_LABELS[preset].icon} {PRESET_LABELS[preset].label}</span>
          </p>
          {processing && (
            <p className="text-blue-400 text-sm mt-2 animate-pulse">⏳ Processando...</p>
          )}
        </div>

        {/* Resultados */}
        {results.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Resultados</h2>
              <button onClick={() => setResults([])} className="text-xs text-gray-500 hover:text-gray-300">
                Limpar
              </button>
            </div>

            {results.map((r, i) => (
              <div key={i} className="bg-gray-900 rounded-xl p-4 space-y-3">

                {/* Nome + preset + status */}
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-gray-300 truncate flex-1">{r.file}</span>
                  <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${
                    r.preset === 'vivido' ? 'bg-blue-900 text-blue-300' : 'bg-amber-900 text-amber-300'
                  }`}>
                    {PRESET_LABELS[r.preset].icon} {PRESET_LABELS[r.preset].label}
                  </span>
                  {r.status === 'processing' && (
                    <span className="text-blue-400 text-sm animate-pulse">⏳ Processando...</span>
                  )}
                  {r.status === 'done' && (
                    <span className="text-green-400 text-sm">✅ Concluído</span>
                  )}
                  {r.status === 'error' && (
                    <span className="text-red-400 text-sm">❌ Erro</span>
                  )}
                </div>

                {/* Luminância + intensidade */}
                {r.luminance !== undefined && r.intensity && (
                  <div className="flex items-center gap-2 text-sm">
                    <span className="text-gray-500">Luminância:</span>
                    <span className="font-mono font-bold">{r.luminance}</span>
                    <span className={`text-xs px-2 py-0.5 rounded-full font-medium ${INTENSITY_LABEL[r.intensity].color}`}>
                      {INTENSITY_LABEL[r.intensity].label}
                    </span>
                  </div>
                )}

                {r.error && <p className="text-red-400 text-sm">{r.error}</p>}

                {/* Antes / Depois */}
                {r.originalUrl && (
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div className="space-y-1">
                      <p className="text-xs text-gray-500 uppercase tracking-wide">Original</p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img src={r.originalUrl} alt="Original" className="w-full rounded-lg object-cover aspect-[4/3]" />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-gray-500 uppercase tracking-wide">
                        {PRESET_LABELS[r.preset].icon} {PRESET_LABELS[r.preset].label}
                      </p>
                      {r.resultUrl ? (
                        // eslint-disable-next-line @next/next/no-img-element
                        <img src={r.resultUrl} alt="Resultado" className="w-full rounded-lg object-cover aspect-[4/3]" />
                      ) : (
                        <div className="w-full rounded-lg aspect-[4/3] bg-gray-800 flex items-center justify-center">
                          <span className="text-gray-500 text-sm animate-pulse">Processando...</span>
                        </div>
                      )}
                    </div>
                  </div>
                )}
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}
