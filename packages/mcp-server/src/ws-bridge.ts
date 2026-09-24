/**
 * WebSocket Bridge - 与 Chrome Extension 通讯
 *
 * 支持多实例模式：
 * - 第一个实例启动 WebSocket 服务器 + HTTP API
 * - 后续实例通过 HTTP API 转发请求
 */
import { WebSocketServer, WebSocket } from 'ws'
import http from 'http'
import crypto from 'crypto'
import type { RequestMessage, ResponseMessage } from './types.js'

// WebSocket 状态常量 (readyState: 1 = OPEN)
const WS_OPEN = WebSocket.OPEN

export class ExtensionBridge {
  private wss: any = null
  private httpServer: http.Server | null = null
  // 多用户会话：token -> ws。''（无 token）与全局 token 连接归入 LEGACY 槽，
  // 兼容旧版扩展；新版扩展以每用户 token 连接，各自隔离
  private clients = new Map<string, any>()
  private static readonly LEGACY = '__legacy__'
  private isServerMode = false
  private pendingRequests = new Map<string, {
    resolve: (value: unknown) => void
    reject: (error: Error) => void
    timeout: NodeJS.Timeout
  }>()
  private requestTimeout = 360000 // 6 minutes (图片多时需要更长时间)
  private connectionResolvers: Array<() => void> = []

  // 安全验证 token（从环境变量读取，优先使用 WECHATSYNC_TOKEN）
  private token: string = process.env.WECHATSYNC_TOKEN || process.env.MCP_TOKEN || ''

  // 每用户 wsu token 的 HMAC 校验密钥（与后端 WS_TOKEN_SECRET 同源）；空则跳过校验（本地/CLI）
  private wsPepper: string = process.env.WS_TOKEN_SECRET || ''
  // /request 共享密钥强制开关（生产置 REQUIRE_BRIDGE_AUTH=1）
  private requireBridgeAuth: boolean = process.env.REQUIRE_BRIDGE_AUTH === '1'
  // legacy 槽开关（默认开，过渡期结束后置 ALLOW_LEGACY=0）
  private allowLegacy: boolean = process.env.ALLOW_LEGACY !== '0'
  private maxSessions: number = parseInt(process.env.MAX_SESSIONS || '50', 10)

  /**
   * 校验每用户 token：wsu-<uid>-<hmac_sha256(wsPepper, uid) 前 32 hex>
   */
  private isValidUserToken(t: string): boolean {
    const m = /^wsu-(\d{1,10})-([0-9a-f]{32})$/.exec(t)
    if (!m) return false
    const digest = crypto.createHmac('sha256', this.wsPepper)
      .update(m[1]).digest('hex').slice(0, 32)
    return digest === m[2]
  }

  // 是否静默模式（CLI 使用时不输出日志）
  private silent: boolean = false

  constructor(private port: number = 9527, options?: { silent?: boolean }) {
    this.silent = options?.silent ?? false
    if (!this.silent) {
      if (this.token) {
        console.error('[Bridge] Token authentication enabled')
      } else {
        console.error('[Bridge] Warning: MCP_TOKEN not set, requests may be rejected by extension')
      }
    }
  }

  /**
   * 启动服务 - 自动选择服务器模式或客户端模式
   */
  async start(): Promise<void> {
    try {
      await this.startServer()
      this.isServerMode = true
      if (!this.silent) console.error(`[Bridge] Running as PRIMARY (WebSocket: ${this.port}, HTTP: ${this.port + 1})`)
    } catch (error: unknown) {
      if ((error as NodeJS.ErrnoException).code === 'EADDRINUSE') {
        this.isServerMode = false
        if (!this.silent) console.error(`[Bridge] Running as SECONDARY (forwarding to localhost:${this.port + 1})`)
      } else {
        throw error
      }
    }
  }

