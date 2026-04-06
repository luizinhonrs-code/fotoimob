'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { X, RotateCcw, Minus, Plus, Trash2, Paintbrush, MousePointer } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Job } from '@/lib/supabase'

type Mode = 'click' | 'brush'

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
  const [isSegmenting, setIsSegmenting] = useState(false)
  const [canvasReady, setCanvasReady] = useState(false)
  const [clickDot, setClickDot] = useState<{ x: number; y: number } | null>(null)
  const lastPos = useRef<{ x: number; y: number } | null>(null)

  const imageUrl = job.decluttered_url || job.original_url

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

  const saveHistory = useCallback(() => {
    const paint = paintRef.current
    if (!paint) return
    const data = paint.getContext('2d')!.getImageData(0, 0, paint.width, paint.height)
    setHistory(prev => [...prev.slice(-19), data])
  }, [])

  const applyMaskToOverlay = useCallback((maskBase64: string) => {
    const paint = paintRef.current
    if (!paint) return
    const ctx = paint.getContext('2d')!
    const img = new Image()
    img.onload = () => {
      const tmp = document.createElement('canvas')
      tmp.width = paint.width; tmp.height = paint.height
      const tmpCtx = tmp.getContext('2d')!
      tmpCtx.drawImage(img, 0, 0, paint.width, paint.height)
      const maskData = tmpCtx.getImageData(0, 0, tmp.width, tmp.height)
      const overlayData = ctx.getImageData(0, 0, paint.width, paint.height)
      for (let i = 0; i < maskData.data.length; i += 4) {
        if (maskData.data[i] > 128) {
          overlayData.data[i] = 239
          overlayData.data[i + 1] = 68
          overlayData.data[i + 2] = 68
          overlayData.data[i + 3] = Math.max(overlayData.data[i + 3], 160)
        }
      }
      ctx.putImageData(overlayData, 0, 0)
    }
    img.src = maskBase64
  }, [])

  // Click mode — send to segment API
  const handleClick = useCallback(async (e: React.MouseEvent | React.TouchEvent) => {
    if (mode !== 'click' || isSegmenting) return
    const paint = paintRef.current
    if (!paint) return
    e.preventDefault()

    const pos = getPos(e, paint)
    // Show dot at click position (as % of canvas for CSS)
    const rect = paint.getBoundingClientRect()
    const dotX = ('touches' in e ? e.touches[0].clientX : e.clientX) - rect.left
    const dotY = ('touches' in e ? e.touches[0].clientY : e.clientY) - rect.top
    setClickDot({ x: dotX, y: dotY })

    saveHistory()
    setIsSegmenting(true)
    try {
      const res = await fetch(`/api/jobs/${job.id}/segment`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({
          clickX: Math.round(pos.x),
          clickY: Math.round(pos.y),
          canvasWidth: paint.width,
          canvasHeight: paint.height,
        }),
      })
      const data = await res.json()
      if (!res.ok) throw new Error(data.error || 'Erro desconhecido')
      applyMaskToOverlay(data.mask)
    } catch (err) {
      alert(`Erro: ${err instanceof Error ? err.message : err}`)
    } finally {
      setIsSegmenting(false)
      setClickDot(null)
    }
  }, [mode, isSegmenting, job.id, saveHistory, applyMaskToOverlay])

  // Brush mode
  const startDraw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (mode !== 'brush') return
    const paint = paintRef.current
    if (!paint) return
    e.preventDefault()
    saveHistory()
    setIsDrawing(true)
    lastPos.current = getPos(e, paint)
  }, [mode, saveHistory])

  const draw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing || mode !== 'brush') return
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
  }, [isDrawing, mode, brushSize])

  const stopDraw = useCallback(() => {
    setIsDrawing(false)
    lastPos.current = null
  }, [])

  const undo = () => {
    const paint = paintRef.current
    if (!paint || history.length === 0) return
    paint.getContext('2d')!.putImageData(history[history.length - 1], 0, 0)
    setHistory(h => h.slice(0, -1))
  }

  const clear = () => {
    const paint = paintRef.current
    if (!paint) return
    saveHistory()
    paint.getContext('2d')!.clearRect(0, 0, paint.width, paint.height)
  }

  const handleSubmit = async () => {
    const paint = paintRef.current
    if (!paint) return
    const mc = document.createElement('canvas')
    mc.width = paint.width; mc.height = paint.height
    const mCtx = mc.getContext('2d')!
    mCtx.fillStyle = 'black'
    mCtx.fillRect(0, 0, mc.width, mc.height)
    const od = paint.getContext('2d')!.getImageData(0, 0, paint.width, paint.height)
    const md = mCtx.getImageData(0, 0, mc.width, mc.height)
    for (let i = 0; i < od.data.length; i += 4) {
      if (od.data[i + 3] > 10) {
        md.data[i] = 255; md.data[i + 1] = 255
        md.data[i + 2] = 255; md.data[i + 3] = 255
      }
    }
    mCtx.putImageData(md, 0, 0)
    setIsSubmitting(true)
    try {
      const res = await fetch(`/api/jobs/${job.id}/inpaint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mask: mc.toDataURL('image/png') }),
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

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center overflow-auto p-4 md:p-6">
      <div className="w-full max-w-5xl flex items-center justify-between mb-3 flex-shrink-0">
        <div>
          <h2 className="text-white font-semibold text-base">Selecionar para remover</h2>
          <p className="text-xs text-gray-400 mt-0.5">
            {mode === 'click'
              ? 'Clique no objeto — IA detecta o contorno automaticamente (~10s)'
              : 'Pinte sobre os objetos que deseja remover'}
          </p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Mode tabs */}
      <div className="flex gap-1 mb-3 bg-gray-800 rounded-lg p-1 flex-shrink-0">
        <button
          onClick={() => setMode('click')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            mode === 'click' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
          }`}
        >
          <MousePointer className="w-3.5 h-3.5" />
          Clique
        </button>
        <button
          onClick={() => setMode('brush')}
          className={`flex items-center gap-1.5 px-3 py-1.5 rounded-md text-sm font-medium transition-colors ${
            mode === 'brush' ? 'bg-blue-600 text-white' : 'text-gray-400 hover:text-white'
          }`}
        >
          <Paintbrush className="w-3.5 h-3.5" />
          Pincel
        </button>
      </div>

      {/* Canvas */}
      <div className="relative flex-shrink-0 rounded-lg overflow-hidden border border-gray-700">
        <canvas ref={photoRef} className="block" />
        <canvas
          ref={paintRef}
          className="absolute inset-0"
          style={{
            cursor: mode === 'click' ? (isSegmenting ? 'wait' : 'crosshair') : 'cell',
            touchAction: 'none',
          }}
          onClick={mode === 'click' ? handleClick : undefined}
          onTouchEnd={mode === 'click' ? handleClick : undefined}
          onMouseDown={mode === 'brush' ? startDraw : undefined}
          onMouseMove={mode === 'brush' ? draw : undefined}
          onMouseUp={stopDraw}
          onMouseLeave={stopDraw}
          onTouchStart={mode === 'brush' ? startDraw : undefined}
          onTouchMove={mode === 'brush' ? draw : undefined}
        />

        {/* Segmenting overlay */}
        {isSegmenting && (
          <div className="absolute inset-0 flex flex-col items-center justify-center bg-black/50 pointer-events-none">
            <div className="w-8 h-8 border-2 border-blue-400 border-t-transparent rounded-full animate-spin mb-2" />
            <span className="text-xs text-blue-300 font-medium">Detectando contorno...</span>
          </div>
        )}

        {/* Click dot feedback */}
        {clickDot && (
          <div
            className="absolute w-5 h-5 rounded-full border-2 border-white bg-blue-500/70 -translate-x-1/2 -translate-y-1/2 pointer-events-none animate-ping"
            style={{ left: clickDot.x, top: clickDot.y }}
          />
        )}

        {!canvasReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
            <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="w-full max-w-5xl mt-3 flex flex-wrap items-center gap-2 flex-shrink-0">
        {mode === 'brush' && (
          <div className="flex items-center gap-1.5 bg-gray-800 rounded-lg px-2.5 py-1.5">
            <button onClick={() => setBrushSize(s => Math.max(5, s - 5))} className="text-gray-300 hover:text-white">
              <Minus className="w-3.5 h-3.5" />
            </button>
            <span className="text-xs text-gray-300 w-20 text-center">Pincel {brushSize}px</span>
            <button onClick={() => setBrushSize(s => Math.min(120, s + 5))} className="text-gray-300 hover:text-white">
              <Plus className="w-3.5 h-3.5" />
            </button>
          </div>
        )}

        <Button size="sm" variant="outline" onClick={undo}
          disabled={history.length === 0 || isSegmenting}
          className="border-gray-700 text-gray-300 hover:bg-gray-800 h-8">
          <RotateCcw className="w-3 h-3 mr-1" />Desfazer
        </Button>

        <Button size="sm" variant="outline" onClick={clear}
          disabled={isSegmenting}
          className="border-gray-700 text-gray-300 hover:bg-gray-800 h-8">
          <Trash2 className="w-3 h-3 mr-1" />Limpar
        </Button>

        <div className="ml-auto flex gap-2">
          <Button size="sm" variant="outline" onClick={onClose}
            className="border-gray-700 text-gray-300 hover:bg-gray-800 h-8">
            Cancelar
          </Button>
          <Button size="sm" onClick={handleSubmit}
            disabled={isSubmitting || isSegmenting || !canvasReady}
            className="bg-red-600 hover:bg-red-700 text-white h-8 disabled:opacity-60">
            {isSubmitting ? (
              <><div className="w-3 h-3 mr-1 border border-white border-t-transparent rounded-full animate-spin" />Removendo...</>
            ) : 'Remover selecionado'}
          </Button>
        </div>
      </div>

      <p className="text-xs text-gray-500 mt-2 flex-shrink-0 text-center">
        {mode === 'click'
          ? 'Clique em vários objetos para acumular seleções. Depois clique em Remover.'
          : 'Pinte sobre as áreas. Use Desfazer para corrigir.'}
      </p>
    </div>
  )
}
