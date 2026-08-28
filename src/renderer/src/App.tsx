import { useCallback, useEffect, useRef, useState } from 'react'
import { RealtimeSession } from './lib/realtime'
import type { SessionPhase, TranscriptItem } from './lib/realtime'

const MODELS = [
  { value: 'qwen-audio-3.0-realtime-plus', label: 'qwen-audio-3.0-realtime-plus' },
  { value: 'qwen-audio-3.0-realtime-flash', label: 'qwen-audio-3.0-realtime-flash' }
]

// ---------- 文档上传 ----------

interface DocItem {
  name: string
  content: string
}

/** 首版支持的纯文本扩展名白名单（二进制格式 PDF/docx/xlsx 留待后续版本）。 */
const TEXT_EXTS = new Set([
  'txt', 'md', 'markdown', 'json', 'csv', 'log', 'ini', 'toml', 'yaml', 'yml',
  'js', 'jsx', 'ts', 'tsx', 'py', 'java', 'c', 'cpp', 'h', 'hpp', 'go', 'rs',
  'html', 'css', 'xml', 'sh', 'bat', 'ps1'
])

/** 单文件大小上限（2MB），超出提示。 */
const MAX_DOC_SIZE = 2 * 1024 * 1024

/**
 * 读取纯文本文件：先严格按 UTF-8 解码，失败则按 GBK（Windows 常见中文编码）重解。
 * 浏览器 TextDecoder 支持 gb18030（覆盖全部 GBK 字符）。
 */
async function readTextFile(file: File): Promise<string> {
  const buf = await file.arrayBuffer()
  try {
    return new TextDecoder('utf-8', { fatal: true }).decode(buf)
  } catch {
    return new TextDecoder('gb18030').decode(buf)
  }
}

const PHASE_META: Record<SessionPhase, { label: string; cls: string }> = {
  idle: { label: '未连接', cls: 'phase-idle' },
  connecting: { label: '连接中…', cls: 'phase-connecting' },
  listening: { label: '聆听中', cls: 'phase-listening' },
  speaking: { label: 'AI 说话中', cls: 'phase-speaking' },
  error: { label: '出错', cls: 'phase-error' }
}

type NoteState = 'idle' | 'generating' | 'preview' | 'saving'

// 主题色方案（黑/白/淡黄/淡绿/淡紫/淡蓝）
export type ThemeKey = 'black' | 'white' | 'yellow' | 'green' | 'purple' | 'blue'

const THEMES: Array<{ key: ThemeKey; label: string }> = [
  { key: 'black', label: '黑' },
  { key: 'white', label: '白' },
  { key: 'yellow', label: '淡黄' },
  { key: 'green', label: '淡绿' },
  { key: 'purple', label: '淡紫' },
  { key: 'blue', label: '淡蓝' }
]

function defaultNoteName(): string {
  const d = new Date()
  const pad = (n: number): string => String(n).padStart(2, '0')
  return `AI对话笔记-${d.getFullYear()}${pad(d.getMonth() + 1)}${pad(d.getDate())}-${pad(d.getHours())}${pad(d.getMinutes())}.md`
}

