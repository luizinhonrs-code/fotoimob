'use client'

import { useState, useEffect, useCallback } from 'react'
import { Camera } from 'lucide-react'
import UploadZone from '@/components/UploadZone'
import PhotoGrid from '@/components/PhotoGrid'
import { Job } from '@/lib/supabase'

export default function Home() {
  const [jobs, setJobs] = useState<Job[]>([])
  const [loading, setLoading] = useState(true)

  const fetchJobs = useCallback(async () => {
    try {
      const response = await fetch('/api/jobs')
      if (response.ok) {
        const data = await response.json()
        setJobs(data.jobs || [])
      }
    } catch (err) {
      console.error('Failed to fetch jobs:', err)
    } finally {
      setLoading(false)
    }
  }, [])

  // Initial fetch
  useEffect(() => {
    fetchJobs()
  }, [fetchJobs])

  // Poll every 5 seconds
  useEffect(() => {
    const interval = setInterval(fetchJobs, 5000)
    return () => clearInterval(interval)
  }, [fetchJobs])

  const handleJobsCreated = (newJobs: Job[]) => {
    setJobs((prev) => [...newJobs, ...prev])
  }

  const hasActiveJobs = jobs.some(
    (j) => j.status === 'enhancing' || j.status === 'decluttering'
  )

  return (
    <main className="min-h-screen bg-gray-950 text-white">
      {/* Header */}
      <header className="border-b border-gray-800 bg-gray-900/50 backdrop-blur-sm sticky top-0 z-10">
        <div className="max-w-6xl mx-auto px-4 py-4 flex items-center gap-3">
          <div className="flex items-center justify-center w-9 h-9 rounded-lg bg-blue-600">
            <Camera className="w-5 h-5 text-white" />
          </div>
          <div>
            <h1 className="text-xl font-bold text-white leading-none">FotoImob</h1>
            <p className="text-xs text-gray-400 mt-0.5">Processamento de fotos com IA</p>
          </div>
          {hasActiveJobs && (
            <div className="ml-auto flex items-center gap-2 text-xs text-blue-400">
              <div className="w-2 h-2 rounded-full bg-blue-400 animate-pulse" />
              Processando...
            </div>
          )}
        </div>
      </header>

      {/* Main content */}
      <div className="max-w-6xl mx-auto px-4 py-8 space-y-8">
        {/* Upload zone */}
        <UploadZone onJobsCreated={handleJobsCreated} />

        {/* Jobs grid */}
        {loading ? (
          <div className="flex items-center justify-center py-16">
            <div className="w-8 h-8 border-2 border-blue-500 border-t-transparent rounded-full animate-spin" />
          </div>
        ) : (
          <PhotoGrid jobs={jobs} onJobsUpdate={fetchJobs} />
        )}

        {!loading && jobs.length === 0 && (
          <div className="text-center py-16 text-gray-600">
            <Camera className="w-12 h-12 mx-auto mb-3 opacity-30" />
            <p className="text-lg">Nenhuma foto ainda</p>
            <p className="text-sm mt-1">Faca upload de fotos acima para comecar</p>
          </div>
        )}
      </div>
    </main>
  )
}
