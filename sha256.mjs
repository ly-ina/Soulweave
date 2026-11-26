// Soulweave · © 2026 ly-ina · 专有许可（见 LICENSE）
/**
 * sha256.mjs —— 零依赖 SHA-256（1.0 剥离 node:crypto 的替身）。
 *
 * 用法与原来完全一致：
 *   createHash('sha256').update(text, 'utf8').digest('hex')
 *   → sha256Hex(text)
 *
 * 只实现 sha256；其它算法显式报错，不假装支持。
 */

const K = new Uint32Array([
  0x428a2f98, 0x71374491, 0xb5c0fbcf, 0xe9b5dba5, 0x3956c25b, 0x59f111f1, 0x923f82a4, 0xab1c5ed5,
  0xd807aa98, 0x12835b01, 0x243185be, 0x550c7dc3, 0x72be5d74, 0x80deb1fe, 0x9bdc06a7, 0xc19bf174,
  0xe49b69c1, 0xefbe4786, 0x0fc19dc6, 0x240ca1cc, 0x2de92c6f, 0x4a7484aa, 0x5cb0a9dc, 0x76f988da,
  0x983e5152, 0xa831c66d, 0xb00327c8, 0xbf597fc7, 0xc6e00bf3, 0xd5a79147, 0x06ca6351, 0x14292967,
  0x27b70a85, 0x2e1b2138, 0x4d2c6dfc, 0x53380d13, 0x650a7354, 0x766a0abb, 0x81c2c92e, 0x92722c85,
  0xa2bfe8a1, 0xa81a664b, 0xc24b8b70, 0xc76c51a3, 0xd192e819, 0xd6990624, 0xf40e3585, 0x106aa070,
  0x19a4c116, 0x1e376c08, 0x2748774c, 0x34b0bcb5, 0x391c0cb3, 0x4ed8aa4a, 0x5b9cca4f, 0x682e6ff3,
  0x748f82ee, 0x78a5636f, 0x84c87814, 0x8cc70208, 0x90befffa, 0xa4506ceb, 0xbef9a3f7, 0xc67178f2,
])

const encoder = new TextEncoder()

function utf8Bytes(input) {
  if (input instanceof Uint8Array) return input
  return encoder.encode(String(input ?? ''))
}

function rotr(x, n) {
  return (x >>> n) | (x << (32 - n))
}

/** 对一段 bytes 求 sha256，返回 Uint8Array(32)。 */
export function sha256Bytes(input) {
  const msg = utf8Bytes(input)
  const bitLen = msg.length * 8
  // 补齐：0x80 + 0... + 8 字节大端长度，总长为 64 的倍数
  const padded = new Uint8Array((((msg.length + 8) >> 6) + 1) << 6)
  padded.set(msg)
  padded[msg.length] = 0x80
  const view = new DataView(padded.buffer)
  view.setUint32(padded.length - 8, Math.floor(bitLen / 0x100000000))
  view.setUint32(padded.length - 4, bitLen >>> 0)

  const H = new Uint32Array([
    0x6a09e667, 0xbb67ae85, 0x3c6ef372, 0xa54ff53a, 0x510e527f, 0x9b05688c, 0x1f83d9ab, 0x5be0cd19,
  ])
  const W = new Uint32Array(64)

  for (let off = 0; off < padded.length; off += 64) {
    for (let i = 0; i < 16; i++) W[i] = view.getUint32(off + i * 4)
    for (let i = 16; i < 64; i++) {
      const s0 = rotr(W[i - 15], 7) ^ rotr(W[i - 15], 18) ^ (W[i - 15] >>> 3)
      const s1 = rotr(W[i - 2], 17) ^ rotr(W[i - 2], 19) ^ (W[i - 2] >>> 10)
      W[i] = (W[i - 16] + s0 + W[i - 7] + s1) >>> 0
    }
    let a = H[0], b = H[1], c = H[2], d = H[3], e = H[4], f = H[5], g = H[6], h = H[7]
    for (let i = 0; i < 64; i++) {
      const S1 = rotr(e, 6) ^ rotr(e, 11) ^ rotr(e, 25)
      const ch = (e & f) ^ (~e & g)
      const t1 = (h + S1 + ch + K[i] + W[i]) >>> 0
      const S0 = rotr(a, 2) ^ rotr(a, 13) ^ rotr(a, 22)
      const maj = (a & b) ^ (a & c) ^ (b & c)
      const t2 = (S0 + maj) >>> 0
      h = g; g = f; f = e; e = (d + t1) >>> 0
      d = c; c = b; b = a; a = (t1 + t2) >>> 0
    }
    H[0] = (H[0] + a) >>> 0; H[1] = (H[1] + b) >>> 0
    H[2] = (H[2] + c) >>> 0; H[3] = (H[3] + d) >>> 0
    H[4] = (H[4] + e) >>> 0; H[5] = (H[5] + f) >>> 0
    H[6] = (H[6] + g) >>> 0; H[7] = (H[7] + h) >>> 0
  }

  const out = new Uint8Array(32)
  const oview = new DataView(out.buffer)
  for (let i = 0; i < 8; i++) oview.setUint32(i * 4, H[i])
  return out
}

export function sha256Hex(input) {
  const bytes = sha256Bytes(input)
  let hex = ''
  for (let i = 0; i < bytes.length; i++) hex += bytes[i].toString(16).padStart(2, '0')
  return hex
}

/**
 * 与 node:crypto 同形的最小门面：只支持 sha256，只支持同步 update/digest。
 * 这样调用点可以从 createHash('sha256').update(x,'utf8').digest('hex') 平滑替换。
 */
export function createHash(algorithm = 'sha256') {
  if (String(algorithm).toLowerCase() !== 'sha256') {
    throw new Error(`sha256.mjs 只实现 sha256，不支持：${algorithm}`)
  }
  const chunks = []
  return {
    update(data) { chunks.push(utf8Bytes(data)); return this },
    digest(encoding = 'hex') {
      const total = chunks.reduce((n, c) => n + c.length, 0)
      const merged = new Uint8Array(total)
      let at = 0
      for (const c of chunks) { merged.set(c, at); at += c.length }
      const out = sha256Bytes(merged)
      if (encoding === 'hex') {
        let hex = ''
        for (let i = 0; i < out.length; i++) hex += out[i].toString(16).padStart(2, '0')
        return hex
      }
      return out
    },
  }
}
