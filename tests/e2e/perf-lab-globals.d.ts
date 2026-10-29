export {}

declare global {
  interface Window {
    __perfLabSearch?: { at: number; query: string; results: number; ready: boolean }[]
    __perfLabRenderEvents?: { at: number; scope: string; type: string; added: number; removed: number }[]
    __perfLabPlayerViewReady?: (expected: unknown) => boolean
    __perfLabFirstContentMs?: number
    __perfLab?: { events: unknown[] }
    __savedSearch?: string
    __touches?: number
    clicked?: string
    opened?: boolean
    selectedFilter?: boolean
    proxyMarker?: boolean
  }

  interface Navigator {
    standalone?: boolean
  }
}
