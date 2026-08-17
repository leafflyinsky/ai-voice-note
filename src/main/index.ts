import { app, BrowserWindow, dialog, ipcMain, session, shell } from 'electron'
import { join } from 'path'
import { writeFile } from 'fs/promises'
import WebSocket from 'ws'

let mainWindow: BrowserWindow | null = null

// ---------- Realtime WebSocket 桥接 ----------
// 浏览器 WebSocket 无法自定义请求头，所以连接放在主进程（Node `ws` 支持 headers）。
// 渲染进程通过 IPC 转发音频和事件，主进程负责真正的收发。

interface RealtimeConn {
  ws: WebSocket
  url: string
}

let conn: RealtimeConn | null = null

function sendToRenderer(channel: string, payload: unknown): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send(channel, payload)
  }
}

function teardownConn(): void {
  if (conn) {
    try {
      conn.ws.terminate()
    } catch {
      /* ignore */
    }
    conn = null
  }
}

/** 建立实时语音 WebSocket 连接。返回 Promise，open 或 error 时 resolve。 */
function openRealtimeSocket(
  apiKey: string,
  opts: { model?: string; url?: string }
): Promise<{ ok: true } | { ok: false; error: string }> {
  const model = opts.model || 'qwen-audio-3.0-realtime-plus'
  const url =
    opts.url ||
    `wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=${encodeURIComponent(model)}`

  return new Promise((resolve) => {
    let settled = false
    const settle = (r: { ok: true } | { ok: false; error: string }): void => {
      if (!settled) {
        settled = true
        resolve(r)
      }
    }

    const ws = new WebSocket(url, {
      headers: {
        Authorization: `Bearer ${apiKey}`,
        'OpenAI-Beta': 'realtime=v1'
      }
    })

    conn = { ws, url }

    ws.on('open', () => {
      sendToRenderer('realtime:status', { status: 'connected', detail: 'WebSocket 已连接' })
      settle({ ok: true })
    })

    ws.on('message', (data) => {
      const text = data.toString()
      try {
        const msg = JSON.parse(text)
        sendToRenderer('realtime:message', msg)
      } catch {
        // 非 JSON 帧（协议异常时便于排查），原样转发
        sendToRenderer('realtime:message', { type: '__raw__', data: text.slice(0, 500) })
      }
    })

    ws.on('error', (err) => {
      const msg = err instanceof Error ? err.message : String(err)
      sendToRenderer('realtime:error', { message: msg })
      settle({ ok: false, error: msg })
    })

    ws.on('close', (code, reason) => {
      if (conn?.ws === ws) conn = null
      sendToRenderer('realtime:status', {
        status: 'closed',
        detail: `连接已关闭（code=${code} ${reason.toString() || ''}）`
      })
      settle({ ok: false, error: `连接已关闭（code=${code} ${reason.toString() || ''}）` })
    })
  })
}

