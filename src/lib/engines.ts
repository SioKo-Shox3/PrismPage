import type { EngineId } from '@/types/app'

export const engineOptions: Array<{
  id: EngineId
  label: string
  description: string
}> = [
  {
    id: 'real-cugan',
    label: 'Real-CUGAN',
    description: '漫画・イラスト向け',
  },
  {
    id: 'waifu2x',
    label: 'waifu2x',
    description: '漫画・線画向け',
  },
  {
    id: 'real-esrgan',
    label: 'Real-ESRGAN',
    description: '表紙・挿絵混在向け',
  },
]

export function getEngineLabel(engineId: EngineId) {
  return engineOptions.find((engine) => engine.id === engineId)?.label ?? engineId
}

export function getEngineDescription(engineId: EngineId) {
  return engineOptions.find((engine) => engine.id === engineId)?.description ?? ''
}
