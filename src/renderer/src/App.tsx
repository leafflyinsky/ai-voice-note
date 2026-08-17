import { useCallback, useEffect, useRef, useState } from 'react'
import { RealtimeSession } from './lib/realtime'
import type { SessionPhase, TranscriptItem } from './lib/realtime'

const MODELS = [
  { value: 'qwen-audio-3.0-realtime-plus', label: 'qwen-audio-3.0-realtime-plus' },
  { value: 'qwen-audio-3.0-realtime-flash', label: 'qwen-audio-3.0-realtime-flash' }
]

const PHASE_META: Record<SessionPhase, { label: string; cls: string }> = {
  idle: { label: '未连接', cls: 'phase-idle' },
  connecting: { label: '连接中…', cls: 'phase-connecting' },
  listening: { label: '聆听中', cls: 'phase-listening' },
  speaking: { label: 'AI 说话中', cls: 'phase-speaking' },
  error: { label: '出错', cls: 'phase-error' }
}

type NoteState = 'idle' | 'generating' | 'preview' | 'saving'

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

  const [phase, setPhase] = useState<SessionPhase>('idle')
  const [phaseDetail, setPhaseDetail] = useState('')
  const [transcript, setTranscript] = useState<TranscriptItem[]>([])
  const [logs, setLogs] = useState<string[]>([])
  const [showLog, setShowLog] = useState(false)

  // 文字输入
  const [textInput, setTextInput] = useState('')

  // 笔记整理
  const [noteState, setNoteState] = useState<NoteState>('idle')
  const [noteMarkdown, setNoteMarkdown] = useState('')
  const [noteError, setNoteError] = useState('')
  const [noteSavedPath, setNoteSavedPath] = useState('')

  const sessionRef = useRef<RealtimeSession | null>(null)
  const logRef = useRef<HTMLDivElement | null>(null)

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
    const session = getSession()
    const res = await session.start({
      apiKey: apiKey.trim(),
      model,
      url: urlOverride.trim() || undefined
    })
    if (!res.ok) setPhaseDetail(res.error)
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
    const res = await window.api.generateNotes({ apiKey: apiKey.trim(), messages })
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

  return (
    <div className="app">
      <header className="header">
        <div className="header-left">
          <span className="logo">🎙</span>
          <span className="title">AI 语音对话笔记</span>
          <span className="badge">阶段0 demo</span>
        </div>
        <div className="header-right">
          <span className={`phase-pill ${meta.cls}`}>
            <span className="phase-dot" />
            {meta.label}
          </span>
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
                  {item.text || (item.role === 'user' ? '…' : '')}
                </div>
              </div>
            ))}
          </div>

          {phaseDetail && <div className="phase-detail">{phaseDetail}</div>}

          {/* 文字输入 + 整理笔记 */}
          <div className="input-bar">
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
