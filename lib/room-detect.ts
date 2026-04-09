/**
 * Detecção de cômodo via CLIP zero-shot (lucataco/clip-vit-base-patch32)
 * Custo: ~$0.0023/imagem no Replicate
 */

import { replicate } from '@/lib/replicate'

const CLIP_VERSION = '056324d6fb78878c1016e432a3827fa76950022848c5378681dd99b7dc7dcc24'

// Labels em inglês (CLIP tem melhor acurácia em inglês)
// Mapeadas para PT-BR no display
const ROOM_LABELS: Record<string, string> = {
  'living room interior':                    'Sala de estar',
  'bedroom interior with bed':               'Quarto',
  'kitchen interior with cabinets':          'Cozinha',
  'bathroom interior with sink or toilet':   'Banheiro',
  'balcony or terrace outdoor':              'Varanda',
  'building facade exterior street view':    'Fachada',
  'garage or parking area':                  'Garagem',
  'laundry room or service area':            'Área de serviço',
  'corridor or hallway interior':            'Corredor',
  'home office or study room':               'Escritório',
  'dining room with table and chairs':       'Sala de jantar',
  'swimming pool outdoor':                   'Piscina',
}

export interface RoomResult {
  label: string        // PT-BR
  labelEn: string      // inglês original
  confidence: number   // 0-1
  isExterior: boolean
}

const EXTERIOR_LABELS = new Set([
  'balcony or terrace outdoor',
  'building facade exterior street view',
  'garage or parking area',
  'swimming pool outdoor',
])

export async function detectRoom(imageUrl: string): Promise<RoomResult> {
  const labels = Object.keys(ROOM_LABELS)
  const text = labels.join(' | ')

  const output = await replicate.run(
    `lucataco/clip-vit-base-patch32:${CLIP_VERSION}` as `${string}/${string}:${string}`,
    { input: { image: imageUrl, text } }
  )

  // Output: array de scores na mesma ordem dos labels
  const scores = output as number[]

  // Encontra o label com maior score
  const maxIdx = scores.reduce((best, s, i) => (s > scores[best] ? i : best), 0)
  const labelEn = labels[maxIdx]

  return {
    label: ROOM_LABELS[labelEn],
    labelEn,
    confidence: Math.round(scores[maxIdx] * 100),
    isExterior: EXTERIOR_LABELS.has(labelEn),
  }
}
