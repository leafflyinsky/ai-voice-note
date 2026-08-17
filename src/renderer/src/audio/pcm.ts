// Int16 PCM <-> Base64 编解码（渲染进程，Chromium 内置 btoa/atob）

export function float32ToInt16Base64(f32: Float32Array): string {
  const i16 = new Int16Array(f32.length)
  for (let i = 0; i < f32.length; i++) {
    const s = Math.max(-1, Math.min(1, f32[i]))
    i16[i] = s < 0 ? s * 0x8000 : s * 0x7fff
  }
  return base64FromBytes(new Uint8Array(i16.buffer))
}

export function int16Base64ToFloat32(b64: string): Float32Array {
  const bytes = bytesFromBase64(b64)
  const len = Math.floor(bytes.byteLength / 2)
  const i16 = new Int16Array(bytes.buffer, bytes.byteOffset, len)
  const f32 = new Float32Array(len)
  for (let i = 0; i < len; i++) f32[i] = i16[i] / 32768
  return f32
}

function base64FromBytes(bytes: Uint8Array): string {
  let binary = ''
  // 分块拼接，避免 String.fromCharCode.apply 超参数上限
  const CHUNK = 0x8000
  for (let i = 0; i < bytes.length; i += CHUNK) {
    binary += String.fromCharCode(...bytes.subarray(i, i + CHUNK))
  }
  return btoa(binary)
}

function bytesFromBase64(b64: string): Uint8Array {
  const binary = atob(b64)
  const bytes = new Uint8Array(binary.length)
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
  return bytes
}
