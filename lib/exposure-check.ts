/**
 * Análise de exposição de imagem com Sharp
 * Retorna luminância média e parâmetros recomendados para mingcv/bread
 *
 * mingcv/bread schema:
 *   gamma:    0–1.5  (default 1.0) — controla brilho, >1 = mais claro
 *   strength: 0–0.2  (default 0.05) — denoising, não afeta exposição
 */

import sharp from 'sharp'

export type ExposureLevel = 'very_dark' | 'dark' | 'normal' | 'bright' | 'very_bright'

export interface ExposureResult {
  luminance: number         // 0–255, luminância percebida (BT.601)
  level: ExposureLevel
  needsAI: boolean          // se deve passar pelo mingcv/bread
  breadParams: {
    gamma: number           // 0–1.5, quanto clarear
    strength: number        // 0–0.2, denoising
  }
}

/**
 * Analisa a exposição de uma imagem a partir de um buffer.
 * Usa luminância ponderada: 0.299*R + 0.587*G + 0.114*B (padrão BT.601)
 */
export async function checkExposure(inputBytes: Uint8Array | Buffer): Promise<ExposureResult> {
  const stats = await sharp(inputBytes)
    .removeAlpha()
    .stats()

  const r = stats.channels[0].mean
  const g = stats.channels[1].mean
  const b = stats.channels[2].mean

  // Luminância ponderada (perceptual)
  const luminance = Math.round(0.299 * r + 0.587 * g + 0.114 * b)

  let level: ExposureLevel
  let needsAI: boolean
  // O modelo bread já clareia automaticamente — gamma é um multiplicador
  // de intensidade sobre o resultado. Fotos escuras → gamma mais alto,
  // fotos claras → gamma mais baixo para não estourar.
  // Calibrado com testes reais: foto escura (L:72) → gamma 0.9 / strength 0.02
  //                             foto clara          → gamma ~0.4 / strength 0
  let gamma: number
  let strength: number

  if (luminance < 80) {
    level = 'very_dark'
    needsAI = true
    gamma = 0.9
    strength = 0.02
  } else if (luminance < 105) {
    level = 'dark'
    needsAI = true
    gamma = 0.8
    strength = 0.02
  } else if (luminance < 140) {
    level = 'normal'
    needsAI = true
    gamma = 0.6
    strength = 0.01
  } else if (luminance < 160) {
    level = 'bright'
    needsAI = true
    gamma = 0.4
    strength = 0
  } else {
    level = 'very_bright'
    needsAI = false
    gamma = 1.0
    strength = 0
  }

  return {
    luminance,
    level,
    needsAI,
    breadParams: { gamma, strength },
  }
}

/**
 * Versão para uso com URL pública (busca e analisa)
 */
export async function checkExposureFromUrl(url: string): Promise<ExposureResult> {
  const response = await fetch(url)
  if (!response.ok) throw new Error(`Failed to fetch image: ${response.status}`)
  const bytes = new Uint8Array(await response.arrayBuffer())
  return checkExposure(bytes)
}
