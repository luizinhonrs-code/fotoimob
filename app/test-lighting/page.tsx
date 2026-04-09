'use client'

import { useState, useCallback } from 'react'
import { useDropzone } from 'react-dropzone'

type ExposureLevel = 'very_dark' | 'dark' | 'normal' | 'bright' | 'very_bright'

interface Result {
  file: string
  status: 'processing' | 'done' | 'skipped' | 'error'
  exposure?: {
    luminance: number
    level: ExposureLevel
    needsAI: boolean
    breadParams: { gamma: number; strength: number }
  }
  originalUrl?: string
  enhancedUrl?: string
  message?: string
  error?: string
}

const LEVEL_LABEL: Record<ExposureLevel, string> = {
  very_dark: 'Muito escura',
  dark: 'Escura',
  normal: 'Normal',
  bright: 'Clara',
  very_bright: 'Muito clara',
}

const LEVEL_COLOR: Record<ExposureLevel, string> = {
  very_dark: 'bg-gray-800 text-white',
  dark: 'bg-gray-600 text-white',
  normal: 'bg-blue-600 text-white',
  bright: 'bg-yellow-500 text-white',
  very_bright: 'bg-orange-500 text-white',
}

export default function TestLightingPage() {
  const [results, setResults] = useState<Result[]>([])
  const [processing, setProcessing] = useState(false)

  const processFile = useCallback(async (file: File) => {
    const id = file.name

    // Adiciona entrada de processando
    setResults((prev) => [
      { file: id, status: 'processing' },
      ...prev,
    ])

    try {
      const form = new FormData()
      form.append('file', file)

      const res = await fetch('/api/test-lighting', { method: 'POST', body: form })
      const data = await res.json()

      if (!res.ok) throw new Error(data.error || 'Erro desconhecido')

      setResults((prev) =>
        prev.map((r) =>
          r.file === id
            ? {
                file: id,
                status: data.skipped ? 'skipped' : 'done',
                exposure: data.exposure,
                originalUrl: data.originalUrl,
                enhancedUrl: data.enhancedUrl,
                message: data.message,
              }
            : r
        )
      )
    } catch (e) {
      setResults((prev) =>
        prev.map((r) =>
          r.file === id
            ? { file: id, status: 'error', error: e instanceof Error ? e.message : 'Erro' }
            : r
        )
      )
    }
  }, [])

  const onDrop = useCallback(
    async (acceptedFiles: File[]) => {
      setProcessing(true)
      for (const file of acceptedFiles) {
        await processFile(file)
      }
      setProcessing(false)
    },
    [processFile]
  )

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
          <h1 className="text-2xl font-bold">🔆 Teste de Iluminação</h1>
          <p className="text-gray-400 mt-1 text-sm">
            Sobe fotos para analisar a exposição e testar o ajuste automático com{' '}
            <code className="bg-gray-800 px-1 rounded">mingcv/bread</code>
          </p>
        </div>

        {/* Tabela de referência */}
        <div className="bg-gray-900 rounded-xl p-4 text-sm">
          <p className="text-gray-400 mb-3 font-medium">Tabela de parâmetros automáticos</p>
          <div className="overflow-x-auto">
            <table className="w-full text-left">
              <thead>
                <tr className="text-gray-500 border-b border-gray-800">
                  <th className="pb-2 pr-4">Luminância</th>
                  <th className="pb-2 pr-4">Nível</th>
                  <th className="pb-2 pr-4">Passa pelo bread?</th>
                  <th className="pb-2 pr-4">Gamma</th>
                  <th className="pb-2">Strength</th>
                </tr>
              </thead>
              <tbody className="text-gray-300">
                {[
                  { range: '< 70', level: 'Muito escura', ai: true,  gamma: 0.9,  strength: 0.02 },
                  { range: '70–105', level: 'Escura',     ai: true,  gamma: 0.8,  strength: 0.02 },
                  { range: '105–140', level: 'Normal',    ai: true,  gamma: 0.6,  strength: 0.01 },
                  { range: '140–175', level: 'Clara',     ai: true,  gamma: 0.4,  strength: 0 },
                  { range: '> 175', level: 'Muito clara', ai: false, gamma: '—',  strength: '—' },
                ].map((row) => (
                  <tr key={row.range} className="border-b border-gray-800/50">
                    <td className="py-1.5 pr-4 font-mono">{row.range}</td>
                    <td className="py-1.5 pr-4">{row.level}</td>
                    <td className="py-1.5 pr-4">{row.ai ? '✅' : '❌'}</td>
                    <td className="py-1.5 pr-4 font-mono">{row.gamma}</td>
                    <td className="py-1.5 font-mono">{row.strength}</td>
                  </tr>
                ))}
              </tbody>
            </table>
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
          <p className="text-gray-500 text-sm mt-1">JPG, PNG, WEBP — múltiplas fotos suportadas</p>
          {processing && (
            <p className="text-blue-400 text-sm mt-2 animate-pulse">⏳ Processando...</p>
          )}
        </div>

        {/* Resultados */}
        {results.length > 0 && (
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <h2 className="text-lg font-semibold">Resultados</h2>
              <button
                onClick={() => setResults([])}
                className="text-xs text-gray-500 hover:text-gray-300"
              >
                Limpar
              </button>
            </div>

            {results.map((r, i) => (
              <div key={i} className="bg-gray-900 rounded-xl p-4 space-y-3">
                {/* Nome + status */}
                <div className="flex items-center gap-3">
                  <span className="font-mono text-sm text-gray-300 truncate flex-1">{r.file}</span>
                  {r.status === 'processing' && (
                    <span className="text-blue-400 text-sm animate-pulse">⏳ Processando...</span>
                  )}
                  {r.status === 'done' && (
                    <span className="text-green-400 text-sm">✅ Concluído</span>
                  )}
                  {r.status === 'skipped' && (
                    <span className="text-yellow-400 text-sm">⏭ Pulado</span>
                  )}
                  {r.status === 'error' && (
                    <span className="text-red-400 text-sm">❌ Erro</span>
                  )}
                </div>

                {/* Análise de exposição */}
                {r.exposure && (
                  <div className="flex items-center gap-3 text-sm">
                    <span className="text-gray-500">Luminância:</span>
                    <span className="font-mono font-bold text-white">{r.exposure.luminance}</span>
                    <span
                      className={`px-2 py-0.5 rounded-full text-xs font-medium ${LEVEL_COLOR[r.exposure.level]}`}
                    >
                      {LEVEL_LABEL[r.exposure.level]}
                    </span>
                    {r.exposure.needsAI && (
                      <>
                        <span className="text-gray-600">→</span>
                        <span className="text-gray-400 font-mono">
                          gamma {r.exposure.breadParams.gamma} / strength {r.exposure.breadParams.strength}
                        </span>
                      </>
                    )}
                  </div>
                )}

                {/* Mensagem de skip */}
                {r.message && (
                  <p className="text-yellow-300 text-sm">{r.message}</p>
                )}

                {/* Erro */}
                {r.error && (
                  <p className="text-red-400 text-sm">{r.error}</p>
                )}

                {/* Comparação antes/depois */}
                {r.originalUrl && r.enhancedUrl && (
                  <div className="grid grid-cols-2 gap-3 mt-2">
                    <div className="space-y-1">
                      <p className="text-xs text-gray-500 uppercase tracking-wide">Original</p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={r.originalUrl}
                        alt="Original"
                        className="w-full rounded-lg object-cover aspect-[4/3]"
                      />
                    </div>
                    <div className="space-y-1">
                      <p className="text-xs text-gray-500 uppercase tracking-wide">
                        Após bread
                        {r.exposure && (
                          <span className="ml-1 text-blue-400 normal-case">
                            (γ={r.exposure.breadParams.gamma})
                          </span>
                        )}
                      </p>
                      {/* eslint-disable-next-line @next/next/no-img-element */}
                      <img
                        src={r.enhancedUrl}
                        alt="Melhorado"
                        className="w-full rounded-lg object-cover aspect-[4/3]"
                      />
                    </div>
                  </div>
                )}

                {/* Só original (foto clara, pulou AI) */}
                {r.originalUrl && !r.enhancedUrl && r.status === 'skipped' && (
                  <div className="space-y-1">
                    <p className="text-xs text-gray-500 uppercase tracking-wide">Foto (sem alteração)</p>
                    {/* eslint-disable-next-line @next/next/no-img-element */}
                    <img
                      src={r.originalUrl}
                      alt="Original"
                      className="w-full max-w-sm rounded-lg object-cover aspect-[4/3]"
                    />
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
