export type PresetKey =
  | 'casa-praia'
  | 'casa-montanha'
  | 'apartamento-centro'
  | 'estudio'
  | 'alto-padrao'
  | 'temporada'
  | 'sem-preset'

export interface Preset {
  key: PresetKey
  label: string
  /** CSS filter string for instant client-side preview */
  cssFilter: string
  /** Sharp parameters applied server-side at download */
  sharpParams: {
    brightness: number  // .modulate() brightness multiplier
    saturation: number  // .modulate() saturation multiplier
    hue: number         // .modulate() hue shift in degrees
    linearA: number     // .linear(a, b) — contrast multiplier
    linearB: number     // .linear(a, b) — brightness offset (negative compensates blowout)
  }
}

export const PRESETS: Record<PresetKey, Preset> = {
  'casa-praia': {
    key: 'casa-praia',
    label: 'Casa de Praia',
    cssFilter: 'brightness(1.15) saturate(1.25) contrast(1.1) sepia(0.12)',
    sharpParams: { brightness: 1.15, saturation: 1.25, hue: 8, linearA: 1.1, linearB: -10 },
  },
  'casa-montanha': {
    key: 'casa-montanha',
    label: 'Casa de Montanha',
    cssFilter: 'brightness(1.05) saturate(1.15) contrast(1.2) hue-rotate(-15deg)',
    sharpParams: { brightness: 1.05, saturation: 1.15, hue: -15, linearA: 1.2, linearB: -15 },
  },
  'apartamento-centro': {
    key: 'apartamento-centro',
    label: 'Apartamento Centro',
    cssFilter: 'brightness(1.10) saturate(1.05) contrast(1.15)',
    sharpParams: { brightness: 1.10, saturation: 1.05, hue: 0, linearA: 1.15, linearB: -12 },
  },
  'estudio': {
    key: 'estudio',
    label: 'Estúdio/Compacto',
    cssFilter: 'brightness(1.20) saturate(0.95) contrast(1.05) hue-rotate(-8deg)',
    sharpParams: { brightness: 1.20, saturation: 0.95, hue: -8, linearA: 1.05, linearB: -5 },
  },
  'alto-padrao': {
    key: 'alto-padrao',
    label: 'Alto Padrão',
    cssFilter: 'brightness(1.08) saturate(1.10) contrast(1.20) sepia(0.08)',
    sharpParams: { brightness: 1.08, saturation: 1.10, hue: 12, linearA: 1.20, linearB: -18 },
  },
  'temporada': {
    key: 'temporada',
    label: 'Temporada/Airbnb',
    cssFilter: 'brightness(1.20) saturate(1.30) contrast(1.10) sepia(0.15)',
    sharpParams: { brightness: 1.20, saturation: 1.30, hue: 10, linearA: 1.10, linearB: -10 },
  },
  'sem-preset': {
    key: 'sem-preset',
    label: 'Sem Preset',
    cssFilter: '',
    sharpParams: { brightness: 1.0, saturation: 1.0, hue: 0, linearA: 1.0, linearB: 0 },
  },
}

export const PRESET_LIST = Object.values(PRESETS)