export default function App() {
  const [apiKey, setApiKey] = useState(() => localStorage.getItem('ai_voice_note_key') ?? '')
  const [model, setModel] = useState(MODELS[0].value)
  const [showAdvanced, setShowAdvanced] = useState(false)
  const [urlOverride, setUrlOverride] = useState('')

  // 模式：solo 单人 / meeting 会议
  const [mode, setMode] = useState<'solo' | 'meeting'>(
    () => (localStorage.getItem('ai_voice_note_mode') as 'solo' | 'meeting') || 'solo'
  )
  const [wakeWord, setWakeWord] = useState(
    () => localStorage.getItem('ai_voice_note_wakeword') ?? 'AI'
  )

  // 主题色
  const [theme, setTheme] = useState<ThemeKey>(
    () => (localStorage.getItem('ai_voice_note_theme') as ThemeKey) || 'black'
  )

  const [phase, setPhase] = useState<SessionPhase>('idle')
  const [phaseDetail, setPhaseDetail] = useState('')
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)

  // 文字输入
  const [textInput, setTextInput] = useState('')

  // 文档上传（跨会话保留，重新开始对话时静默重注入）
  const [documents, setDocuments] = useState<DocItem[]>([])
  const [docError, setDocError] = useState('')

  // 笔记整理
  const [noteState, setNoteState] = useState<NoteState>('idle')
  const [noteMarkdown, setNoteMarkdown] = useState('')
  const [noteError, setNoteError] = useState('')
  const [noteSavedPath, setNoteSavedPath] = useState('')

  const sessionRef = useRef<RealtimeSession | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)
  const fileInputRef = useRef<HTMLInputElement | null>(null)

  const getSession = useCallback((): RealtimeSession => {
    if (!sessionRef.current) {
      sessionRef.current = new RealtimeSession({
        onPhase: (p, detail) => {
          setPhase(p)
          setPhaseDetail(detail ?? '')
        },
        onTranscript: (items) => {
          setTranscript(items)
        },
        onLog: (line) => setLogs((prev) => [...prev.slice(-300), line])
      })
    }
    return sessionRef.current
  }, [])

  // 日志自动滚动到底部
  useEffect(() => {
    logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
  }, [logs, showLog])

  const start = async (): Promise<void> => {
    if (!apiKey.trim()) {
      setPhaseDetail('请先填写 API Key')
      setPhase('error')
      return
    }
    localStorage.setItem('ai_voice_note_key', apiKey.trim())
    setLogs([])
    setNoteSavedPath('')
    localStorage.setItem('ai_voice_note_mode', mode)
    localStorage.setItem('ai_voice_note_wakeword', wakeWord.trim() || 'AI')
    const session = getSession()
    const res = await session.start({
      apiKey: apiKey.trim(),
      model,
      url: urlOverride.trim() || undefined,
      mode,
      wakeWord: wakeWord.trim() || 'AI'
    })
    if (!res.ok) {
      setPhaseDetail(res.error)
      return
    }
    // 已上传的文档静默注入上下文（不打断、不触发 AI 发言）
    if (documents.length > 0) {
      session.injectDocuments(documents)
    }
  }

  const stop = async (): Promise<void> => {
    await getSession().stop()
  }

  const onMainButton = (): void => {
    if (sessionRef.current?.isActive) void stop()
    else void start()
  }

  const active = sessionRef.current?.isActive ?? false
  const meta = PHASE_META[phase]
  const canSendText = active && textInput.trim().length > 0
  const canGenerateNote = transcript.length > 0 && noteState !== 'generating'

  const sendText = (): void => {
    const t = textInput.trim()
    if (!t) return
    getSession().sendText(t)
    setTextInput('')
  }

  const onTextKeyDown = (e: React.KeyboardEvent<HTMLInputElement>): void => {
    if (e.key === 'Enter') sendText()
  }

  // ---------- 文档上传 ----------

  const pickDocument = (): void => {
    fileInputRef.current?.click()
  }

  const handleFiles = (files: FileList | null): void => {
    const file = files?.[0]
    // 清空 input 值，确保下次选择同一文件也会触发 change
    if (fileInputRef.current) fileInputRef.current.value = ''
    if (!file) return

    const ext = (file.name.split('.').pop() ?? '').toLowerCase()
    if (!TEXT_EXTS.has(ext)) {
      setDocError(`暂不支持 .${ext || '?'} 格式（首版支持纯文本：txt / md / json / csv / 代码等）`)
      return
    }
    if (file.size > MAX_DOC_SIZE) {
      setDocError(`文件超过 ${MAX_DOC_SIZE / 1024 / 1024}MB，请换小一点的文件`)
      return
    }

    void (async () => {
      const text = await readTextFile(file)
      // 重复上传同名文件直接替换，避免同一文档塞两次
      setDocuments((prev) => {
        const rest = prev.filter((d) => d.name !== file.name)
        return [...rest, { name: file.name, content: text }]
      })
      setDocError('')
      // 若正在对话，立即注入并让 AI 简短确认；否则等「开始对话」时统一静默注入
      if (sessionRef.current?.isActive) {
        sessionRef.current.sendDocument(file.name, text)
      }
    })()
  }

  const removeDocument = (idx: number): void => {
    setDocuments((prev) => prev.filter((_, i) => i !== idx))
  }

  const generateNote = async (): Promise<void> => {
    if (!apiKey.trim()) {
      setNoteError('请先填写 API Key')
      return
    }
    const messages = transcript
      .filter((i) => i.text.trim())
      .map((i) => ({ role: i.role as 'user' | 'assistant', content: i.text }))
    if (messages.length === 0) {
      setNoteError('当前没有对话内容')
      return
    }
    setNoteState('generating')
    setNoteError('')
    setNoteSavedPath('')
    const res = await window.api.generateNotes({
      apiKey: apiKey.trim(),
      messages,
      documents: documents.length > 0 ? documents : undefined
    })
    if (res.ok) {
      setNoteMarkdown(res.content)
      setNoteState('preview')
    } else {
      setNoteError(res.error)
      setNoteState('idle')
    }
  }

  const saveNote = async (): Promise<void> => {
    setNoteState('saving')
    const res = await window.api.saveNote({
      content: noteMarkdown,
      defaultName: defaultNoteName()
    })
    if (res.ok) {
      setNoteSavedPath(res.path)
      setNoteState('idle')
    } else {
      setNoteError(res.error)
      setNoteState('preview')
    }
  }

  const closePreview = (): void => {
    setNoteState('idle')
    setNoteMarkdown('')
  }

  useEffect(() => {
    localStorage.setItem('ai_voice_note_theme', theme)
    // 主题类挂到 <html>（即 :root）上，让 body 等所有元素都能继承主题变量
    document.documentElement.className = `theme-${theme}`
  }, [theme])

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="logo">🎙</span>
          <span className="title">AI 语音对话笔记</span>
        </div>
        <div className="header-right">
          <span className={`phase-pill ${meta.cls}`}>
            <span className="phase-dot" />
            {meta.label}
          </span>
          <div className="theme-picker">
            {THEMES.map((t) => (
              <button
                key={t.key}
                className={`theme-dot theme-${t.key} ${theme === t.key ? 'selected' : ''}`}
                title={t.label}
                onClick={() => setTheme(t.key)}
              />
            ))}
          </div>
          <button className="ghost-btn" onClick={() => setShowLog((v) => !v)}>
            {showLog ? '隐藏日志' : '连接日志'}
          </button>
        </div>
      </header>

      <main className="main">
        {/* 设置区 */}
        <section className="card settings">
          <div className="row">
            <label className="field grow">
              <span className="field-label">阿里云百炼 API Key</span>
              <input
                type="password"
                value={apiKey}
                onChange={(e) => setApiKey(e.target.value)}
                placeholder="sk-..."
                spellCheck={false}
                disabled={active}
              />
            </label>
            <label className="field">
              <span className="field-label">模型</span>
              <select value={model} onChange={(e) => setModel(e.target.value)} disabled={active}>
                {MODELS.map((m) => (
                  <option key={m.value} value={m.value}>
                    {m.label}
                  </option>
                ))}
              </select>
            </label>
          </div>
          <div className="row">
            <label className="field">
              <span className="field-label">对话模式</span>
              <select
                value={mode}
                onChange={(e) => setMode(e.target.value as 'solo' | 'meeting')}
                disabled={active}
              >
                <option value="solo">单人对话</option>
                <option value="meeting">会议模式</option>
              </select>
            </label>
            {mode === 'meeting' && (
              <label className="field">
                <span className="field-label">唤醒词（点名时喊它）</span>
                <input
                  type="text"
                  value={wakeWord}
                  onChange={(e) => setWakeWord(e.target.value)}
                  placeholder="AI"
                  spellCheck={false}
                  disabled={active}
                />
              </label>
            )}
            {mode === 'meeting' && (
              <span className="mode-hint">会议中安静倾听，被点名（说「{wakeWord || 'AI'}」+问题）才发言</span>
            )}
          </div>
          <button className="link-btn" onClick={() => setShowAdvanced((v) => !v)}>
            {showAdvanced ? '收起' : '高级'}：WebSocket 地址
          </button>
          {showAdvanced && (
            <input
              className="advanced-url"
              type="text"
              value={urlOverride}
              onChange={(e) => setUrlOverride(e.target.value)}
              placeholder="留空使用默认: wss://dashscope.aliyuncs.com/api-ws/v1/realtime?model=..."
              spellCheck={false}
              disabled={active}
            />
          )}
        </section>

        {/* 对话区 */}
        <section className="card chat">
          <div className="chat-list">
            {transcript.length === 0 && (
              <div className="empty">
                <div className="empty-emoji">🗣️</div>
                <p>点下方按钮开始与 AI 对话</p>
                <p className="empty-hint">说话 → AI 回复 → 随时打断；也可以直接在输入框打字</p>
              </div>
            )}
            {transcript.map((item) => (
              <div key={item.id} className={`msg ${item.role}`}>
                <div className="msg-label">{item.role === 'user' ? '我' : 'AI'}</div>
                <div className={`msg-bubble ${item.final ? '' : 'streaming'}`}>
                  {item.doc ? (
                    <span className="doc-msg">📎 已上传：{item.doc.name}</span>
                  ) : (
                    item.text || (item.role === 'user' ? '…' : '')
                  )}
                </div>
              </div>
            ))}
          </div>

          {phaseDetail && <div className="phase-detail">{phaseDetail}</div>}

          {/* 已上传文档列表 */}
          {documents.length > 0 && (
            <div className="doc-list">
              {documents.map((d, i) => (
                <span key={i} className="doc-chip" title={d.name}>
                  📎 {d.name}
                  <button
                    className="doc-chip-remove"
                    onClick={() => removeDocument(i)}
                    title="移除文档（已注入会话的无法撤回）"
                  >
                    ✕
                  </button>
                </span>
              ))}
            </div>
          )}
          {docError && <div className="doc-error">{docError}</div>}

          {/* 文字输入 + 整理笔记 */}
          <div className="input-bar">
            <input
              ref={fileInputRef}
              type="file"
              className="hidden-file-input"
              onChange={(e) => handleFiles(e.target.files)}
              accept=".txt,.md,.markdown,.json,.csv,.log,.ini,.toml,.yaml,.yml,.js,.jsx,.ts,.tsx,.py,.java,.c,.cpp,.h,.hpp,.go,.rs,.html,.css,.xml,.sh,.bat,.ps1"
            />
            <button className="upload-btn" onClick={pickDocument} title="上传文档（txt/md/json/csv/代码等）">
              📎
            </button>
            <input
              className="text-input"
              type="text"
              value={textInput}
              onChange={(e) => setTextInput(e.target.value)}
              onKeyDown={onTextKeyDown}
              placeholder={active ? '输入文字，回车发送（AI 会以文字回复）' : '先开始对话，再输入文字'}
              disabled={!active}
              spellCheck={false}
            />
            <button className="send-btn" onClick={sendText} disabled={!canSendText}>
              发送
            </button>
            <button
              className="note-btn"
              onClick={() => void generateNote()}
              disabled={!canGenerateNote}
            >
              {noteState === 'generating' ? '整理中…' : '📝 整理笔记'}
            </button>
          </div>

          <div className="control">
            <button
              className={`mic-btn ${active ? 'active' : ''}`}
              onClick={onMainButton}
              title={active ? '结束对话' : '开始对话'}
            >
              <span className="mic-icon">{active ? '⏹' : '🎤'}</span>
              <span className="mic-text">{active ? '结束' : '开始对话'}</span>
            </button>
            <div className="control-hint">
              {active ? '再次点击即可结束 · AI 说话时直接开口即可打断' : '建议使用耳机测试回声效果'}
            </div>
          </div>

          {/* 笔记错误提示 */}
          {noteError && <div className="note-error">{noteError}</div>}
          {/* 保存成功提示 */}
          {noteSavedPath && (
            <div className="note-success">
              笔记已保存到：<span className="path">{noteSavedPath}</span>
            </div>
          )}

          {/* 笔记预览面板 */}
          {(noteState === 'preview' || noteState === 'saving') && (
            <div className="note-preview">
              <div className="note-preview-header">
                <span>笔记预览</span>
                <div>
                  <button className="ghost-btn" onClick={closePreview}>
                    关闭
                  </button>
                  <button
                    className="primary-btn"
                    onClick={() => void saveNote()}
                    disabled={noteState === 'saving'}
                  >
                    {noteState === 'saving' ? '保存中…' : '保存到文件'}
                  </button>
                </div>
              </div>
              <textarea
                className="note-preview-body"
                readOnly
                value={noteMarkdown}
                spellCheck={false}
              />
            </div>
          )}
        </section>

        {/* 日志区 */}
        {showLog && (
          <section className="card log" ref={logRef}>
            {logs.length === 0 ? (
              <div className="empty-hint">暂无日志</div>
            ) : (
              logs.map((line, i) => (
                <div key={i} className="log-line">
                  {line}
                </div>
              ))
            )}
          </section>
        )}
      </main>
    </div>
  )
}
