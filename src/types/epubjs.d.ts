declare module 'epubjs' {
  export interface EpubMetadata {
    title?: string
    creator?: string
  }

  export interface EpubNavigationItem {
    id?: string
    href: string
    label: string
    subitems?: EpubNavigationItem[]
  }

  export interface EpubNavigation {
    toc: EpubNavigationItem[]
  }

  export interface EpubLocationStart {
    cfi: string
  }

  export interface EpubLocation {
    start: EpubLocationStart
    end?: EpubLocationStart
    percentage?: number
  }

  export interface EpubContents {
    document: Document
  }

  export interface EpubRendition {
    display(target?: string | number): Promise<void>
    next(): Promise<void>
    prev(): Promise<void>
    themes: {
      default(rules: Record<string, Record<string, string>>): void
      fontSize(size: string): void
    }
    on(event: 'rendered', callback: (_section: unknown, contents: EpubContents) => void): void
    on(event: 'relocated', callback: (location: EpubLocation) => void): void
    off(event: 'rendered' | 'relocated', callback: (...args: never[]) => void): void
    destroy(): void
  }

  export interface EpubBook {
    ready: Promise<void>
    loaded: {
      metadata: Promise<EpubMetadata>
      navigation: Promise<EpubNavigation>
    }
    renderTo(element: Element | string, options?: Record<string, unknown>): EpubRendition
    coverUrl(): Promise<string | null>
    destroy(): void
  }

  export default function ePub(input?: ArrayBuffer | string): EpubBook
}
