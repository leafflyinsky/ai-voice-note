import { CAPTURE_WORKLET_CODE, PLAYER_WORKLET_CODE } from './worklets'

async function loadWorklet(ctx: AudioContext, code: string): Promise<void> {
  const blob = new Blob([code], { type: 'application/javascript' })
  const url = URL.createObjectURL(blob)
  try {
    await ctx.audioWorklet.addModule(url)
  } finally {
    URL.revokeObjectURL(url)
  }
}

// ---------- 麦克风采集（16kHz 单声道） ----------

export interface CaptureHandle {
  stop: () => void
}

/**
 * 打开麦克风并采集 16kHz 音频。
 * 用 AudioContext({ sampleRate: 16000 }) 让 Chromium 自动重采样，
 * 不依赖设备原生采样率。onChunk 每 ~100ms 收到一个 Float32 块。
 */
export async function startCapture(onChunk: (f32: Float32Array) => void): Promise<CaptureHandle> {
  const stream = await navigator.mediaDevices.getUserMedia({
    audio: {
      channelCount: 1,
      echoCancellation: true,
      noiseSuppression: true,
      autoGainControl: true
    }
  })

  const ctx = new AudioContext({ sampleRate: 16000 })
  await ctx.resume()
  await loadWorklet(ctx, CAPTURE_WORKLET_CODE)

  const src = ctx.createMediaStreamSource(stream)
  const node = new AudioWorkletNode(ctx, 'pcm-capture-processor')
  node.port.onmessage = (e) => {
    if (e.data instanceof Float32Array) onChunk(e.data)
  }
  src.connect(node)
  node.connect(ctx.destination) // 保持渲染图活跃；处理器不写输出，扬声器无声

  let stopped = false
  return {
    stop: () => {
      if (stopped) return
      stopped = true
      src.disconnect()
      node.disconnect()
      stream.getTracks().forEach((t) => t.stop())
      void ctx.close()
    }
  }
}

// ---------- AI 回复播放（24kHz 队列播放） ----------

export interface PlayerHandle {
  push: (f32: Float32Array) => void
  clear: () => void
  close: () => void
}

/** 创建 24kHz 输出播放器。push 流式追加，clear 立即静音（打断）。 */
export async function createPlayer(): Promise<PlayerHandle> {
  const ctx = new AudioContext({ sampleRate: 24000 })
  await ctx.resume()
  await loadWorklet(ctx, PLAYER_WORKLET_CODE)

  const node = new AudioWorkletNode(ctx, 'pcm-player-processor')
  node.connect(ctx.destination)

  return {
    push: (f32) => node.port.postMessage(f32),
    clear: () => node.port.postMessage('clear'),
    close: () => {
      try {
        void ctx.close()
      } catch {
        /* ignore */
      }
    }
  }
}