  /**
   * 启动 WebSocket 服务器 + HTTP API
   */
  private startServer(): Promise<void> {
    return new Promise((resolve, reject) => {
      try {
        this.wss = new WebSocketServer({ port: this.port })

        this.wss.on('listening', () => {
          if (!this.silent) console.error(`[Bridge] WebSocket server listening on port ${this.port}`)
          // WebSocket 启动成功后，启动 HTTP API
          this.startHttpApi()
            .then(resolve)
            .catch(reject)
        })

        this.wss.on('connection', (ws: any, req: any) => {
          // 连接 URL 携带 ?token=<每用户 token>&v=<插件版本>；缺省或等于全局 token 归入 legacy 槽
          let presented = ''
          let pluginVersion = ''
          try {
            const q = new URL(req.url, 'http://localhost').searchParams
            presented = (q.get('token') || '').trim().slice(0, 128)
            // 版本号白名单校验（^数字.数字.数字$，最长 16 位）——Web 端版本门控数据源
            const rawV = (q.get('v') || '').trim()
            if (/^\d{1,4}\.\d{1,4}\.\d{1,4}$/.test(rawV)) pluginVersion = rawV.slice(0, 16)
          } catch { /* ignore */ }

          let slot: string
          if (!presented || presented === this.token) {
            if (!this.allowLegacy) {
              if (!this.silent) console.error('[Bridge] Rejected legacy connection (ALLOW_LEGACY=0)')
              ws.close(1008, 'legacy connections disabled')
              return
            }
            slot = ExtensionBridge.LEGACY
          } else {
            // 握手校验：伪造 token 不得占用槽位（匿名连接踢 legacy / 截取内容的攻击面）
            if (this.wsPepper && !this.isValidUserToken(presented)) {
              if (!this.silent) console.error('[Bridge] Rejected connection: invalid wsu token')
              ws.close(1008, 'invalid token')
              return
            }
            if (this.clients.size >= this.maxSessions && !this.clients.has(presented)) {
              if (!this.silent) console.error(`[Bridge] Rejected connection: session cap ${this.maxSessions}`)
              ws.close(1013, 'too many sessions')
              return
            }
            slot = presented
          }
          const stale = this.clients.get(slot)
          if (stale && stale !== ws && stale.readyState === WS_OPEN) {
            try { stale.close() } catch { /* ignore */ }
          }
          this.clients.set(slot, ws)
          ;(ws as any).pluginVersion = pluginVersion
          if (!this.silent) {
            console.error(`[Bridge] Extension connected (slot=${slot === ExtensionBridge.LEGACY ? 'legacy' : 'user'}, v=${pluginVersion || '?'}, sessions=${this.clients.size})`)
          }

          // 通知等待连接的 Promise
          for (const resolver of this.connectionResolvers) {
            resolver()
          }
          this.connectionResolvers = []

          ws.on('message', (data: any) => {
            this.handleMessage(ws, data.toString())
          })

          ws.on('close', () => {
            if (this.clients.get(slot) === ws) {
              this.clients.delete(slot)
              if (!this.silent) console.error(`[Bridge] Extension disconnected (slot=${slot === ExtensionBridge.LEGACY ? 'legacy' : 'user'}, sessions=${this.clients.size})`)
            }
          })

          ws.on('error', (error: Error) => {
            if (!this.silent) console.error('[Bridge] WebSocket error:', error)
          })
        })

        this.wss.on('error', (error: Error) => {
          reject(error)
        })
      } catch (error) {
        reject(error)
      }
    })
  }

