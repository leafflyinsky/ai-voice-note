export {}

declare global {
  interface Window {
    api: {
      connect: (opts: {
        apiKey: string
        model?: string
        url?: string
      }) => Promise<{ ok: true } | { ok: false; error: string }>
      send: (payload: unknown) => void
      disconnect: () => void
      onStatus: (cb: (s: { status: string; detail?: string }) => void) => () => void
      onMessage: (cb: (m: { type: string; [key: string]: unknown }) => void) => () => void
      onError: (cb: (e: { message: string }) => void) => () => void
      generateNotes: (opts: {
        apiKey: string
        messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
        documents?: Array<{ name: string; content: string }>
      }) => Promise<{ ok: true; content: string } | { ok: false; error: string }>
      saveNote: (opts: {
        content: string
        defaultName: string
      }) => Promise<{ ok: true; path: string } | { ok: false; error: string }>
    }
  }
}
