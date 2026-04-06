'use client'

import { useRef, useState, useEffect, useCallback } from 'react'
import { X, RotateCcw, Minus, Plus, Trash2 } from 'lucide-react'
import { Button } from '@/components/ui/button'
import { Job } from '@/lib/supabase'

interface BrushEditorProps {
  job: Job
  onClose: () => void
  onDone: () => void
}

export default function BrushEditor({ job, onClose, onDone }: BrushEditorProps) {
  const photoRef = useRef<HTMLCanvasElement>(null)
  const paintRef = useRef<HTMLCanvasElement>(null)
  const [brushSize, setBrushSize] = useState(30)
  const [isDrawing, setIsDrawing] = useState(false)
  const [history, setHistory] = useState<ImageData[]>([])
  const [isSubmitting, setIsSubmitting] = useState(false)
  const [canvasReady, setCanvasReady] = useState(false)
  const lastPos = useRef<{ x: number; y: number } | null>(null)

  const imageUrl = job.decluttered_url || job.original_url

  useEffect(() => {
    const photo = photoRef.current
    const paint = paintRef.current
    if (!photo || !paint) return

    const img = new Image()
    img.crossOrigin = 'anonymous'
    img.onload = () => {
      const maxW = Math.min(window.innerWidth - 48, 880)
      const maxH = Math.min(window.innerHeight - 220, 580)
      const scale = Math.min(maxW / img.width, maxH / img.height, 1)
      const w = Math.floor(img.width * scale)
      const h = Math.floor(img.height * scale)

      photo.width = w
      photo.height = h
      paint.width = w
      paint.height = h

      photo.getContext('2d')!.drawImage(img, 0, 0, w, h)
      setCanvasReady(true)
    }
    img.onerror = () => {
      // Try without crossOrigin for same-origin images
      const img2 = new Image()
      img2.onload = () => {
        const maxW = Math.min(window.innerWidth - 48, 880)
        const maxH = Math.min(window.innerHeight - 220, 580)
        const scale = Math.min(maxW / img2.width, maxH / img2.height, 1)
        const w = Math.floor(img2.width * scale)
        const h = Math.floor(img2.height * scale)
        photo.width = w
        photo.height = h
        paint.width = w
        paint.height = h
        photo.getContext('2d')!.drawImage(img2, 0, 0, w, h)
        setCanvasReady(true)
      }
      img2.src = imageUrl
    }
    img.src = imageUrl
  }, [imageUrl])

  const getPos = (e: React.MouseEvent | React.TouchEvent, canvas: HTMLCanvasElement) => {
    const rect = canvas.getBoundingClientRect()
    const scaleX = canvas.width / rect.width
    const scaleY = canvas.height / rect.height
    if ('touches' in e) {
      const touch = e.touches[0]
      return {
        x: (touch.clientX - rect.left) * scaleX,
        y: (touch.clientY - rect.top) * scaleY,
      }
    }
    return {
      x: (e.clientX - rect.left) * scaleX,
      y: (e.clientY - rect.top) * scaleY,
    }
  }

  const startDraw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    const paint = paintRef.current
    if (!paint) return
    e.preventDefault()

    const ctx = paint.getContext('2d')!
    setHistory(prev => [...prev.slice(-19), ctx.getImageData(0, 0, paint.width, paint.height)])
    setIsDrawing(true)
    lastPos.current = getPos(e, paint)
  }, [])

  const draw = useCallback((e: React.MouseEvent | React.TouchEvent) => {
    if (!isDrawing) return
    const paint = paintRef.current
    if (!paint) return
    e.preventDefault()

    const ctx = paint.getContext('2d')!
    const pos = getPos(e, paint)

    ctx.strokeStyle = 'rgba(239, 68, 68, 0.65)'
    ctx.lineWidth = brushSize
    ctx.lineCap = 'round'
    ctx.lineJoin = 'round'
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
    const paint = paintRef.current
    if (!paint || history.length === 0) return
    const ctx = paint.getContext('2d')!
    ctx.putImageData(history[history.length - 1], 0, 0)
    setHistory(h => h.slice(0, -1))
  }

  const clear = () => {
    const paint = paintRef.current
    if (!paint) return
    const ctx = paint.getContext('2d')!
    setHistory(prev => [...prev.slice(-19), ctx.getImageData(0, 0, paint.width, paint.height)])
    ctx.clearRect(0, 0, paint.width, paint.height)
  }

  const handleSubmit = async () => {
    const paint = paintRef.current
    if (!paint) return

    // Build black/white mask from painted overlay
    const maskCanvas = document.createElement('canvas')
    maskCanvas.width = paint.width
    maskCanvas.height = paint.height
    const maskCtx = maskCanvas.getContext('2d')!
    maskCtx.fillStyle = 'black'
    maskCtx.fillRect(0, 0, maskCanvas.width, maskCanvas.height)

    const overlayData = paint.getContext('2d')!.getImageData(0, 0, paint.width, paint.height)
    const maskData = maskCtx.getImageData(0, 0, maskCanvas.width, maskCanvas.height)
    for (let i = 0; i < overlayData.data.length; i += 4) {
      if (overlayData.data[i + 3] > 10) {
        maskData.data[i] = 255
        maskData.data[i + 1] = 255
        maskData.data[i + 2] = 255
        maskData.data[i + 3] = 255
      }
    }
    maskCtx.putImageData(maskData, 0, 0)

    setIsSubmitting(true)
    try {
      const res = await fetch(`/api/jobs/${job.id}/inpaint`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ mask: maskCanvas.toDataURL('image/png') }),
      })
      if (!res.ok) {
        const err = await res.json()
        throw new Error(err.error || 'Erro desconhecido')
      }
      onDone()
      onClose()
    } catch (err) {
      alert(`Erro: ${err instanceof Error ? err.message : 'Erro desconhecido'}`)
    } finally {
      setIsSubmitting(false)
    }
  }

  return (
    <div className="fixed inset-0 z-50 bg-black/95 flex flex-col items-center overflow-auto p-4 md:p-6">
      {/* Header */}
      <div className="w-full max-w-5xl flex items-center justify-between mb-3 flex-shrink-0">
        <div>
          <h2 className="text-white font-semibold text-base">Pintar para remover</h2>
          <p className="text-xs text-gray-400 mt-0.5">Pinte sobre os objetos que deseja remover</p>
        </div>
        <button onClick={onClose} className="text-gray-400 hover:text-white p-1">
          <X className="w-5 h-5" />
        </button>
      </div>

      {/* Canvas stack */}
      <div className="relative flex-shrink-0 rounded-lg overflow-hidden border border-gray-700">
        <canvas ref={photoRef} className="block" />
        <canvas
          ref={paintRef}
          className="absolute inset-0"
          style={{ cursor: 'crosshair', touchAction: 'none' }}
          onMouseDown={startDraw}
          onMouseMove={draw}
          onMouseUp={stopDraw}
          onMouseLeave={stopDraw}
          onTouchStart={startDraw}
          onTouchMove={draw}
          onTouchEnd={stopDraw}
        />
        {!canvasReady && (
          <div className="absolute inset-0 flex items-center justify-center bg-gray-900">
            <div className="w-6 h-6 border-2 border-blue-400 border-t-transparent rounded-full animate-spin" />
          </div>
        )}
      </div>

      {/* Controls */}
      <div className="w-full max-w-5xl mt-3 flex flex-wrap items-center gap-2 flex-shrink-0">
        <div className="flex items-center gap-1.5 bg-gray-800 rounded-lg px-2.5 py-1.5">
          <button
            onClick={() => setBrushSize(s => Math.max(5, s - 5))}
            className="text-gray-300 hover:text-white"
          >
            <Minus className="w-3.5 h-3.5" />
          </button>
          <span className="text-xs text-gray-300 w-20 text-center">
            Pincel {brushSize}px
          </span>
          <button
            onClick={() => setBrushSize(s => Math.min(120, s + 5))}
            className="text-gray-300 hover:text-white"
          >
            <Plus className="w-3.5 h-3.5" />
          </button>
        </div>

        <Button
          size="sm"
          variant="outline"
          onClick={undo}
          disabled={history.length === 0}
          className="border-gray-700 text-gray-300 hover:bg-gray-800 h-8"
        >
          <RotateCcw className="w-3 h-3 mr-1" />
          Desfazer
        </Button>

        <Button
          size="sm"
          variant="outline"
          onClick={clear}
          className="border-gray-700 text-gray-300 hover:bg-gray-800 h-8"
        >
          <Trash2 className="w-3 h-3 mr-1" />
          Limpar
        </Button>

        <div className="ml-auto flex gap-2">
          <Button
            size="sm"
            variant="outline"
            onClick={onClose}
            className="border-gray-700 text-gray-300 hover:bg-gray-800 h-8"
          >
            Cancelar
          </Button>
          <Button
            size="sm"
            onClick={handleSubmit}
            disabled={isSubmitting || !canvasReady}
            className="bg-red-600 hover:bg-red-700 text-white h-8 disabled:opacity-60"
          >
            {isSubmitting ? (
              <>
                <div className="w-3 h-3 mr-1 border border-white border-t-transparent rounded-full animate-spin" />
                Enviando...
              </>
            ) : (
              'Remover'
            )}
          </Button>
        </div>
      </div>
    </div>
  )
}
