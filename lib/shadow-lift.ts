/**
 * Shadow Lift — melhoria de iluminação seletiva com Sharp
 *
 * Aplica gamma + CLAHE apenas nas áreas escuras da imagem,
 * preservando os highlights e a estrutura original.
 *
 * Baseado nos testes com variante E1 (gamma=1.5, maxSlope=3, blend=0.5)
 * que apresentou o melhor resultado sem artefatos.
 */

import sharp from 'sharp'

export interface ShadowLiftOptions {
  /** Intensidade do gamma (1.0 = sem mudança, 1.5 = padrão) */
  gamma?: number
  /** Limite de contraste do CLAHE (2 = suave, 4 = médio) */
  maxSlope?: number
  /** Força do blend seletivo nas sombras (0-1) */
  blendStrength?: number
}

const DEFAULTS: Required<ShadowLiftOptions> = {
  gamma: 1.5,
  maxSlope: 3,
  blendStrength: 0.5,
}

/**
 * Aplica melhoria de iluminação seletiva em um buffer de imagem.
 * Retorna um novo buffer JPEG com as sombras levantadas.
 */
export async function applyShadowLift(
  inputBytes: Uint8Array,
  options: ShadowLiftOptions = {}
): Promise<Buffer> {
  const { gamma, maxSlope, blendStrength } = { ...DEFAULTS, ...options }

  const meta = await sharp(inputBytes).metadata()
  const w = meta.width ?? 1920
  const h = meta.height ?? 1080

  // Tile size para CLAHE: 1/20 da menor dimensão (mínimo 8, inteiro)
  const tileSize = Math.max(8, Math.floor(Math.min(w, h) / 20))

  try {
    // Versão melhorada: gamma + CLAHE + leve dessaturação para evitar oversaturation
    const enhanced = await sharp(inputBytes)
      .gamma(gamma)
      .clahe({ width: tileSize, height: tileSize, maxSlope })
      .modulate({ saturation: 0.92 })
      .toBuffer()

    // Máscara de sombras: pixels escuros → branco (serão blend com enhanced)
    //                      pixels claros  → preto  (mantém o original)
    const shadowMask = await sharp(inputBytes)
      .greyscale()
      .negate()                          // inverte: escuro vira claro na máscara
      .blur(15)                          // suaviza bordas
      .linear(blendStrength, 0)          // controla intensidade do blend
      .toBuffer()

    // Blend seletivo: screen clareia sem estourar highlights
    const result = await sharp(inputBytes)
      .composite([
        { input: enhanced, blend: 'screen' },
        { input: shadowMask, blend: 'multiply', premultiplied: false },
      ])
      .jpeg({ quality: 95 })
      .toBuffer()

    return result
  } catch {
    // Fallback: aplica apenas gamma + CLAHE direto (sem blend seletivo)
    return sharp(inputBytes)
      .gamma(gamma)
      .clahe({ width: tileSize, height: tileSize, maxSlope })
      .modulate({ saturation: 0.92 })
      .jpeg({ quality: 95 })
      .toBuffer()
  }
}
