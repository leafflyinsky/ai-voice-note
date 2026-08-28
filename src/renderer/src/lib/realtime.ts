import { float32ToInt16Base64, int16Base64ToFloat32 } from '../audio/pcm'
import { createPlayer, startCapture } from '../audio/audio'
import type { PlayerHandle } from '../audio/audio'

export type SessionPhase =
  | 'idle' // 未连接
  | 'connecting' // 正在建立 WebSocket
  | 'listening' // 已就绪，聆听用户说话
  | 'speaking' // AI 正在回复
  | 'error' // 出错

export interface TranscriptItem {
  /** 稳定 id，供 React key 使用（消息可能被插入到中间，不能按下标复用）。 */
  id: number
  role: 'user' | 'assistant'
  text: string
  /** false = 仍在转写中/回复中，UI 显示闪烁光标。 */
  final: boolean
  /** 若为文档上传消息，附带文件名（UI 显示 📎 标记，不展示正文）。 */
  doc?: { name: string }
}

export interface RealtimeCallbacks {
  /** 会话状态变化。detail 附带说明文字。 */
  onPhase: (phase: SessionPhase, detail?: string) => void
  /** 对话记录变化（含正在转写/回复的未完成消息，顺序已由状态机保证）。 */
  onTranscript: (items: TranscriptItem[]) => void
  /** 追加一行连接/协议日志。 */
  onLog: (line: string) => void
}

export interface RealtimeOptions {
  apiKey: string
  model?: string
  url?: string
  /** 对话模式：'solo' 单人对话（默认，server_vad）；'meeting' 会议模式（smart_turn + 唤醒词）。 */
  mode?: 'solo' | 'meeting'
  /** 会议模式下唤醒 AI 的称呼，默认 'AI'。 */
  wakeWord?: string
}

let nextItemId = 0

/** 实时注入单份文档内容的字符上限（过长截断，避免撑爆实时模型上下文；完整内容仍会进笔记）。 */
const MAX_REALTIME_DOC_CHARS = 30000

function makeItem(
  role: 'user' | 'assistant',
  text: string,
  final: boolean,
  doc?: { name: string }
): TranscriptItem {
  return { id: nextItemId++, role, text, final, ...(doc ? { doc } : {}) }
}

/**
 * 实时语音会话客户端。
 * 连接和 WebSocket 收发都在主进程，本类通过 window.api 桥接，
 * 负责音频采集/播放、协议事件处理、状态与转写管理。
 *
 * 对话顺序模型（关键）：
 * - 服务端事件到达顺序不可靠——「用户语音转写完成」可能晚于「AI 开始回复」到达。
 * - 因此用户消息和 AI 消息都必须支持插入到正确位置，而不是只追加到末尾：
 *   - 用户消息插入时，若当前已有 AI 回复，则插到该 AI 回复之前；
 *   - AI 消息总是在用户消息之后追加。
 * - 正在转写的用户消息、正在回复的 AI 消息都以 final:false 存在于列表中，渲染顺序即语义顺序。
 */
export class RealtimeSession {
  private callbacks: RealtimeCallbacks
  private unsubscribers: Array<() => void> = []
  private capture: { stop: () => void } | null = null
  private player: PlayerHandle | null = null
  private phase: SessionPhase = 'idle'

  // 对话记录（有序）
  private items: TranscriptItem[] = []

  // 用户轮次状态
  private userTurnActive = false
  private pendingUserText = ''
  private userItemIndex: number | null = null

  // AI 回复状态
  private responseActive = false
  private aiItemIndex: number | null = null

  // 音频发送（100ms/块，节流推送）
  private sendQueue: Float32Array[] = []
  private sendTimer: number | null = null

  constructor(callbacks: RealtimeCallbacks) {
    this.callbacks = callbacks
  }

  get isActive(): boolean {
    return this.phase === 'listening' || this.phase === 'speaking'
  }

