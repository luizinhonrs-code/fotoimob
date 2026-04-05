'use client'

import { useState, useCallback, useRef } from 'react'
import { Upload, ImagePlus } from 'lucide-react'
import { Progress } from '@/components/ui/progress'
import { Job } from '@/lib/supabase'

interface UploadZoneProps {
  onJobsCreated: (jobs: Job[]) => void
}

export default function UploadZone({ onJobsCreated }: UploadZoneProps) {
  const [isDragging, setIsDragging] = useState(false)
  const [isUploading, setIsUploading] = useState(false)
  const [uploadProgress, setUploadProgress] = useState(0)
  const [uploadStatus, setUploadStatus] = useState('')
  const fileInputRef = useRef<HTMLInputElement>(null)

  const handleFiles = useCallback(
    async (files: FileList | File[]) => {
      const imageFiles = Array.from(files).filter((f) =>
        ['image/jpeg', 'image/png', 'image/webp'].includes(f.type)
      )

      if (imageFiles.length === 0) {
        setUploadStatus('Nenhuma imagem válida encontrada.')
        return
      }

      setIsUploading(true)
      setUploadProgress(10)
      setUploadStatus(`Enviando ${imageFiles.length} foto(s)...`)

      try {
        const formData = new FormData()
        imageFiles.forEach((file) => formData.append('files', file))

        setUploadProgress(40)

        const response = await fetch('/api/upload', {
          method: 'POST',
          body: formData,
        })

        setUploadProgress(80)

        if (!response.ok) {
          const err = await response.json()
          throw new Error(err.error || 'Erro ao fazer upload')
        }

        const data = await response.json()
        setUploadProgress(100)
        setUploadStatus(`${data.jobs.length} foto(s) adicionada(s) com sucesso!`)
        onJobsCreated(data.jobs)

        setTimeout(() => {
          setUploadStatus('')
          setUploadProgress(0)
        }, 2000)
      } catch (error) {
        setUploadStatus(
          `Erro: ${error instanceof Error ? error.message : 'Falha no upload'}`
        )
        setUploadProgress(0)
      } finally {
        setIsUploading(false)
        if (fileInputRef.current) {
          fileInputRef.current.value = ''
        }
      }
    },
    [onJobsCreated]
  )

  const handleDrop = useCallback(
    (e: React.DragEvent) => {
      e.preventDefault()
      setIsDragging(false)
      if (e.dataTransfer.files.length > 0) {
        handleFiles(e.dataTransfer.files)
      }
    },
    [handleFiles]
  )

  const handleDragOver = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(true)
  }, [])

  const handleDragLeave = useCallback((e: React.DragEvent) => {
    e.preventDefault()
    setIsDragging(false)
  }, [])

  const handleClick = () => {
    if (!isUploading) {
      fileInputRef.current?.click()
    }
  }

  const handleInputChange = (e: React.ChangeEvent<HTMLInputElement>) => {
    if (e.target.files && e.target.files.length > 0) {
      handleFiles(e.target.files)
    }
  }

  return (
    <div className="w-full">
      <div
        onClick={handleClick}
        onDrop={handleDrop}
        onDragOver={handleDragOver}
        onDragLeave={handleDragLeave}
        className={`
          relative border-2 border-dashed rounded-xl p-12 text-center cursor-pointer
          transition-all duration-200
          ${isDragging
            ? 'border-blue-500 bg-blue-500/10'
            : 'border-gray-700 hover:border-gray-500 bg-gray-900/50 hover:bg-gray-900'
          }
          ${isUploading ? 'pointer-events-none opacity-70' : ''}
        `}
      >
        <input
          ref={fileInputRef}
          type="file"
          accept="image/jpeg,image/png,image/webp"
          multiple
          onChange={handleInputChange}
          className="hidden"
        />

        <div className="flex flex-col items-center gap-4">
          {isUploading ? (
            <Upload className="w-12 h-12 text-blue-400 animate-bounce" />
          ) : (
            <ImagePlus
              className={`w-12 h-12 transition-colors ${
                isDragging ? 'text-blue-400' : 'text-gray-500'
              }`}
            />
          )}

          <div>
            <p className="text-lg font-medium text-gray-200">
              {isDragging
                ? 'Solte as fotos aqui'
                : 'Arraste fotos ou clique para selecionar'}
            </p>
            <p className="text-sm text-gray-500 mt-1">
              JPEG, PNG, WebP — múltiplos arquivos suportados
            </p>
          </div>
        </div>
      </div>

      {(isUploading || uploadStatus) && (
        <div className="mt-3 space-y-2">
          {isUploading && uploadProgress > 0 && (
            <Progress value={uploadProgress} className="h-2 bg-gray-800" />
          )}
          {uploadStatus && (
            <p
              className={`text-sm text-center ${
                uploadStatus.startsWith('Erro') ? 'text-red-400' : 'text-gray-400'
              }`}
            >
              {uploadStatus}
            </p>
          )}
        </div>
      )}
    </div>
  )
}
