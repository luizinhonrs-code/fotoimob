/**
 * Detecção de cômodo via CLIP zero-shot
 * Modelo: cjwbw/clip-vit-large-patch14 (ViT-L — mais preciso que base-patch32)
 * Custo: ~$0.0023/imagem no Replicate
 */

import { replicate } from '@/lib/replicate'

// ViT-L/14 — maior e mais preciso que o base-patch32
const CLIP_VERSION = '566ab1f111e526640c5154e712d4d54961414278f89d36590f1425badc763ecb'

// Labels mais descritivos para reduzir confusão entre cômodos similares
const ROOM_LABELS: Record<string, string> = {
  'living room interior with sofa couch and television':         'Sala de estar',
  'bedroom interior with bed mattress and pillows':             'Quarto',
  'kitchen interior with stove oven refrigerator and cabinets': 'Cozinha',
  'bathroom interior with toilet sink shower or bathtub':       'Banheiro',
  'open balcony terrace with railing outdoors':                 'Varanda',
  'building exterior facade front view street':                 'Fachada',
  'garage parking area with car or gate':                       'Garagem',
  'laundry service room with washing machine':                  'Área de serviço',
  'narrow corridor hallway entrance hall interior':             'Corredor',
  'home office study room with desk computer':                  'Escritório',
  'dining room with dining table and chairs':                   'Sala de jantar',
  'swimming pool outdoor area':                                 'Piscina',
}

export interface RoomResult {
  label: string        // PT-BR
  labelEn: string      // inglês original
  confidence: number   // 0–100
  isExterior: boolean
}

const EXTERIOR_LABELS = new Set([
  'open balcony terrace with railing outdoors',
  'building exterior facade front view street',
  'garage parking area with car or gate',
  'swimming pool outdoor area',
])

const LABEL_KEYS = Object.keys(ROOM_LABELS)

export async function detectRoom(imageUrl: string): Promise<RoomResult> {
  const text = LABEL_KEYS.join(' | ')

  const output = await replicate.run(
    `cjwbw/clip-vit-large-patch14:${CLIP_VERSION}` as `${string}/${string}:${string}`,
    { input: { image: imageUrl, text } }
  )

  const scores = output as number[]
  const maxIdx = scores.reduce((best, s, i) => (s > scores[best] ? i : best), 0)
  const labelEn = LABEL_KEYS[maxIdx]

  return {
    label: ROOM_LABELS[labelEn],
    labelEn,
    confidence: Math.round(scores[maxIdx] * 100),
    isExterior: EXTERIOR_LABELS.has(labelEn),
  }
}