function setupIpc(): void {
  ipcMain.handle(
    'realtime:connect',
    (_e, opts: { apiKey: string; model?: string; url?: string }) => {
      teardownConn()
      if (!opts?.apiKey) {
        return { ok: false as const, error: '缺少 API Key' }
      }
      return openRealtimeSocket(opts.apiKey, opts)
    }
  )

  ipcMain.on('realtime:send', (_e, payload: unknown) => {
    if (conn && conn.ws.readyState === WebSocket.OPEN) {
      conn.ws.send(typeof payload === 'string' ? payload : JSON.stringify(payload))
    }
  })

  ipcMain.on('realtime:disconnect', () => {
    teardownConn()
  })

  ipcMain.handle(
    'notes:generate',
    async (_e, opts: { apiKey?: string; messages?: unknown }) => {
      const apiKey = opts?.apiKey
      const messages = opts?.messages
      if (!apiKey || !Array.isArray(messages) || messages.length === 0) {
        return { ok: false as const, error: '缺少 API Key 或对话内容' }
      }
      const url =
        'https://dashscope.aliyuncs.com/api/v1/services/aigc/text-generation/generation'
      try {
        const res = await fetch(url, {
          method: 'POST',
          headers: {
            Authorization: `Bearer ${apiKey}`,
            'Content-Type': 'application/json'
          },
          body: JSON.stringify({
            model: 'qwen-max',
            input: { messages: [NOTE_SYSTEM_PROMPT, ...messages] },
            parameters: { result_format: 'message' }
          })
        })
        const data = await res.json().catch(() => null)
        if (!res.ok) {
          const errMsg =
            (data as { message?: string; code?: string } | null)?.message ??
            (data as { code?: string } | null)?.code ??
            `HTTP ${res.status}`
          return { ok: false as const, error: `API 错误: ${errMsg}` }
        }
        const content = (data as { output?: { choices?: Array<{ message?: { content?: unknown } }> } })
          ?.output?.choices?.[0]?.message?.content
        if (typeof content !== 'string') {
          return { ok: false as const, error: '返回格式异常，未能提取笔记内容' }
        }
        return { ok: true as const, content }
      } catch (e) {
        return {
          ok: false as const,
          error: `请求失败: ${e instanceof Error ? e.message : String(e)}`
        }
      }
    }
  )

  ipcMain.handle(
    'notes:save',
    async (_e, opts: { content?: string; defaultName?: string }) => {
      const content = opts?.content
      if (typeof content !== 'string' || !content) {
        return { ok: false as const, error: '缺少笔记内容' }
      }
      const win = BrowserWindow.getFocusedWindow() ?? mainWindow
      const { canceled, filePath } = await dialog.showSaveDialog(win!, {
        title: '保存笔记',
        defaultPath: opts?.defaultName ?? 'ai-note.md',
        filters: [{ name: 'Markdown', extensions: ['md'] }]
      })
      if (canceled || !filePath) {
        return { ok: false as const, error: '已取消保存' }
      }
      try {
        await writeFile(filePath, content, 'utf8')
        return { ok: true as const, path: filePath }
      } catch (e) {
        return {
          ok: false as const,
          error: `写入失败: ${e instanceof Error ? e.message : String(e)}`
        }
      }
    }
  )
}

const NOTE_SYSTEM_PROMPT = {
  role: 'system' as const,
  content: `你是一位专业的对话整理助手。请把用户提供的一段 AI 语音/文字对话记录，整理成结构清晰的 Markdown 笔记。

要求：
1. 忽略寒暄、闲聊和无关内容，只提取有信息量的话语。
2. 结构包含以下小节（按需取舍）：
   - # 标题（根据对话主题拟一个简洁标题）
   - ## 对话主题 / 背景
   - ## 核心要点（分条列出主要观点、结论，保留有价值的具体信息如数字、人名、时间）
   - ## 待办事项（对话中提到的行动计划，用 - [ ] 列表）
   - ## 总结（2-3 句话概括整段对话）
3. 使用简洁的 Markdown，层级清晰，不要冗长。
4. 直接输出 Markdown 正文，不要额外解释。`
}

// ---------- 窗口 ----------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 980,
    height: 720,
    minWidth: 760,
    minHeight: 560,
    title: 'AI 语音对话笔记',
    autoHideMenuBar: true,
    backgroundColor: '#14161a',
    webPreferences: {
      preload: join(__dirname, '../preload/index.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false
    }
  })

  mainWindow.on('closed', () => {
    mainWindow = null
  })

  // 外部链接用系统浏览器打开
  mainWindow.webContents.setWindowOpenHandler(({ url }) => {
    shell.openExternal(url)
    return { action: 'deny' }
  })

  const devUrl = process.env['ELECTRON_RENDERER_URL']
  if (devUrl) {
    mainWindow.loadURL(devUrl)
  } else {
    mainWindow.loadFile(join(__dirname, '../renderer/index.html'))
  }
}

app.whenReady().then(() => {
  // 放行麦克风权限（渲染进程 getUserMedia 需要）
  session.defaultSession.setPermissionRequestHandler((_wc, permission, callback) => {
    if (permission === 'media') {
      callback(true)
    } else {
      callback(false)
    }
  })

  setupIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  if (process.platform !== 'darwin') app.quit()
})

app.on('before-quit', () => {
  teardownConn()
})
