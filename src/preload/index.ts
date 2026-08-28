import { contextBridge, ipcRenderer } from 'electron'

// 主进程 -> 渲染进程事件类型（与 main/index.ts 里的 channel 保持一致）
export type RealtimeStatus = {
  status: string
  detail?: string
}

export type RealtimeMessage = {
  type: string
  [key: string]: unknown
}

const api = {
  /** 建立实时语音连接（连接在主进程，渲染进程拿不到 WebSocket）。 */
  connect: (opts: {
    apiKey: string
    model?: string
    url?: string
  }): Promise<{ ok: true } | { ok: false; error: string }> =>
    ipcRenderer.invoke('realtime:connect', opts),

  /** 向服务端发送 JSON 事件。 */
  send: (payload: unknown): void => ipcRenderer.send('realtime:send', payload),

  /** 断开连接。 */
  disconnect: (): void => ipcRenderer.send('realtime:disconnect'),

  onStatus: (cb: (s: RealtimeStatus) => void): (() => void) => {
    const listener = (_e: unknown, s: RealtimeStatus): void => cb(s)
    ipcRenderer.on('realtime:status', listener)
    return () => ipcRenderer.removeListener('realtime:status', listener)
  },

  onMessage: (cb: (m: RealtimeMessage) => void): (() => void) => {
    const listener = (_e: unknown, m: RealtimeMessage): void => cb(m)
    ipcRenderer.on('realtime:message', listener)
    return () => ipcRenderer.removeListener('realtime:message', listener)
  },

  onError: (cb: (e: { message: string }) => void): (() => void) => {
    const listener = (_e: unknown, e: { message: string }): void => cb(e)
    ipcRenderer.on('realtime:error', listener)
    return () => ipcRenderer.removeListener('realtime:error', listener)
  },

  /** 用 qwen3.7-max 把对话（+可选参考文档）整理成 Markdown 笔记。 */
  generateNotes: (opts: {
    apiKey: string
    messages: Array<{ role: 'system' | 'user' | 'assistant'; content: string }>
    /** 上传的参考文档，整理笔记时一起提供给模型。 */
    documents?: Array<{ name: string; content: string }>
  }): Promise<{ ok: true; content: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('notes:generate', opts),

  /** 弹保存对话框，把内容写入本地 .md 文件。 */
  saveNote: (opts: {
    content: string
    defaultName: string
  }): Promise<{ ok: true; path: string } | { ok: false; error: string }> =>
    ipcRenderer.invoke('notes:save', opts)
}

contextBridge.exposeInMainWorld('api', api)

export type Api = typeof api
