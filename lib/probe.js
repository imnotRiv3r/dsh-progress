/**
 * 总量探测：对单文件下载的 URL 发一次 HEAD，读 `content-length`。
 *
 * 有些下载器不报总量（`curl -s`、`wget --quiet`，或输出被管道吞掉），
 * 但只要目标是个普通 HTTP 文件，服务器通常会在 HEAD 里回答大小，
 * 于是条纹进度条就能变成真实百分比。探测失败一律当作「没有总量」。
 * @module dsh-progress/probe
 */
import http from 'node:http'
import https from 'node:https'

/** 跟随的重定向层数上限。 */
const MAX_REDIRECTS = 3

/**
 * 探测一个 URL 的内容长度。
 * @param url - HTTP(S) 地址。
 * @param options - 超时与剩余重定向次数。
 * @returns 字节数；不可得时为 `undefined`。
 */
export function probeContentLength(url, { timeoutMs = 3000, redirects = MAX_REDIRECTS } = {}) {
  return new Promise(resolve => {
    let target
    try {
      target = new URL(url)
    } catch {
      resolve(undefined)
      return
    }
    if (target.protocol !== 'http:' && target.protocol !== 'https:') {
      resolve(undefined)
      return
    }

    const client = target.protocol === 'https:' ? https : http
    const request = client.request(
      target,
      {
        method: 'HEAD',
        timeout: timeoutMs,
        headers: { 'user-agent': 'dsh-progress/0.1', accept: '*/*' },
      },
      response => {
        const status = response.statusCode ?? 0
        const location = response.headers.location
        if (status >= 300 && status < 400 && typeof location === 'string' && redirects > 0) {
          response.resume()
          let next
          try {
            next = new URL(location, target).toString()
          } catch {
            resolve(undefined)
            return
          }
          resolve(probeContentLength(next, { timeoutMs, redirects: redirects - 1 }))
          return
        }
        const raw = response.headers['content-length']
        const length = typeof raw === 'string' ? Number(raw) : Number.NaN
        response.resume()
        // 只有成功响应才是文件本体的长度；404 之类也有 content-length，但那是错误页。
        const ok = status >= 200 && status < 300
        resolve(ok && Number.isFinite(length) && length > 0 ? length : undefined)
      },
    )
    request.on('timeout', () => {
      request.destroy()
      resolve(undefined)
    })
    request.on('error', () => resolve(undefined))
    request.end()
  })
}
