'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { X, RotateCcw, Minus, Plus, Trash2, Paintbrush, MousePointer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Job } from '@/lib/supabase'

type Mode = 'click' | 'brush'

interface SamMask {
  index: number
  area: number
  cx: number  // canvas coords
  cy: number  // canvas coords
  storedPath: string
}

interface BrushEditorProps {
  job: Job
  onClose: () => void
  onDone: () => void
}

export default function BrushEditor({ job, onClose, onDone }: BrushEditorProps) {
  const photoRef = useRef<HTMLCanvasElement>(null)
  const paintRef = useRef<HTMLCanvasElement>(null)
  const [mode, setMode] = useState<Mode>('click')
  const [brushSize, setBrushSize] = useState(30)
  const [isDrawing, setIsDrawing] = useState(false)
  const [history, setHistory] = useState<ImageData[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [canvasReady, setCanvasReady] = useState(false)

  // Click mode state
  const [samAnalyzing, setSamAnalyzing] = useState(false)
  const [samError, setSamError] = useState<string | null>(null)
  const [samMasks, setSamMasks] = useState<SamMask[] | null>(null)
  const [selectedIndices, setSelectedIndices] = useState<Set<number>>(new Set())
  const maskPixels = useRef<Map<number, Uint8Array>>(new Map())
  const analysisStarted = useRef(false)

  // Brush mode state
  const lastPos = useRef<{ x: number; y: number } | null>(null)

  const imageUrl = job.decluttered_url || job.original_url

  // Load image onto canvas
  useEffect(() => {
    const photo = photoRef.current
    const paint = paintRef.current
    if (!photo || !paint) return
    const tryLoad = (crossOrigin: boolean) => {
      const img = new Image()
      if (crossOrigin) img.crossOrigin = 'anonymous'
      img.onload = () => {
        const maxW = Math.min(window.innerWidth - 48, 900)
        const maxH = Math.min(window.innerHeight - 230, 580)
        const scale = Math.min(maxW / img.width, maxH / img.height, 1)
        const w = Math.floor(img.width * scale)
        const h = Math.floor(img.height * scale)
        photo.width = w; photo.height = h
        paint.width = w; paint.height = h
        photo.getContext('2d')!.drawImage(img, 0, 0, w, h)
        setCanvasReady(true)
      }
      img.onerror = () => { if (crossOrigin) tryLoad(false) }
      img.src = imageUrl
    }
    tryLoad(true)
  }, [imageUrl])

  // Start SAM analysis when canvas is ready and mode is click
  useEffect(() => {
    if (!canvasReady || mode !== 'click' || analysisStarted.current) return
    analysisStarted.current = true
    runAnalysis()
  // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [canvasReady, mode])

  const runAnalysis = async () => {
    const paint = paintRef.current
    if (!paint) return
    setSamAnalyzing(true)
    setSamError(null)
    try {
      const res = await fetch(`/api/jobs/${job.id}/segment-all`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ canvasWidth: paint.width, canvasHeight: paint.height }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erro desconhecido')

      // Decode each canvas PNG into a Uint8Array of pixel brightness values
      await Promise.all(data.masks.map((m: SamMask & { canvasB64: string }) =>
        decodeMaskPixels(m.index, m.canvasB64, paint.width, paint.height)
      ))

      setSamMasks(data.masks.map(({ canvasB64: _c, ...rest }: SamMask & { canvasB64: string }) => rest))
    } catch (err) {
      setSamError(err instanceof Error ? err.message : 'Erro ao analisar imagem')
    } finally {
      setSamAnalyzing(false)
    }
  }

  const decodeMaskPixels = (index: number, b64: string, w: number, h: number): Promise<void> =>
    new Promise(resolve => {
      const img = new Image()
      img.onload = () => {
        const tmp = document.createElement('canvas')
        tmp.width = w; tmp.height = h
        tmp.getContext('2d')!.drawImage(img, 0, 0, w, h)
        const imageData = tmp.getContext('2d')!.getImageData(0, 0, w, h)
        const pixels = new Uint8Array(w * h)
        for (let i = 0; i < pixels.length; i++) pixels[i] = imageData.data[i * 4]
        maskPixels.current.set(index, pixels)
        resolve()
      }
      img.onerror = () => resolve()
      img.src = `data:image/png;base64,${b64}`
    })

  // Redraw overlay whenever selection changes
  useEffect(() => {
    const paint = paintRef.current
    if (!paint) return
    const ctx = paint.getContext('2d')!
    const w = paint.width, h = paint.height
    const combined = ctx.createImageData(w, h)

    for (const idx of selectedIndices) {
      const pixels = maskPixels.current.get(idx)
      if (!pixels) continue
      for (let i = 0; i < pixels.length; i++) {
        if (pixels[i] > 128) {
          combined.data[i * 4] = 239
          combined.data[i * 4 + 1] = 68
          combined.data[i * 4 + 2] = 68
          combined.data[i * 4 + 3] = 160
        }
      }
    }

    ctx.clearRect(0, 0, w, h)
    ctx.putImageData(combined, 0, 0)
  }, [selectedIndices])

  const getPos = (e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect()
    const sx = canvas.width / rect.width
    const sy = canvas.height / rect.height
    if ('touches' in e) {
      const t = e.touches[0]
      return { x: (t.clientX - rect.left) * sx, y: (t.clientY - rect.top) * sy }
    }
    return { x: (e.clientX - rect.left) * sx, y: (e.clientY - rect.top) * sy }
  }

  // Click mode: find and toggle the smallest mask at the click point
  const handleClick = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (mode !== 'click' || !samMasks || samAnalyzing) return
    const paint = paintRef.current
    if (!paint) return
    e.preventDefault()
    const pos = getPos(e, paint)
    const px = Math.floor(pos.x)
    const py = Math.floor(pos.y)

    let best: SamMask | null = null
    for (const mask of samMasks) {
      const pixels = maskPixels.current.get(mask.index)
      if (!pixels) continue
      const idx = py * paint.width + px
      if (idx >= 0 && idx < pixels.length && pixels[idx] > 128) {
        if (!best || mask.area < best.area) best = mask
      }
    }

    if (!best) return

    setSelectedIndices(prev => {
      const next = new Set(prev)
      if (next.has(best!.index)) next.delete(best!.index)
      else next.add(best!.index)
      return next
    })
  }, [mode, samMasks, samAnalyzing])

  // Save canvas state for undo
  const saveHistory = useCallback(() => {
    const paint = paintRef.current
    if (!paint) return
    const data = paint.getContext('2d')!.getImageData(0, 0, paint.width, paint.height)
    setHistory(prev => [...prev.slice(-19), data])
  }, [])

  // Brush painting works in both modes — adds shadow/extras on top of click selections
  const startDraw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const paint = paintRef.current
    if (!paint) return
    e.preventDefault()
    saveHistory()
    setIsDrawing(true)
    lastPos.current = getPos(e, paint)
  }, [saveHistory])

  const draw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return
    const paint = paintRef.current
    if (!paint) return
    e.preventDefault()
    const ctx = paint.getContext('2d')!
    const pos = getPos(e, paint)
    ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)'
    ctx.lineWidth = brushSize
    ctx.lineCap = 'round'; ctx.lineJoin = 'round'
    ctx.beginPath()
    if (lastPos.current) ctx.moveTo(lastPos.current.x, lastPos.current.y)
    ctx.lineTo(pos.x, pos.y)
    ctx.stroke()
    lastPos.current = pos
  }, [isDrawing, brushSize])

  const stopDraw = useCallback(() => {
    setIsDrawing(false)
    lastPos.current = null
  }, [])

  const undo = () => {
    // Undo brush strokes first, then click selections
    if (history.length > 0) {
      const paint = paintRef.current
      if (paint) {
        paint.getContext('2d')!.putImageData(history[history.length - 1], 0, 0)
        setHistory(h => h.slice(0, -1))
        return
      }
    }
    // No brush history — undo last click selection
    setSelectedIndices(prev => {
      if (prev.size === 0) return prev
      const arr = [...prev]
      return new Set(arr.slice(0, -1))
    })
  }

  const clear = () => {
    setSelectedIndices(new Set())
    const paint = paintRef.current
    if (!paint) return
    saveHistory()
    paint.getContext('2d')!.clearRect(0, 0, paint.width, paint.height)
  }

  const handleSubmit = async () => {
    const paint = paintRef.current
    if (!paint) return
    setIsSubmitting(true)

    // Build brush canvas mask (B&W PNG) from whatever was painted
    const mc = document.createElement('canvas')
    mc.width = paint.width; mc.height = paint.height
    const mCtx = mc.getContext('2d')!
    mCtx.fillStyle = 'black'
    mCtx.fillRect(0, 0, mc.width, mc.height)
    const od = paint.getContext('2d')!.getImageData(0, 0, paint.width, paint.height)
    const md = mCtx.getImageData(0, 0, mc.width, mc.height)
    for (let i = 0; i < od.data.length; i += 4) {
      if (od.data[i + 3] > 10) {
        md.data[i] = 255; md.data[i + 1] = 255; md.data[i + 2] = 255; md.data[i + 3] = 255
      }
    }
    mCtx.putImageData(md, 0, 0)
    const brushMask = mc.toDataURL('image/png')

    // SAM masks selected by click
    const selectedPaths = samMasks
      ? [...selectedIndices].map(i => samMasks.find(m => m.index === i)?.storedPath).filter((p): p is string => !!p)
      : []

    try {
      const res = await fetch(`/api/jobs/${job.id}/inpaint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          maskPaths: selectedPaths.length > 0 ? selectedPaths : undefined,
          mask: brushMask, // always send brush layer so server can OR-combine with SAM masks
        }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Erro desconhecido')
      }
      onDone(); onClose()
    } catch (err) {
      alert(`Erro: ${err instanceof Error ? err.message : err}`)
    } finally {
      setIsSubmitting(false)
    }
  }

  const canSubmit = selectedIndices.size > 0 || (() => {
    // Check if there's any brush paint on canvas
    const paint = paintRef.current
    if (!paint) return false
    const data = paint.getContext('2d')!.getImageData(0, 0, paint.width, paint.height)
    return data.data.some((v, i) => i % 4 === 3 && v > 10)
  })()

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center overflow-auto p-4 md:p-6">
      <div className="w-full max-w-5xl flex items-center justify-between mb-3 flex-shrink-0">
        <div>
          <h2 className="text-white font-semibold text-base">Selecionar para remover</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {mode === 'click'
              ? samAnalyzing
                ? 'Analisando imagem (~15s)...'
                : samMasks
                  ? `Clique para selecionar objetos • pinte as sombras com o pincel • ${selectedIndices.size} selecionado${selectedIndices.size !== 1 ? 's' : ''}`
                  : 'Clique no objeto — IA detecta o contorno'
              : 'Pinte sobre os objetos e sombras que deseja remover'}
          </p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1 mb-3 bg-gray-800 rounded-lg p-1 flex-shrink-0">
        <button onClick={() => setMode('click')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            mode === 'click' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
          <MousePointer className="w-3.5 h-3.5" />Clique
        </button>
        <button onClick={() => setMode('brush')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            mode === 'brush' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'}`}>
          <Paintbrush className="w-3.5 h-3.5" />Pincel
        </button>
      </div>

      {/* Canvas */}
      <div className="relative flex-shrink-0 rounded-lg overflow-hidden border border-gray-700">
        <canvas ref={photoRef} className="block" />
        <canvas
          ref={paintRef}
          className="absolute inset-0"
          style={{
            cursor: mode === 'click'
              ? (samAnalyzing ? 'wait' : samMasks ? 'pointer' : 'default')
              : 'cell',
            touchAction: 'none',
          }}
          onClick={mode === 'click' ? handleClick : undefined}
          onTouchEnd={mode === 'click' ? handleClick : undefined}
          onMouseDown={startDraw}
          onMouseMove={draw}
          onMouseUp={stopDraw}
          onMouseLeave={stopDraw}
          onTouchStart={startDraw}
          onTouchMove={draw}
        />

        {/* SAM analyzing overlay */}
        {samAnalyzing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60 pointer-events-none">
            <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-2" />
            <span className="text-sm text-blue-300 font-medium">Analisando imagem...</span>
            <span className="text-xs text-gray-400 mt-1">Isso leva ~15s, apenas na primeira vez</span>
          </div>
        )}

        {/* SAM error */}
        {samError && !samAnalyzing && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/60">
            <p className="text-red-400 text-sm mb-2">{samError}</p>
            <button
              onClick={() => { analysisStarted.current = false; runAnalysis() }}
              className="text-xs text-blue-400 underline">
              Tentar novamente
            </button>
          </div>
        )}

        {!canvasReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
            <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="w-full max-w-5xl mt-3 flex flex-wrap items-center gap-2 flex-shrink-0">
        <div className="flex items-center gap-1.5 bg-gray-800 rounded-lg px-2.5 py-1.5">
            <button onClick={() => setBrushSize(s => Math.max(5, s - 5))} className="text-gray-300 hover:text-white">
              <Minus className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs text-gray-300 w-20 text-center">Pincel {brushSize}px</span>
            <button onClick={() => setBrushSize(s => Math.min(120, s + 5))} className="text-gray-300 hover:text-white">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>

        <Button size="sm" variant="outline" onClick={undo}
          disabled={mode === 'click' ? selectedIndices.size === 0 : history.length === 0}
          className="border-gray-700 text-gray-300 hover:bg-gray-800 h-8">
          <RotateCcw className="w-3 h-3 mr-1" />Desfazer
        </Button>
        <Button size="sm" variant="outline" onClick={clear}
          className="border-gray-700 text-gray-300 hover:bg-gray-800 h-8">
          <Trash2 className="w-3 h-3 mr-1" />Limpar
        </Button>

        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={onClose}
            className="border-gray-700 text-gray-300 hover:bg-gray-800 h-8">
            Cancelar
          </Button>
          <Button size="sm" onClick={handleSubmit}
            disabled={isSubmitting || samAnalyzing || !canvasReady || !canSubmit}
            className="bg-red-600 hover:bg-red-700 text-white h-8 disabled:opacity-60">
            {isSubmitting
              ? <><div className="w-3 h-3 mr-1 border border-white border-t-transparent rounded-full animate-spin" />Removendo...</>
              : 'Remover selecionado'}
          </Button>
        </div>
      </div>

      <p className="text-xs text-gray-500 mt-2 flex-shrink-0 text-center">
        {mode === 'click'
          ? 'Clique nos objetos para selecionar/desmarcar. Use o pincel para adicionar sombras à seleção.'
          : 'Pinte sobre objetos e sombras. Use Desfazer para corrigir.'}
      </p>
    </div>
  )
}