  async start(opts: RealtimeOptions): Promise<{ ok: true } | { ok: false; error: string }> {
    if (this.isActive || this.phase === 'connecting') {
      return { ok: false, error: '会话已在进行中' }
    }
    this.setPhase('connecting')
    this.resetConversationState()
    this.emitTranscript()

    const res = await window.api.connect({ apiKey: opts.apiKey, model: opts.model, url: opts.url })
    if (!res.ok) {
      this.setPhase('error', res.error)
      return res
    }

    // 注册事件监听
    this.unsubscribers.push(
      window.api.onMessage((m) => this.handleMessage(m)),
      window.api.onStatus((s) => this.handleStatus(s)),
      window.api.onError((e) => this.log(`[错误] ${e.message}`))
    )

    // 发送会话配置：按模式生成（solo=server_vad / meeting=smart_turn + 唤醒词）
    const sessionConfig = this.buildSessionConfig(opts)
    this.send({ type: 'session.update', session: sessionConfig })
    this.log(
      `已发送 session.update（${opts.mode === 'meeting' ? '会议模式 smart_turn' : '单人模式 server_vad'}）`
    )

    // 初始化播放器
    try {
      this.player = await createPlayer()
    } catch (e) {
      this.log(`播放器初始化失败: ${String(e)}`)
      this.player = null
    }

    // 启动麦克风采集
    try {
      this.capture = await startCapture((f32) => this.sendQueue.push(f32))
    } catch (e) {
      this.log(`麦克风启动失败: ${String(e)}`)
      this.stop()
      this.setPhase('error', '麦克风启动失败，请检查系统权限')
      return { ok: false, error: String(e) }
    }

    // 启动发送定时器（60ms 推一个块，平滑发送）
    this.sendTimer = window.setInterval(() => {
      const chunk = this.sendQueue.shift()
      if (chunk) {
        try {
          this.send({ type: 'input_audio_buffer.append', audio: float32ToInt16Base64(chunk) })
        } catch (e) {
          this.log(`音频发送失败: ${String(e)}`)
        }
      }
    }, 60)

    this.setPhase('listening', '可以开始说话了')
    this.log('链路就绪：麦克风 → Realtime API → 扬声器')
    return { ok: true }
  }

