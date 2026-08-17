// AudioWorklet 处理器代码以字符串形式定义，通过 Blob URL 加载，
// 绕开 Vite 对 worker 的打包处理（开发 / 生产构建都能直接用）。

// 采集处理器：跑在 AudioContext({ sampleRate: 16000 }) 里，
// 把 Float32 输入按 100ms（1600 帧）打包 postMessage 到主线程。
export const CAPTURE_WORKLET_CODE = `
const BUFFER_FRAMES = 1600 // 100ms @ 16kHz

class CaptureProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._buffer = new Float32Array(BUFFER_FRAMES)
    this._len = 0
  }

  process(inputs) {
    const ch = inputs[0] && inputs[0][0]
    if (ch) {
      for (let i = 0; i < ch.length; i++) {
        this._buffer[this._len++] = ch[i]
        if (this._len === BUFFER_FRAMES) {
          this.port.postMessage(this._buffer.slice())
          this._len = 0
        }
      }
    }
    return true
  }
}

registerProcessor('pcm-capture-processor', CaptureProcessor)
`

// 播放处理器：跑在 AudioContext({ sampleRate: 24000 }) 里，
// 主线程 push Float32 块到队列，process 里平滑取出播放；
// 收到 'clear' 清空队列（打断时用），未满部分补零避免爆音。
export const PLAYER_WORKLET_CODE = `
class PCMPlayerProcessor extends AudioWorkletProcessor {
  constructor() {
    super()
    this._queue = []
    this.port.onmessage = (e) => {
      const data = e.data
      if (data === 'clear') {
        this._queue.length = 0
      } else if (data instanceof Float32Array) {
        this._queue.push(data)
      }
    }
  }

  process(_inputs, outputs) {
    const out = outputs[0] && outputs[0][0]
    if (!out) return true
    let w = 0
    while (w < out.length && this._queue.length > 0) {
      const buf = this._queue[0]
      const n = Math.min(buf.length, out.length - w)
      for (let i = 0; i < n; i++) out[w + i] = buf[i]
      if (n < buf.length) this._queue[0] = buf.slice(n)
      else this._queue.shift()
      w += n
    }
    for (let i = w; i < out.length; i++) out[i] = 0
    return true
  }
}

registerProcessor('pcm-player-processor', PCMPlayerProcessor)
`
