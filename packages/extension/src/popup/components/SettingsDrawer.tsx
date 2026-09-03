import { useState, useEffect, useRef } from 'react'
import { X, Plug, PlugZap, Plus, Trash2, ChevronRight } from 'lucide-react'
import { cn } from '@/lib/utils'
import { trackFeatureDiscovery } from '../../lib/analytics'

interface SettingsDrawerProps {
  open: boolean
  onClose: () => void
}

interface McpStatus {
  enabled: boolean
  connected: boolean
  token?: string
  serverUrl?: string
}

interface CMSAccount {
  id: string
  name: string
  type: string
  url: string
}

export function SettingsDrawer({ open, onClose }: SettingsDrawerProps) {
  const [mcpStatus, setMcpStatus] = useState<McpStatus>({ enabled: false, connected: false })
  const [cmsAccounts, setCmsAccounts] = useState<CMSAccount[]>([])
  const [loading, setLoading] = useState(false)
  const [floatingButtonEnabled, setFloatingButtonEnabled] = useState(false)
  const [serverUrlInput, setServerUrlInput] = useState('')
  const [miaobiBusy, setMiaobiBusy] = useState(false)
  const [miaobiMsg, setMiaobiMsg] = useState('')
  const [miaobiUser, setMiaobiUser] = useState('')
  const [miaobiPass, setMiaobiPass] = useState('')
  const [miaobiAccount, setMiaobiAccount] = useState<string | null>(null)
  const [platforms, setPlatforms] = useState<{ id: string; name: string; isAuthenticated: boolean; username?: string }[]>([])
  const [cookiePlatforms, setCookiePlatforms] = useState<{ id: string; name: string; isAuthenticated: boolean }[]>([])
  const [syncedIds, setSyncedIds] = useState<Set<string>>(new Set())
  const [verifying, setVerifying] = useState(false)

  const L2_IDS = ['xiaohongshu', 'zhihu', 'x', 'weibo', 'douyin']

  const renderPlatChip = (p: { id: string; name: string; isAuthenticated: boolean; username?: string }) => (
    <span
      key={p.id}
      className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full border text-[11px]"
      style={{
        borderColor: p.isAuthenticated ? 'hsl(var(--pine) / .4)' : 'hsl(var(--border))',
        color: p.isAuthenticated ? 'hsl(var(--pine))' : 'hsl(var(--muted-foreground))',
        background: p.isAuthenticated ? 'hsl(var(--pine) / .07)' : 'transparent',
      }}
      title={p.isAuthenticated ? `已登录${p.username ? `：${p.username}` : ''}` : '未登录——浏览器访问该平台官网登录后自动亮起'}
    >
      <span
        style={{
          width: 6, height: 6, borderRadius: '50%',
          background: p.isAuthenticated ? 'hsl(var(--pine))' : 'hsl(var(--muted-foreground) / .4)',
          display: 'inline-block',
        }}
      />
      {p.name}
      {syncedIds.has(p.id) && (
        <span style={{ fontSize: 9, fontWeight: 600, marginLeft: 2, opacity: 0.8 }}>↺</span>
      )}
    </span>
  )
  const serverUrlTimer = useRef<ReturnType<typeof setTimeout> | null>(null)

  const MIAOBI_API = 'https://mp.aibolt.tech'
  const MIAOBI_WS = 'wss://mp.aibolt.tech/ws-bridge'

  // 全角转半角（＠→@ 等）并去空格，避免中文输入法导致的登录失败
  const normalizeInput = (s: string) => s.normalize('NFKC').trim()

  const handleMiaobiSetup = async () => {
    const username = normalizeInput(miaobiUser)
    if (!username) return setMiaobiMsg('请输入用户名')
    const password = normalizeInput(miaobiPass)
    if (!password) return setMiaobiMsg('请输入密码')
    setMiaobiBusy(true)
    setMiaobiMsg('正在登录妙笔…')
    try {
      const loginResp = await fetch(`${MIAOBI_API}/api/auth/login`, {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify({ username, password }),
      })
      if (!loginResp.ok) {
        const err = await loginResp.json().catch(() => ({} as { detail?: string }))
        throw new Error(err.detail || `登录失败 (${loginResp.status})`)
      }
      const { access_token } = (await loginResp.json()) as { access_token: string }
      await chrome.storage.local.set({ miaobiToken: access_token })
      setMiaobiMsg('正在获取同步配置…')
      const tokenResp = await fetch(`${MIAOBI_API}/api/wechatsync/token`, {
        headers: { Authorization: `Bearer ${access_token}` },
      })
      if (!tokenResp.ok) throw new Error(`获取配置失败 (${tokenResp.status})`)
      const { token: bridgeToken } = (await tokenResp.json()) as { token: string }
      await chrome.storage.local.set({
        mcpEnabled: true,
        mcpToken: bridgeToken,
        mcpServerUrl: MIAOBI_WS,
      })
      await chrome.storage.local.set({ miaobiUser: username })
      setMiaobiPass('')
      setMiaobiAccount(username)
      setMiaobiMsg('配置成功，扩展重启中…')
      setTimeout(() => chrome.runtime.reload(), 800)
    } catch (e) {
      setMiaobiMsg(`配置失败: ${(e as Error).message}`)
    } finally {
      setMiaobiBusy(false)
    }
  }



  // 获取状态
  useEffect(() => {
    if (!open) return

    // MCP 状态
    chrome.runtime.sendMessage({ type: 'MCP_STATUS' }, (response) => {
      if (response && !response.error) {
        setMcpStatus({
          enabled: response.enabled ?? false,
          connected: response.connected ?? false,
          token: response.token,
          serverUrl: response.serverUrl,
        })
        setServerUrlInput(response.serverUrl || '')
      }
    })

    // CMS 账户
    chrome.storage.local.get('cmsAccounts', (result) => {
      setCmsAccounts(result.cmsAccounts || [])
    })

    // 悬浮按钮设置
    chrome.storage.local.get('floatingButtonEnabled', (result) => {
      setFloatingButtonEnabled(result.floatingButtonEnabled ?? false)
    })

    // 平台登录状态——统一 Cookie 域名探测（全平台一把查，零请求）
    const DOMAIN_NAMES: Record<string, string> = {
      weixin: '微信公众号', toutiao: '今日头条', csdn: 'CSDN', zhihu: '知乎',
      juejin: '掘金', bilibili: 'B站专栏', weibo: '微博', baijiahao: '百家号',
      cnblogs: '博客园', cto51: '51CTO', douban: '豆瓣', eastmoney: '东方财富',
      imooc: '慕课网', oschina: '开源中国', segmentfault: '思否', sohu: '搜狐号',
      woshipm: '人人都是产品经理', xueqiu: '雪球', yuque: '语雀',
      douyin: '抖音', xiaohongshu: '小红书', x: 'X / Twitter',
    }
    const DOMAIN_MAP: Record<string, string> = {
      weixin: 'mp.weixin.qq.com',
      toutiao: '.toutiao.com',
      csdn: '.csdn.net',
      zhihu: '.zhihu.com',
      juejin: '.juejin.cn',
      bilibili: '.bilibili.com',
      weibo: '.weibo.com',
      baijiahao: 'baijiahao.baidu.com',
      cnblogs: '.cnblogs.com',
      cto51: '.51cto.com',
      douban: '.douban.com',
      eastmoney: '.eastmoney.com',
      imooc: '.imooc.com',
      oschina: '.oschina.net',
      segmentfault: '.segmentfault.com',
      sohu: '.sohu.com',
      woshipm: '.woshipm.com',
      xueqiu: '.xueqiu.com',
      yuque: '.yuque.com',
      douyin: '.douyin.com',
      xiaohongshu: '.xiaohongshu.com',
      x: '.x.com',
    }
    ;(async () => {
      // Phase 1：Cookie 探测 → 秒出首屏
      const results = await Promise.all(
        Object.entries(DOMAIN_MAP).map(async ([id, domain]) => {
          const cookies = await chrome.cookies.getAll({ domain })
          const authenticated = cookies.some(c => c.value.length > 20)
          return { id, isAuthenticated: authenticated }
        })
      )
      setPlatforms(results.map(cr => ({ ...cr, name: DOMAIN_NAMES[cr.id] || cr.id })))
      setVerifying(true)

      // Phase 2：适配器逐平台真实验证 → 过期 Cookie 自动变灰
      chrome.runtime.sendMessage({ type: 'CHECK_ALL_AUTH' }, (r) => {
        const adapterPlatforms = (r && !r.error ? r.platforms : []) as { id: string; name: string; isAuthenticated: boolean }[]
        const verified = results.map(cr => {
          const adapter = adapterPlatforms.find(ap => ap.id === cr.id)
          return {
            id: cr.id,
            name: adapter?.name || DOMAIN_NAMES[cr.id] || cr.id,
            // 适配器是权威：有适配器的平台以适配器判定为准（覆盖 Cookie 假阳性）
            // 无适配器的平台（如头条）保留 Cookie 判定
            isAuthenticated: adapter ? adapter.isAuthenticated : cr.isAuthenticated,
          }
        })
        adapterPlatforms.forEach(ap => {
          if (!DOMAIN_MAP[ap.id] && !verified.find(m => m.id === ap.id)) {
            verified.push({ id: ap.id, name: ap.name, isAuthenticated: ap.isAuthenticated })
          }
        })
        setPlatforms(verified)
        setVerifying(false)

        // 微信/头条已登录 → 自动同步 Cookie 到服务器（仅在验证通过后）
        autoSyncServerCookies(verified)
      })
    })()

    const autoSyncServerCookies = async (plats: { id: string; name: string; isAuthenticated: boolean }[]) => {
      const ids = ['weixin', 'toutiao']
      const toSync = plats.filter(m => ids.includes(m.id) && m.isAuthenticated)
      if (!toSync.length) return
      const { miaobiToken } = await chrome.storage.local.get('miaobiToken')
      if (!miaobiToken) return
      const synced = new Set<string>()
      for (const plat of toSync) {
        const domain = plat.id === 'weixin' ? 'mp.weixin.qq.com' : '.toutiao.com'
        try {
          const cookies = await chrome.cookies.getAll({ domain })
          const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
          if (cookieStr.length < 50) continue
          const resp = await fetch(`${MIAOBI_API}/api/accounts/sync-cookie`, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${miaobiToken}` },
            body: JSON.stringify({ platform: plat.id === 'weixin' ? 'wechat' : 'toutiao', cookies: cookieStr }),
          })
          if (resp.ok) synced.add(plat.id)
        } catch { /* 静默 */ }
      }
      if (synced.size) setSyncedIds(synced)
    }

    // 妙笔登录态探测
    chrome.storage.local.get('miaobiToken', async ({ miaobiToken }) => {
      if (!miaobiToken) { setMiaobiAccount(null); return }
      try {
        const r = await fetch(`${MIAOBI_API}/api/auth/me`, { headers: { Authorization: `Bearer ${miaobiToken}` } })
        if (r.ok) {
          const me = await r.json()
          setMiaobiAccount(me.username || '已登录')
          chrome.storage.local.set({ miaobiUser: me.username || '' })
        } else {
          setMiaobiAccount(null)
          setMiaobiMsg('登录已过期，请重新登录')
        }
      } catch { setMiaobiAccount('已登录') }
    })
  }, [open])

  // MCP 状态轮询 + 通知 background 加速重连
  useEffect(() => {
    if (!open || !mcpStatus.enabled) return

    // 通知 background：用户正在关注，加速重连
    chrome.runtime.sendMessage({ type: 'MCP_WATCH_START' })

    const interval = setInterval(() => {
      chrome.runtime.sendMessage({ type: 'MCP_STATUS' }, (response) => {
        if (response && !response.error) {
          setMcpStatus(prev => ({ ...prev, connected: response.connected ?? false }))
        }
      })
    }, 3000)

    return () => {
      clearInterval(interval)
      // 设置页关闭，恢复正常重连策略
      chrome.runtime.sendMessage({ type: 'MCP_WATCH_STOP' })
    }
  }, [open, mcpStatus.enabled])

  // 切换 MCP
  const toggleMcp = async () => {
    setLoading(true)
    const action = mcpStatus.enabled ? 'MCP_DISABLE' : 'MCP_ENABLE'

    // 追踪 MCP 功能发现
    if (!mcpStatus.enabled) {
      trackFeatureDiscovery('mcp', 'settings').catch(() => {})
    }

    chrome.runtime.sendMessage({ type: action }, (response) => {
      setLoading(false)
      if (response?.success) {
        setMcpStatus(prev => ({
          ...prev,
          enabled: !prev.enabled,
          connected: false,
          token: response.token,  // 保存返回的 token
        }))
      }
    })
  }

  // 服务器地址变更（防抖 800ms）
  const handleServerUrlChange = (value: string) => {
    setServerUrlInput(value)
    if (serverUrlTimer.current) {
      clearTimeout(serverUrlTimer.current)
    }
    serverUrlTimer.current = setTimeout(() => {
      chrome.runtime.sendMessage({
        type: 'MCP_SET_SERVER_URL',
        payload: { url: value.trim() },
      })
      setMcpStatus(prev => ({ ...prev, serverUrl: value.trim() }))
    }, 800)
  }

  // 切换悬浮按钮
  const toggleFloatingButton = () => {
    const next = !floatingButtonEnabled
    setFloatingButtonEnabled(next)
    chrome.storage.local.set({ floatingButtonEnabled: next })
  }

  // 删除 CMS 账户
  const deleteCmsAccount = async (id: string) => {
    // 直接从 storage 读取最新数据，避免多窗口操作时覆盖
    const storage = await chrome.storage.local.get('cmsAccounts')
    const accounts: CMSAccount[] = storage.cmsAccounts || []
    const updated = accounts.filter(a => a.id !== id)
    await chrome.storage.local.set({ cmsAccounts: updated })
    await chrome.storage.local.remove(`cms_pwd_${id}`)
    setCmsAccounts(updated)
  }

  if (!open) return null

  return (
    <>
      {/* 遮罩（仅 open 时渲染） */}
      {open && (
        <div
          className="fixed inset-0 bg-black/50 z-40"
          onClick={onClose}
        />
      )}

      {/* 抽屉 */}
      <div className={cn(
        'fixed inset-y-0 right-0 w-80 bg-background z-50 shadow-xl',
        'transform transition-transform duration-200',
        open ? 'translate-x-0' : 'translate-x-full'
      )}>
        {/* 头部 */}
        <div className="flex items-center justify-between p-4 border-b">
          <h2 className="font-semibold" style={{ fontFamily: '"Noto Serif SC","Songti SC",serif', letterSpacing: 2 }}>设置</h2>
          <button
            onClick={onClose}
            className="p-1 rounded hover:bg-muted"
          >
            <X className="w-5 h-5" />
          </button>
        </div>

        {/* 内容 */}
        <div className="p-4 space-y-6 overflow-y-auto h-[calc(100%-57px)]">
          {/* 同步桥接设置 */}
          <div className="space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground">同步桥接</h3>

            <div className="flex items-center justify-between p-3 border rounded-lg bg-card">
              <div className="flex items-center gap-2">
                {mcpStatus.connected ? (
                  <PlugZap className="w-5 h-5 text-green-500" />
                ) : (
                  <Plug className="w-5 h-5 text-muted-foreground" />
                )}
                <div>
                  <p className="text-sm font-medium">CLI / MCP 连接</p>
                  <p className="text-xs text-muted-foreground">
                    {mcpStatus.enabled
                      ? mcpStatus.connected
                        ? '已连接'
                        : '等待连接...'
                      : '未启用'}
                  </p>
                </div>
              </div>
              <button
                onClick={toggleMcp}
                disabled={loading}
                className={cn(
                  'relative w-11 h-6 rounded-full transition-colors shrink-0',
                  mcpStatus.enabled ? 'bg-primary' : 'bg-muted-foreground/30',
                  loading && 'opacity-50'
                )}
              >
                <span
                  className={cn(
                    'absolute top-1 w-4 h-4 rounded-full bg-white transition-transform',
                    mcpStatus.enabled ? 'translate-x-6' : 'translate-x-1'
                  )}
                />
              </button>
            </div>

            <div className="p-3 border rounded-lg space-y-2 bg-card">
                <div>
                  <p className="text-sm font-medium" style={{ fontFamily: '"Noto Serif SC","Songti SC",serif', letterSpacing: 1 }}>妙笔账号</p>
                </div>
                {miaobiAccount ? (
                  <div className="flex items-center justify-between gap-2">
                    <p className="text-xs" style={{ color: 'hsl(var(--pine))' }}>✓ 已登录：{miaobiAccount}</p>
                    <button
                      onClick={async () => {
                        await chrome.storage.local.remove('miaobiToken')
                        setMiaobiAccount(null)
                        setMiaobiMsg('已退出登录')
                      }}
                      className="text-xs text-muted-foreground hover:text-foreground underline bg-transparent border-none cursor-pointer p-0"
                    >
                      退出
                    </button>
                  </div>
                ) : (
                  <>
                    <input
                      value={miaobiUser}
                      onChange={(e) => setMiaobiUser(e.target.value)}
                      placeholder="用户名（管理台登录账号）"
                      className="w-full text-sm px-2.5 py-1.5 rounded-md border bg-background focus:outline-none focus:ring-1"
                      style={{ borderColor: 'hsl(var(--border))' }}
                      autoComplete="username"
                    />
                    <input
                      value={miaobiPass}
                      onChange={(e) => setMiaobiPass(e.target.value)}
                      type="password"
                      placeholder="密码"
                      onKeyDown={(e) => { if (e.key === 'Enter') handleMiaobiSetup() }}
                      className="w-full text-sm px-2.5 py-1.5 rounded-md border bg-background focus:outline-none focus:ring-1"
                      style={{ borderColor: 'hsl(var(--border))' }}
                      autoComplete="current-password"
                    />
                    <button
                      onClick={handleMiaobiSetup}
                      disabled={miaobiBusy}
                      className="w-full text-sm py-1.5 rounded-md disabled:opacity-50"
                      style={{ background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))' }}
                    >
                      {miaobiBusy ? '配置中…' : '登录并自动配置'}
                    </button>
                  </>
                )}
                {miaobiMsg && <p className="text-xs text-muted-foreground break-all">{miaobiMsg}</p>}
              </div>

            {mcpStatus.enabled && (
              <div className="space-y-2">
                <p className="text-xs text-muted-foreground">
                  供 CLI 和 MCP Server 通过 WebSocket 桥接同步文章
                </p>
                {mcpStatus.token && (
                  <div className="p-2 bg-muted/50 rounded text-xs">
                    <p className="text-muted-foreground mb-1">Token:</p>
                    <code className="block bg-background p-1.5 rounded break-all select-all">
                      {mcpStatus.token}
                    </code>
                  </div>
                )}
                <div className="p-2 bg-muted/50 rounded text-xs">
                  <p className="text-muted-foreground mb-1">服务器地址 (留空使用本地默认):</p>
                  <input
                    type="text"
                    value={serverUrlInput}
                    onChange={(e) => handleServerUrlChange(e.target.value)}
                    placeholder="ws://localhost:9527"
                    className="w-full bg-background p-1.5 rounded border border-border text-xs font-mono focus:outline-none focus:ring-1 focus:ring-primary"
                  />
                </div>
              </div>
            )}
          </div>

          {/* 平台登录状态 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted-foreground">平台登录状态</h3>
              <span className="text-xs text-muted-foreground">
                {verifying ? "验证中…" : `${platforms.filter(p => p.isAuthenticated).length}/${platforms.length} 已登录`}
              </span>
            </div>
            {platforms.length === 0 ? (
              <p className="text-xs text-muted-foreground">检测中…</p>
            ) : (
              <>
                <div>
                  <p style={{ fontSize: 10, color: 'hsl(var(--muted-foreground))', marginBottom: 4 }}>母稿直发</p>
                  <div className="flex flex-wrap gap-1.5" style={{ marginBottom: 8 }}>
                    {platforms.filter(p => !L2_IDS.includes(p.id)).map(renderPlatChip)}
                  </div>
                </div>
                <div>
                  <p style={{ fontSize: 10, color: 'hsl(var(--ochre))', marginBottom: 4 }}>AI 平台版（每平台特化改写）</p>
                  <div className="flex flex-wrap gap-1.5">
                    {platforms.filter(p => L2_IDS.includes(p.id)).map(renderPlatChip)}
                  </div>
                </div>
              </>
            )}
            <p className="text-xs text-muted-foreground">未登录的平台：浏览器访问其官网登录后自动亮起</p>
          </div>

          {/* CMS 账户 */}
          <div className="space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted-foreground">自建站点</h3>
              <button
                onClick={() => {
                  onClose()
                  window.location.hash = '/add-cms'
                }}
                className="flex items-center gap-1 text-xs text-primary hover:underline"
              >
                <Plus className="w-3 h-3" />
                添加
              </button>
            </div>

            {cmsAccounts.length === 0 ? (
              <p className="text-xs text-muted-foreground text-center py-4">
                暂无自建站点
              </p>
            ) : (
              <div className="space-y-2">
                {cmsAccounts.map(account => (
                  <div
                    key={account.id}
                    className="flex items-center justify-between p-2 bg-muted/50 rounded-lg"
                  >
                    <div className="flex-1 min-w-0">
                      <p className="text-sm font-medium truncate">{account.name}</p>
                      <p className="text-xs text-muted-foreground truncate">{account.url}</p>
                    </div>
                    <button
                      onClick={() => deleteCmsAccount(account.id)}
                      className="p-1 text-muted-foreground hover:text-destructive"
                    >
                      <Trash2 className="w-4 h-4" />
                    </button>
                  </div>
                ))}
              </div>
            )}
          </div>

          {/* 历史记录 */}
          <div className="space-y-3">
            <button
              onClick={() => {
                onClose()
                window.location.hash = '/history'
              }}
              className="flex items-center justify-between w-full p-3 bg-muted/50 rounded-lg hover:bg-muted"
            >
              <span className="text-sm font-medium">查看全部历史</span>
              <ChevronRight className="w-4 h-4 text-muted-foreground" />
            </button>
          </div>

        </div>
      </div>
    </>
  )
}