  /**
   * 启动 HTTP API 服务器（供其他 MCP 实例调用）
   */
  private startHttpApi(): Promise<void> {
    return new Promise((resolve, reject) => {
      this.httpServer = http.createServer(async (req, res) => {
        // 无 CORS 头：本 API 仅服务端到服务端；浏览器跨域读取本就不该被允许
        // （注意 CORS 挡不住 simple request 的执行，真正的防线是下方共享密钥）
        if (req.method === 'POST' && req.url === '/request') {
          if (this.requireBridgeAuth && req.headers['x-bridge-token'] !== this.token) {
            res.writeHead(401, { 'Content-Type': 'application/json' })
            res.end(JSON.stringify({ error: 'unauthorized: X-Bridge-Token missing or invalid' }))
            return
          }
          let body = ''
          req.on('data', chunk => body += chunk)
          req.on('end', async () => {
            try {
              const { method, params, token } = JSON.parse(body)
              const result = await this.requestInternal(method, params, typeof token === 'string' ? token : undefined)
              res.writeHead(200, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ result }))
            } catch (error) {
              res.writeHead(500, { 'Content-Type': 'application/json' })
              res.end(JSON.stringify({ error: (error as Error).message }))
            }
          })
          return
        }

        if (req.method === 'GET' && req.url && req.url.split('?')[0] === '/status') {
          let perToken = ''
          try {
            perToken = (new URL(req.url, 'http://localhost').searchParams.get('token') || '').trim()
          } catch { /* ignore */ }
          res.writeHead(200, { 'Content-Type': 'application/json' })
          if (perToken) {
            const ws = this.clients.get(perToken)
            res.end(JSON.stringify({
              connected: !!ws && ws.readyState === WS_OPEN,
              version: (ws && ws.readyState === WS_OPEN && ws.pluginVersion) || null,
              mode: 'primary'
            }))
          } else {
            res.end(JSON.stringify({
              connected: this.isConnected(),
              sessions: this.clients.size,
              mode: 'primary'
            }))
          }
          return
        }

        res.writeHead(404)
        res.end('Not found')
      })

      const httpPort = this.port + 1
      this.httpServer.listen(httpPort, () => {
        if (!this.silent) console.error(`[Bridge] HTTP API listening on port ${httpPort}`)
        resolve()
      })

      this.httpServer.on('error', reject)
    })
  }

  /**
   * 停止服务器
   */
  stop(): void {
    if (this.wss) {
      this.wss.close()
      this.wss = null
    }
    if (this.httpServer) {
      this.httpServer.close()
      this.httpServer = null
    }
  }

  /**
   * 检查 Extension 是否已连接
   */
  /**
   * 获取当前运行模式
   */
  getMode(): 'primary' | 'secondary' {
    return this.isServerMode ? 'primary' : 'secondary'
  }

  /**
   * 检查 Extension 是否已连接（任一会话在线即 true）
   */
  isConnected(): boolean {
    if (this.isServerMode) {
      for (const ws of this.clients.values()) {
        if (ws.readyState === WS_OPEN) return true
      }
      return false
    } else {
      // SECONDARY 模式：无法同步检查，需要用 checkPrimaryHealth 异步验证
      return false
    }
  }

  /**
   * 等待 Extension 连接
   */
  waitForConnection(timeoutMs: number = 60000): Promise<void> {
    if (this.isServerMode) {
      // PRIMARY 模式：等待任一扩展 WebSocket 连接
      if (this.isConnected()) {
        return Promise.resolve()
      }

      return new Promise((resolve, reject) => {
        const timeout = setTimeout(() => {
          const index = this.connectionResolvers.indexOf(resolve)
          if (index > -1) {
            this.connectionResolvers.splice(index, 1)
          }
          reject(new Error('timeout'))
        }, timeoutMs)

        this.connectionResolvers.push(() => {
          clearTimeout(timeout)
          resolve()
        })
      })
    } else {
      // SECONDARY 模式：轮询 PRIMARY 健康状态，PRIMARY 消失则尝试接管
      return new Promise((resolve, reject) => {
        const startTime = Date.now()
        const pollInterval = 2000
        let primaryReachable = false
        let promoting = false

        const poll = async () => {
          if (Date.now() - startTime > timeoutMs) {
            if (!primaryReachable) {
              reject(new Error('timeout:unreachable'))
            } else {
              reject(new Error('timeout:no_extension'))
            }
            return
          }

          const health = await this.checkPrimaryHealth()
          if (health.connected) {
            resolve()
            return
          }

          if (health.error?.includes('not reachable') && !promoting) {
            // PRIMARY 不可达 — 尝试接管端口
            promoting = true
            const promoted = await this.tryPromote()
            if (promoted) {
              // 成功接管，等待 Extension 直连
              const remaining = timeoutMs - (Date.now() - startTime)
              if (remaining <= 0) {
                reject(new Error('timeout:no_extension'))
                return
              }

              if (this.isConnected()) {
                resolve()
                return
              }

              const promoteTimeout = setTimeout(() => {
                const index = this.connectionResolvers.indexOf(resolve)
                if (index > -1) this.connectionResolvers.splice(index, 1)
                reject(new Error('timeout:no_extension'))
              }, remaining)

              this.connectionResolvers.push(() => {
                clearTimeout(promoteTimeout)
                resolve()
              })
              return
            }
            // 接管失败，继续轮询
            promoting = false
          } else if (!health.error?.includes('not reachable')) {
            primaryReachable = true
          }

          setTimeout(poll, pollInterval)
        }

        poll()
      })
    }
  }

  /**
   * 检查 Primary 实例健康状态（Secondary 模式用）
   */
  private async checkPrimaryHealth(): Promise<{ connected: boolean; error?: string }> {
    return new Promise((resolve) => {
      const options = {
        hostname: 'localhost',
        port: this.port + 1,
        path: '/status',
        method: 'GET',
        timeout: 3000,
      }

      const req = http.request(options, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => {
          try {
            const status = JSON.parse(body)
            resolve({ connected: status.connected })
          } catch {
            resolve({ connected: false, error: 'Invalid response from primary' })
          }
        })
      })

      req.on('error', (error) => {
        resolve({ connected: false, error: `Primary not reachable: ${error.message}` })
      })

      req.on('timeout', () => {
        req.destroy()
        resolve({ connected: false, error: 'Primary health check timeout' })
      })

      req.end()
    })
  }

  /**
   * 发送请求到 Extension 并等待响应
   */
  async request<T = unknown>(method: string, params?: Record<string, unknown>, token?: string): Promise<T> {
    if (this.isServerMode) {
      return this.requestInternal<T>(method, params, token)
    } else {
      return this.requestViaSecondary<T>(method, params, token)
    }
  }

  /**
   * SECONDARY 模式请求（带重试 + 自动接管）
   */
  private async requestViaSecondary<T = unknown>(
    method: string,
    params?: Record<string, unknown>,
    token?: string,
    maxRetries: number = 3
  ): Promise<T> {
    let lastError: Error | null = null

    for (let attempt = 0; attempt <= maxRetries; attempt++) {
      // 如果已经升级为 PRIMARY，直接走 internal
      if (this.isServerMode) {
        return this.requestInternal<T>(method, params, token)
      }

      // 重试前等待（首次不等）
      if (attempt > 0) {
        const delay = Math.min(1000 * Math.pow(2, attempt - 1), 5000)
        if (!this.silent) console.error(`[Bridge] SECONDARY retry ${attempt}/${maxRetries} in ${delay}ms...`)
        await new Promise(resolve => setTimeout(resolve, delay))
      }

      // 检查 PRIMARY 健康状态
      const health = await this.checkPrimaryHealth()
      if (!health.connected) {
        if (health.error?.includes('not reachable')) {
          // PRIMARY 已退出，尝试接管
          if (!this.silent) console.error('[Bridge] PRIMARY gone during request, attempting takeover...')
          const promoted = await this.tryPromote()
          if (promoted) {
            // 等 Extension 重新连接（温热重连应该很快）
            if (!this.isConnected()) {
              if (!this.silent) console.error('[Bridge] Waiting for Extension to reconnect...')
              await this.waitForConnection(30000)
            }
            return this.requestInternal<T>(method, params, token)
          }
        }
        lastError = new Error(health.error || 'Primary instance not available.')
        continue
      }

      // 转发请求
      try {
        return await this.requestViaHttp<T>(method, params, token)
      } catch (error) {
        lastError = error as Error
      }
    }

    throw lastError!
  }

  /**
   * 尝试接管端口，升级为 PRIMARY
   */
  private async tryPromote(): Promise<boolean> {
    for (let i = 0; i < 5; i++) {
      try {
        await this.startServer()
        this.isServerMode = true
        if (!this.silent) console.error(`[Bridge] Promoted to PRIMARY (WebSocket: ${this.port}, HTTP: ${this.port + 1})`)
        return true
      } catch {
        await new Promise(r => setTimeout(r, 1000))
      }
    }
    return false
  }

  /**
   * 直接通过 WebSocket 发送请求（服务器模式）。
   * token 指定目标会话槽；缺省/全局 token → legacy 槽。
   * 下发消息携带该会话自己的 token（legacy 槽回全局 token），
   * 供插件端 mcpToken 校验——每用户会话因此互相隔离。
   */
  private async requestInternal<T = unknown>(method: string, params?: Record<string, unknown>, token?: string): Promise<T> {
    const slot = (!token || token === this.token) ? ExtensionBridge.LEGACY : token
    const ws = this.clients.get(slot)
    if (!ws || ws.readyState !== WS_OPEN) {
      throw new Error(
        slot === ExtensionBridge.LEGACY
          ? 'Extension not connected. Please ensure the Chrome extension is running.'
          : 'Extension not connected for this account (no bridge session). 请打开插件面板重连，或更新插件到 v2.7.7+'
      )
    }

    const echoToken = slot === ExtensionBridge.LEGACY ? this.token : slot
    const id = this.generateId()
    const message: RequestMessage = {
      id,
      method,
      token: echoToken,
      params
    }

    return new Promise((resolve, reject) => {
      const timeout = setTimeout(() => {
        this.pendingRequests.delete(id)
        reject(new Error(`Request timeout: ${method}`))
      }, this.requestTimeout)

      this.pendingRequests.set(id, { resolve: resolve as (value: unknown) => void, reject, timeout })

      ws.send(JSON.stringify(message))
    })
  }

  /**
   * 通过 HTTP API 转发请求（客户端模式）
   */
  private requestViaHttp<T = unknown>(method: string, params?: Record<string, unknown>, token?: string): Promise<T> {
    return new Promise((resolve, reject) => {
      const data = JSON.stringify({ method, params, token })
      const options = {
        hostname: 'localhost',
        port: this.port + 1,
        path: '/request',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Content-Length': Buffer.byteLength(data)
        }
      }

      const req = http.request(options, (res) => {
        let body = ''
        res.on('data', chunk => body += chunk)
        res.on('end', () => {
          try {
            const response = JSON.parse(body)
            if (response.error) {
              reject(new Error(response.error))
            } else {
              resolve(response.result)
            }
          } catch (error) {
            reject(new Error('Failed to parse response'))
          }
        })
      })

      req.on('error', (error) => {
        const hint = error.message.includes('ECONNREFUSED')
          ? ' (Is the primary MCP server running?)'
          : ''
        reject(new Error(`Failed to connect to primary MCP instance: ${error.message}${hint}`))
      })

      req.setTimeout(this.requestTimeout, () => {
        req.destroy()
        reject(new Error(`Request timeout: ${method}`))
      })

      req.write(data)
      req.end()
    })
  }

  /**
   * 处理来自 Extension 的消息（ws 为消息来源会话，ping 需原路回包）
   */
  private handleMessage(ws: any, data: string): void {
    try {
      const message = JSON.parse(data) as ResponseMessage & { method?: string }

      // 插件心跳：静默回 pong（保持双方 WS 活跃，无 pending 需求）
      if (message.method === 'ping') {
        try {
          if (ws.readyState === WS_OPEN) ws.send(JSON.stringify({ id: message.id, result: 'pong' }))
        } catch {
          // 发送失败说明连接将关闭，交给 close 事件处理
        }
        return
      }

      const pending = this.pendingRequests.get(message.id)
      if (!pending) {
        console.error('[Bridge] Unknown response id:', message.id)
        return
      }

      clearTimeout(pending.timeout)
      this.pendingRequests.delete(message.id)

      if (message.error) {
        pending.reject(new Error(message.error.message))
      } else {
        pending.resolve(message.result)
      }
    } catch (error) {
      console.error('[Bridge] Failed to parse message:', error)
    }
  }

  /**
   * 生成唯一 ID
   */
  private generateId(): string {
    return `${Date.now()}-${Math.random().toString(36).slice(2, 11)}`
  }

  // 分片上传配置
  private readonly CHUNK_SIZE = 512 * 1024  // 512KB per chunk
  private readonly CHUNK_THRESHOLD = 1024 * 1024  // 1MB threshold for chunking

  /**
   * 分片上传图片
   * 大于 1MB 的图片会自动分片上传
   */
  async uploadImageChunked(
    imageData: string,
    mimeType: string,
    platform: string = 'weibo'
  ): Promise<{ url: string; platform: string }> {
    // 小于阈值，直接上传
    if (imageData.length < this.CHUNK_THRESHOLD) {
      return this.request('uploadImage', { imageData, mimeType, platform })
    }

    // 大图片，分片上传
    const uploadId = this.generateId()
    const chunks: string[] = []

    // 分割 base64 数据
    for (let i = 0; i < imageData.length; i += this.CHUNK_SIZE) {
      chunks.push(imageData.slice(i, i + this.CHUNK_SIZE))
    }

    console.error(`[Bridge] Chunked upload: ${chunks.length} chunks, total size: ${imageData.length}`)

    // 1. 发送开始消息
    await this.request('uploadImage:start', {
      uploadId,
      totalChunks: chunks.length,
      mimeType,
      platform,
    })

    // 2. 逐个发送分片
    for (let i = 0; i < chunks.length; i++) {
      await this.request('uploadImage:chunk', {
        uploadId,
        chunkIndex: i,
        data: chunks[i],
      })
    }

    // 3. 发送完成消息并获取结果
    const result = await this.request<{ url: string; platform: string }>('uploadImage:complete', {
      uploadId,
    })

    return result
  }
}