  /**
   * 在会话中发送一条文字消息，AI 以纯文字回复（不合成语音）。
   * 与语音输入共用同一会话上下文，可随时混用。
   */
  sendText(text: string): void {
    const t = text.trim()
    if (!t || !this.isActive) return

    // 若 AI 正在回复（语音播报），先打断
    if (this.responseActive) {
      this.send({ type: 'response.cancel' })
      this.player?.clear()
      this.finalizeAssistant()
    }
    this.commitPendingUser()

    // 本地插入用户文字消息
    this.items = [...this.items, makeItem('user', t, true)]
    this.emitTranscript()

    // 通过协议创建文本 item 并触发纯文本回复
    const itemEvent = {
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: t }]
      }
    }
    const createEvent = { type: 'response.create', response: { modalities: ['text', 'audio'] } }
    console.log('[sendText] responseActive =', this.responseActive)
    console.log('[sendText] send:', JSON.stringify(itemEvent))
    console.log('[sendText] send:', JSON.stringify(createEvent))
    this.send(itemEvent)
    this.send(createEvent)
    this.setPhase('speaking', 'AI 正在回复')
  }

  /**
   * 上传一份文档（纯文本内容）到会话上下文。
   * 文档作为 user 消息注入（带「已上传的文档资料」标记），并触发一次简短语音确认——
   * 提示 AI 只确认收到、不展开总结，等用户就文档提问再回答。
   * UI 上会多一条「📎 已上传：文件名」的用户消息。
   */
  sendDocument(name: string, content: string): void {
    if (!name || !this.isActive) return

    // 若 AI 正在回复，先打断
    if (this.responseActive) {
      this.send({ type: 'response.cancel' })
      this.player?.clear()
      this.finalizeAssistant()
    }
    this.commitPendingUser()

    // 本地插入文档消息（仅显示文件名，正文不进 UI）
    this.items = [...this.items, makeItem('user', '', true, { name })]
    this.emitTranscript()

    // 注入文档内容并触发简短确认
    this.send({
      type: 'conversation.item.create',
      item: {
        type: 'message',
        role: 'user',
        content: [{ type: 'input_text', text: this.buildDocumentPrompt(name, content) }]
      }
    })
    const createEvent = { type: 'response.create', response: { modalities: ['text', 'audio'] } }
    this.send(createEvent)
    this.setPhase('speaking', 'AI 正在回复')
  }

  /**
   * 会话建立后静默注入已上传的文档（不打断、不触发确认）。
   * 用于「重新开始对话」后保留文档上下文，AI 不因此发言，等用户提问。
   */
  injectDocuments(docs: Array<{ name: string; content: string }>): void {
    if (!this.isActive || docs.length === 0) return
    for (const d of docs) {
      this.send({
        type: 'conversation.item.create',
        item: {
          type: 'message',
          role: 'user',
          content: [{ type: 'input_text', text: this.buildDocumentPrompt(d.name, d.content) }]
        }
      })
    }
    this.log(`已注入 ${docs.length} 份文档到会话上下文`)
  }

  /** 生成注入上下文的文档文本：文件名 + 内容（过长截断）+ 对 AI 的指示。 */
  private buildDocumentPrompt(name: string, content: string): string {
    const truncated = content.length > MAX_REALTIME_DOC_CHARS
    const body = truncated ? content.slice(0, MAX_REALTIME_DOC_CHARS) : content
    return (
      `[上传的文档资料] 文件名: ${name}\n` +
      (truncated ? `（内容较长，仅注入前 ${MAX_REALTIME_DOC_CHARS} 字符）\n` : '') +
      `---\n${body}\n---\n` +
      '以上是用户上传的文档内容，作为后续讨论的参考资料。' +
      '若用户刚上传，只简单确认收到即可，不要展开总结；等用户就文档提问再回答。'
    )
  }

  async stop(): Promise<void> {
    this.stopSending()
    this.capture?.stop()
    this.capture = null
    this.player?.clear()
    this.player?.close()
    this.player = null
    window.api.disconnect()
    this.unsubscribers.forEach((u) => u())
    this.unsubscribers = []
    this.resetConversationState()
    this.setPhase('idle')
  }

  // ---------- 内部：音频 / 基础 ----------

  private send(payload: unknown): void {
    window.api.send(payload)
  }

  private stopSending(): void {
    if (this.sendTimer !== null) {
      clearInterval(this.sendTimer)
      this.sendTimer = null
    }
    this.sendQueue = []
  }

  private setPhase(p: SessionPhase, detail?: string): void {
    this.phase = p
    this.callbacks.onPhase(p, detail)
  }

  private log(line: string): void {
    this.callbacks.onLog(line)
  }

  private emitTranscript(): void {
    this.callbacks.onTranscript(this.items)
  }

  private resetConversationState(): void {
    this.items = []
    this.userTurnActive = false
    this.pendingUserText = ''
    this.userItemIndex = null
    this.responseActive = false
    this.aiItemIndex = null
  }

  /** 按模式生成 session.update 配置。 */
  private buildSessionConfig(opts: RealtimeOptions): Record<string, unknown> {
    const isMeeting = opts.mode === 'meeting'
    const wake = (opts.wakeWord || 'AI').trim()

    const base: Record<string, unknown> = {
      input_audio_format: 'pcm',
      output_audio_format: 'pcm',
      input_audio_sample_rate: 16000,
      output_audio_sample_rate: 24000,
      modalities: ['audio', 'text']
    }

    if (isMeeting) {
      return {
        ...base,
        instructions:
          `你是这场会议的参与者和顾问，角色名是「${wake}」。你必须遵守以下规则：` +
          `1) 保持安静，认真倾听会议中其他人说话，不要主动发言、不要插话。` +
          `2) 只有当你被明确点名或直接提问时（例如「${wake}，你觉得呢」「${wake}，你怎么看」` +
          `「请${wake}说说」「${wake}有补充吗」），你才发言。` +
          `3) 发言要简洁、口语化，直接给观点或建议，适合语音收听，不要客套。` +
          `4) 未被点名时，即便听到问题也不要回答，保持沉默。`,
        turn_detection: {
          type: 'smart_turn',
          threshold: 0.5,
          silence_duration_ms: 800,
          create_response: true
        }
      }
    }

    return {
      ...base,
      instructions:
        '你是一个语音对话笔记助手，用简洁自然的语言与用户讨论想法、梳理思路。回复保持口语化，适合语音收听。',
      turn_detection: {
        type: 'server_vad',
        threshold: 0.5,
        silence_duration_ms: 800,
        create_response: true
      }
    }
  }

  // ---------- 消息插入（核心顺序保证） ----------

  /** 把用户消息插入列表。若当前有 AI 回复，插到它之前；否则追加到末尾。 */
  private insertUserItem(text: string, final: boolean): void {
    const item = makeItem('user', text, final)
    const items = [...this.items]
    if (this.aiItemIndex != null) {
      items.splice(this.aiItemIndex, 0, item)
      this.aiItemIndex += 1
      this.userItemIndex = this.aiItemIndex - 1
    } else {
      items.push(item)
      this.userItemIndex = items.length - 1
    }
    this.items = items
    this.emitTranscript()
  }

  /** 把当前转写中的用户消息标记为已完成（若存在）。 */
  private finalizeUserItem(): void {
    if (this.userItemIndex == null) return
    const items = [...this.items]
    if (items[this.userItemIndex]?.role === 'user') {
      items[this.userItemIndex] = { ...items[this.userItemIndex], final: true }
      this.items = items
    }
    this.userItemIndex = null
    this.userTurnActive = false
    this.emitTranscript()
  }

  /** 落定挂起的用户消息（若正在转写且已有内容）。 */
  private commitPendingUser(): void {
    if (this.userItemIndex != null) {
      this.finalizeUserItem()
    }
  }

  /** 开启新一轮用户输入：结束旧的 AI 回复、落定旧轮次。 */
  private beginUserTurn(): void {
    this.finalizeAssistant()
    this.commitPendingUser()
    this.userTurnActive = true
    this.pendingUserText = ''
  }

  /** 新建 AI 回复消息（追加到末尾）。调用前已确保用户消息已落定。 */
  private beginAssistantResponse(): void {
    // 若已有活动的 AI 回复（如增量事件先于 response.created 到达），不重复创建
    if (this.responseActive && this.aiItemIndex != null) return
    this.commitPendingUser()
    const item = makeItem('assistant', '', false)
    this.items = [...this.items, item]
    this.aiItemIndex = this.items.length - 1
    this.responseActive = true
    this.emitTranscript()
  }

  /** 确保存在当前活动 AI 回复（AI 增量到达但 response.created 未处理时兜底）。 */
  private ensureActiveAssistant(): void {
    if (!this.responseActive) this.beginAssistantResponse()
  }

  /** 结束当前 AI 回复，标记 final。 */
  private finalizeAssistant(): void {
    if (!this.responseActive || this.aiItemIndex == null) return
    const items = [...this.items]
    if (items[this.aiItemIndex]?.role === 'assistant') {
      items[this.aiItemIndex] = { ...items[this.aiItemIndex], final: true }
      this.items = items
    }
    this.responseActive = false
    this.aiItemIndex = null
    this.emitTranscript()
  }

  /** 更新当前 AI 回复的文本（追加 delta 或整段替换）。 */
  private patchAssistant(text: string): void {
    if (this.aiItemIndex == null || this.items[this.aiItemIndex]?.role !== 'assistant') return
    const items = [...this.items]
    items[this.aiItemIndex] = { ...items[this.aiItemIndex], text }
    this.items = items
    this.emitTranscript()
  }

  // ---------- 事件处理 ----------

  private handleStatus(s: { status: string; detail?: string }): void {
    if (s.status === 'connected') {
      this.log('WebSocket 已连接')
    } else if (s.status === 'closed') {
      this.log(`[连接] ${s.detail ?? '已关闭'}`)
      if (this.isActive) this.setPhase('idle', '连接已断开')
    }
  }

  private handleMessage(m: { type: string; [key: string]: unknown }): void {
    const str = (v: unknown): string | null =>
      typeof v === 'string' && v.length > 0 ? v : null

    // 诊断：非 delta 刷屏事件打到 console（ELECTRON_ENABLE_LOGGING 下会进 stdout）
    if (
      m.type !== 'response.audio.delta' &&
      m.type !== 'response.output_audio_transcript.delta' &&
      m.type !== 'response.output_text.delta'
    ) {
      console.log('[recv]', JSON.stringify(m).slice(0, 400))
    }

    switch (m.type) {
      case 'session.created':
      case 'session.updated':
        break

      case 'session.failed':
        this.log(`[服务端] 会话失败: ${JSON.stringify(m.error ?? m)}`)
        break

      // 用户开始说话 —— 立即打断 AI 播放，开启新用户轮次
      case 'input_audio_buffer.speech_started':
        this.player?.clear()
        this.beginUserTurn()
        this.setPhase('listening', '聆听中（可打断）')
        break

      case 'input_audio_buffer.speech_stopped':
      case 'conversation.item.created':
      case 'input_audio_buffer.committed':
        break

      // 用户语音转写（增量 / 完成）
      case 'conversation.item.input_audio_transcription.delta': {
        const d = str(m.delta)
        if (d) {
          if (!this.userTurnActive) this.beginUserTurn()
          this.pendingUserText += d
          if (this.userItemIndex == null) {
            // 尚无用户消息在列表中：插入（AI 若已开始则插到其前）
            this.insertUserItem(this.pendingUserText, false)
          } else {
            const items = [...this.items]
            items[this.userItemIndex] = { ...items[this.userItemIndex], text: this.pendingUserText }
            this.items = items
            this.emitTranscript()
          }
        }
        break
      }
      case 'conversation.item.input_audio_transcription.completed': {
        const t = str(m.transcript)
        if (t) {
          this.pendingUserText = t
          this.userTurnActive = false
          if (this.userItemIndex == null) {
            this.insertUserItem(t, true)
          } else {
            const items = [...this.items]
            items[this.userItemIndex] = { ...items[this.userItemIndex], text: t, final: true }
            this.items = items
            this.userItemIndex = null
            this.emitTranscript()
          }
        } else {
          this.finalizeUserItem()
        }
        break
      }

      // AI 开始回复
      case 'response.created':
        // 上一回复应在 response.done/cancelled 时已 finalize，这里不再重复 finalize，
        // beginAssistantResponse 内部有 guard，避免增量先到时重复创建空消息
        this.beginAssistantResponse()
        this.setPhase('speaking', 'AI 正在回复')
        break

      // AI 文本增量（不同版本字段名不同，两个都兼容）
      case 'response.output_audio_transcript.delta':
      case 'response.audio_transcript.delta': {
        const d = str(m.delta)
        if (d) {
          this.ensureActiveAssistant()
          const cur = this.items[this.aiItemIndex!]
          this.patchAssistant((cur?.text ?? '') + d)
        }
        break
      }
      case 'response.output_audio_transcript.done':
      case 'response.audio_transcript.done': {
        const t = str(m.transcript)
        if (t) {
          this.ensureActiveAssistant()
          this.patchAssistant(t)
        }
        break
      }

      // AI 纯文字回复（sendText 触发，modalities=text 时走这些事件）
      case 'response.output_text.delta': {
        const d = str(m.delta)
        if (d) {
          this.ensureActiveAssistant()
          const cur = this.items[this.aiItemIndex!]
          this.patchAssistant((cur?.text ?? '') + d)
        }
        break
      }
      case 'response.output_text.done': {
        const t = str(m.text) ?? str(m.transcript)
        if (t) {
          this.ensureActiveAssistant()
          this.patchAssistant(t)
        }
        break
      }

      // AI 音频流（24kHz PCM Base64）
      case 'response.audio.delta': {
        this.ensureActiveAssistant()
        const b64 = str(m.delta)
        if (b64 && this.player) {
          try {
            this.player.push(int16Base64ToFloat32(b64))
          } catch (e) {
            this.log(`音频解码失败: ${String(e)}`)
          }
        }
        break
      }

      // AI 回复结束 / 被打断
      case 'response.done': {
        const t = str(m.transcript)
        if (t && this.aiItemIndex != null) this.patchAssistant(t)
        this.finalizeAssistant()
        this.setPhase('listening', '可以继续说，或点结束')
        break
      }
      case 'response.cancelled': {
        this.finalizeAssistant()
        this.setPhase('listening', '已打断，可以继续说')
        break
      }

      case 'error': {
        const e = m.error
        this.log(`[API错误] ${typeof e === 'string' ? e : JSON.stringify(e ?? m)}`)
        break
      }

      default:
        // 记录未知事件，便于排查协议字段差异
        if (m.type !== '__raw__') this.log(`[事件] ${m.type}`)
        break
    }
  }
}
