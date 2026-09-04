import { useEffect, useState, useCallback, useRef } from 'react'
import { Settings, Zap, Send, RefreshCw, ChevronRight, BookOpen, Lock, Download, X, Wrench, Play, Flame } from 'lucide-react'
import { markdownToHtml } from '@wechatsync/core'
import { SettingsDrawer } from '../components/SettingsDrawer'

const MIAOBI_API = 'https://mp.aibolt.tech'
const CATEGORIES = ['情感', '生活', '职场', '育儿', '家庭', '科技']

interface Article {
  id: number
  title: string
  rewritten_title: string | null
  status: string
  ai_flavor_score: number | null
  ai_flavor_band: string | null
  cur_version: number | null
  category: string | null
}

interface PlatformVersion {
  id: number
  platform: string
  attempt: number
  ai_flavor_score: number | null
  ai_flavor_band: string | null
}

interface CollectData { title: string; content: string; source_url: string; category: string }

const STATUS_MAP: Record<string, string> = { draft: '待改', rewritten: '已改', published: '已发', failed: '退稿', publishing: '发布中' }
const FLAVOR_TEXT: Record<string, string> = { clean: '干净', light: '轻度', heavy: '偏重' }

async function api(method: string, path: string, body?: unknown) {
  const { miaobiToken } = await chrome.storage.local.get('miaobiToken')
  if (!miaobiToken) throw new Error('请先在设置中登录妙笔账号')
  const resp = await fetch(MIAOBI_API + path, {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${miaobiToken}` },
    body: body ? JSON.stringify(body) : undefined,
  })
  if (resp.status === 401) {
    await chrome.storage.local.remove('miaobiToken')
    throw new Error('登录已过期，请重新登录')
  }
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.detail || `请求失败 (${resp.status})`)
  return data
}

function SealTag({ status }: { status: string }) {
  return <span className={`mb-seal mb-seal-${status}`}>{STATUS_MAP[status] || status}</span>
}

function FlavorTag({ score, band }: { score: number | null; band: string | null }) {
  if (score == null) return <span className="mb-card-meta-item mb-mono">AI味 —</span>
  return <span className={`mb-flavor mb-flavor-${band}`}>AI味 {score}·{FLAVOR_TEXT[band || ''] || band}</span>
}

function SkeletonCards({ n = 4 }: { n?: number }) {
  return <>{Array.from({ length: n }).map((_, i) => (
    <div key={i} className="mb-skel-card">
      <div className="mb-skel mb-skel-title" />
      <div className="mb-skel mb-skel-meta" />
    </div>
  ))}</>
}

function ArticleCard({ article, onRewrite, onSync, rewriting }: {
  article: Article
  onRewrite: (id: number) => void
  onSync: (id: number) => void
  rewriting: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const title = article.rewritten_title || article.title
  const canSync = article.status !== 'draft'

  return (
    <div className={`mb-card${expanded ? ' mb-expanded' : ''}${rewriting ? ' rewriting' : ''}`}
      onClick={() => !rewriting && setExpanded(!expanded)}>
      <div className="flex items-start justify-between gap-2">
        <p className="mb-card-title flex-1 truncate">{title}</p>
        <div className="flex items-center gap-1 shrink-0">
          <SealTag status={article.status} />
          {article.cur_version && <span className="mb-seal mb-seal-ver">v{article.cur_version}</span>}
        </div>
      </div>
      <div className="mb-card-meta">
        <span className="mb-card-meta-item">{article.category || '—'}</span>
        <FlavorTag score={article.ai_flavor_score} band={article.ai_flavor_band} />
      </div>
      {expanded && !rewriting && (
        <div className="mb-card-actions">
          {article.status === 'draft' ? (
            <button className="mb-btn mb-btn-primary mb-btn-sm" onClick={(e) => { e.stopPropagation(); onRewrite(article.id) }}>
              <Zap className="w-3 h-3" /> 改写
            </button>
          ) : (
            <>
              <button className="mb-btn mb-btn-sm" onClick={(e) => { e.stopPropagation(); onRewrite(article.id) }}>
                <RefreshCw className="w-3 h-3" /> 重新改写
              </button>
              <button className="mb-btn mb-btn-primary mb-btn-sm" onClick={(e) => { e.stopPropagation(); onSync(article.id) }}>
                <Send className="w-3 h-3" /> 分发
              </button>
            </>
          )}
        </div>
      )}
      {rewriting && (
        <div className="mb-card-actions">
          <span className="mb-rewriting text-[11px] font-medium flex items-center gap-1" style={{ color: 'hsl(var(--primary))' }}>
            <RefreshCw className="w-3 h-3" /> 改写中…
          </span>
        </div>
      )}
    </div>
  )
}

function CollectPanel({ onSave, onClose }: { onSave: (d: CollectData) => Promise<void>; onClose: () => void }) {
  const [data, setData] = useState<CollectData | null>(null)
  const [loading, setLoading] = useState(true)
  const [saving, setSaving] = useState(false)
  const [error, setError] = useState<string | null>(null)

  useEffect(() => {
    const extract = async () => {
      try {
        const [tab] = await chrome.tabs.query({ active: true, currentWindow: true })
        if (!tab?.id) throw new Error('无法获取当前页面')
        if (tab.url?.startsWith('chrome://')) throw new Error('浏览器内部页面不支持采集')
        const response = await chrome.tabs.sendMessage(tab.id, { type: 'EXTRACT_ARTICLE' })
        if (response?.article?.title && response?.article?.content) {
          const art = response.article
          const text = art.title + ' ' + (art.content || '').substring(0, 200)
          const suggested = /情感|爱情|婚姻/.test(text) ? '情感'
            : /职场|工作|裁员/.test(text) ? '职场'
            : /育儿|孩子|亲子/.test(text) ? '育儿'
            : /家庭|父母|婆媳/.test(text) ? '家庭'
            : /科技|AI|编程/.test(text) ? '科技' : '生活'
          setData({ title: art.title.substring(0, 100), content: art.content, source_url: tab.url || '', category: suggested })
          // AI 分类精化（5 秒超时静默降级，保留本地猜测）
          try {
            const { miaobiToken } = await chrome.storage.local.get('miaobiToken')
            if (miaobiToken) {
              const ctl = new AbortController()
              const timer = setTimeout(() => ctl.abort(), 5000)
              const r = await fetch(`${MIAOBI_API}/api/articles/classify`, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${miaobiToken}` },
                body: JSON.stringify({ title: art.title, content: (art.content || '').substring(0, 1500) }),
                signal: ctl.signal,
              })
              clearTimeout(timer)
              const d = await r.json()
              if (r.ok && d.category) setData(prev => (prev ? { ...prev, category: d.category } : prev))
            }
          } catch { /* 保留本地猜测 */ }
        } else {
          throw new Error('未能提取文章内容')
        }
      } catch (e) { setError((e as Error).message) }
      finally { setLoading(false) }
    }
    extract()
  }, [])

  return (
    <div className="mb-panel">
      <div className="mb-panel-header">
        <span className="mb-panel-title"><Download className="w-3.5 h-3.5" style={{ color: 'hsl(var(--primary))' }} /> 采集文章</span>
        <button onClick={onClose} className="text-muted-foreground cursor-pointer bg-transparent border-none"><X className="w-4 h-4" /></button>
      </div>
      {loading && <div className="text-center py-4 text-xs text-muted-foreground">正在提取页面内容…</div>}
      {error && <div className="mb-error">{error}</div>}
      {data && (
        <div className="flex flex-col gap-2">
          <div>
            <label className="mb-panel-label">标题</label>
            <input className="mb-panel-input" value={data.title} onChange={(e) => setData({ ...data, title: e.target.value })} />
          </div>
          <div className="flex gap-2">
            <div className="flex-1">
              <label className="mb-panel-label">分类</label>
              <select className="mb-panel-input" value={data.category} onChange={(e) => setData({ ...data, category: e.target.value })}>
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div className="flex-1">
              <label className="mb-panel-label">字数</label>
              <span className="mb-mono text-xs text-muted-foreground leading-6">{data.content.length} 字</span>
            </div>
          </div>
          <button className="mb-btn mb-btn-primary w-full" disabled={saving || !data.title} onClick={async () => {
            setSaving(true)
            try { await onSave(data); onClose() } catch (e) { setError((e as Error).message) } finally { setSaving(false) }
          }}>
            {saving ? '保存中…' : '保存到稿件库'}
          </button>
        </div>
      )}
    </div>
  )
}

function ToolsPanel({ onClose }: { onClose: () => void }) {
  const [videoUrl, setVideoUrl] = useState('')
  const [videoParsing, setVideoParsing] = useState(false)
  const [videoResult, setVideoResult] = useState<{ title: string; video_url: string } | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [hotPlatform, setHotPlatform] = useState('weibo')
  const [hotKeyword, setHotKeyword] = useState('')
  const [hotTopics, setHotTopics] = useState<{ topic_title: string; topic_url: string; hot_score: number }[]>([])
  const [hotLoading, setHotLoading] = useState(false)

  const parseVideo = async () => {
    if (!videoUrl.trim()) return
    // 分享文案中提取纯 URL（抖音分享出来的是整段文案不是链接）
    const urlMatch = videoUrl.match(/https?:\/\/[^\s<>"']+/)
    const url = (urlMatch ? urlMatch[0] : videoUrl).replace(/[，。,。）)\]]+$/, '')
    setVideoParsing(true); setVideoError(null); setVideoResult(null)
    try {
      const d = await api('POST', '/api/video/parse', { url })
      setVideoResult(d)
    } catch (serverErr) {
      // 服务端解析失败（抖音 2026 反爬全拦）→ 浏览器内提取回填缓存
      const isDouyin = /douyin\.com/i.test(url)
      if (!isDouyin) { setVideoError((serverErr as Error).message); return }
      try {
        const ext = await new Promise<{ success: boolean; videoUrl?: string; title?: string; cover?: string; error?: string }>((resolve) => {
          chrome.runtime.sendMessage({ type: 'EXTRACT_VIDEO', payload: { url } }, resolve)
        })
        if (!ext?.success || !ext.videoUrl) throw new Error(ext?.error || '浏览器提取失败')
        const cached = await api('POST', '/api/video/cache-external', {
          url, platform: 'douyin',
          video_url: ext.videoUrl, title: ext.title, cover_url: ext.cover || null,
        })
        setVideoResult(cached)
      } catch (e2) { setVideoError(`${(serverErr as Error).message}；浏览器提取也失败：${(e2 as Error).message}`) }
    }
    finally { setVideoParsing(false) }
  }

  const searchHot = async () => {
    setHotLoading(true)
    try {
      const p = new URLSearchParams({ platform: hotPlatform })
      if (hotKeyword.trim()) p.set('keyword', hotKeyword.trim())
      const d = await api('GET', `/api/hot-topics?${p}`)
      setHotTopics((d.topics || d.items || []).slice(0, 8))
    } catch { setHotTopics([]) } finally { setHotLoading(false) }
  }

  return (
    <div className="mb-panel">
      <div className="mb-panel-header">
        <span className="mb-panel-title"><Wrench className="w-3.5 h-3.5" style={{ color: 'hsl(var(--primary))' }} /> 工具箱</span>
        <button onClick={onClose} className="text-muted-foreground cursor-pointer bg-transparent border-none"><X className="w-4 h-4" /></button>
      </div>

      <div className="mb-4">
        <label className="mb-panel-label">无水印视频下载</label>
        <div className="flex gap-1.5">
          <input className="mb-panel-input flex-1" placeholder="粘贴抖音/小红书/B站/快手链接" value={videoUrl} onChange={(e) => setVideoUrl(e.target.value)} />
          <button className="mb-btn mb-btn-primary" disabled={videoParsing} onClick={parseVideo}>{videoParsing ? '…' : '解析'}</button>
        </div>
        {videoError && <div className="text-[10px] mt-1" style={{ color: 'hsl(var(--destructive))' }}>{videoError}</div>}
        {videoResult && (
          <div className="mt-1.5 p-2 border border-border rounded-md">
            <div className="text-[11px] font-semibold leading-snug mb-1">{videoResult.title}</div>
            {videoResult.video_url && <a href={videoResult.video_url} target="_blank" rel="noopener" className="inline-flex items-center gap-1 text-[10px] font-semibold no-underline" style={{ color: 'hsl(var(--primary))' }}><Play className="w-3 h-3" /> 下载视频</a>}
          </div>
        )}
      </div>

      <div>
        <label className="mb-panel-label">热点追踪</label>
        <div className="flex gap-1.5 mb-1.5">
          <select className="mb-panel-input" style={{ width: '70px' }} value={hotPlatform} onChange={(e) => setHotPlatform(e.target.value)}>
            <option value="weibo">微博</option><option value="zhihu">知乎</option><option value="douyin">抖音</option><option value="baidu">百度</option><option value="bilibili">B站</option>
          </select>
          <input className="mb-panel-input flex-1" placeholder="关键词" value={hotKeyword} onChange={(e) => setHotKeyword(e.target.value)} />
          <button className="mb-btn mb-btn-primary" disabled={hotLoading} onClick={searchHot}>{hotLoading ? '…' : '搜索'}</button>
        </div>
        {hotTopics.length > 0 && (
          <div className="flex flex-col gap-0.5">
            {hotTopics.map((t, i) => (
              <a key={i} href={t.topic_url} target="_blank" rel="noopener"
                className="flex items-center gap-1.5 px-1.5 py-1 rounded text-[11px] no-underline text-foreground hover:bg-muted transition-colors">
                <Flame className="w-3 h-3 shrink-0" style={{ color: 'hsl(20 80% 50%)' }} />
                <span className="flex-1 truncate">{t.topic_title}</span>
                {t.hot_score > 0 && <span className="mb-mono text-[9px] text-muted-foreground">{t.hot_score}</span>}
              </a>
            ))}
          </div>
        )}
      </div>
    </div>
  )
}

export function MiaobiTab({ onOpenSettings: _ }: { onOpenSettings?: () => void }) {
  const [articles, setArticles] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [rewritingIds, setRewritingIds] = useState<Set<number>>(new Set())
  const [syncingId, setSyncingId] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const [showCollect, setShowCollect] = useState(false)
  const [showTools, setShowTools] = useState(false)
  const [setupHint, setSetupHint] = useState<{ wechat: boolean; toutiao: boolean } | null>(null)
  const pollRef = useRef<Map<number, ReturnType<typeof setInterval>>>(new Map())

  const checkAuth = useCallback(async () => {
    const { miaobiToken } = await chrome.storage.local.get('miaobiToken')
    if (!miaobiToken) { setAuthenticated(false); return false }
    try {
      const resp = await fetch(`${MIAOBI_API}/api/auth/me`, {
        headers: { Authorization: `Bearer ${miaobiToken}` },
      })
      if (resp.status === 401) {
        await chrome.storage.local.remove('miaobiToken')
        setAuthenticated(false)
        return false
      }
      if (!resp.ok) throw new Error(`me ${resp.status}`)
    } catch {
      // 网络异常不强制登出：按已登录处理，接口调用会各自报错
    }
    setAuthenticated(true)
    return true
  }, [])

  const loadArticles = useCallback(async () => {
    try {
      setError(null)
      const data = await api('GET', '/api/articles?size=50')
      setArticles(data.items || [])
    } catch (e) { setError((e as Error).message) }
    finally { setLoading(false) }
  }, [])

  const checkSetup = useCallback(async () => {
    try {
      const accs = await api('GET', '/api/accounts')
      const has = (plat: string, mode?: string) =>
        (accs || []).some((a: { platform: string; mode?: string }) =>
          a.platform === plat && (!mode || a.mode === mode))
      setSetupHint({ wechat: !has('wechat', 'cookie'), toutiao: !has('toutiao') })
    } catch { setSetupHint(null) }
  }, [])

  const syncCookieFor = useCallback(async (platform: 'wechat' | 'toutiao') => {
    const domain = platform === 'wechat' ? 'mp.weixin.qq.com' : '.toutiao.com'
    const cookies = await chrome.cookies.getAll({ domain })
    const cookieStr = cookies.map(c => `${c.name}=${c.value}`).join('; ')
    if (cookieStr.length < 50)
      throw new Error(platform === 'wechat' ? '未检测到公众号登录，请先扫码登录 mp.weixin.qq.com' : '未检测到头条登录，请先登录 mp.toutiao.com')
    const { miaobiToken } = await chrome.storage.local.get('miaobiToken')
    if (!miaobiToken) throw new Error('请先登录妙笔账号')
    const resp = await fetch(`${MIAOBI_API}/api/accounts/sync-cookie`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${miaobiToken}` },
      body: JSON.stringify({ platform, cookies: cookieStr }),
    })
    const data = await resp.json()
    if (!resp.ok) throw new Error(data.detail || `同步失败 (${resp.status})`)
    return data.message as string
  }, [])

  useEffect(() => {
    const init = async () => {
      const ok = await checkAuth()
      if (ok) { await loadArticles(); await checkSetup() } else setLoading(false)
    }
    init()
  }, [checkAuth, loadArticles, checkSetup])

  const pollRewrite = useCallback((id: number) => {
    setRewritingIds(p => new Set(p).add(id))
    const timer = setInterval(async () => {
      try {
        const a = await api('GET', `/api/articles/${id}`)
        if (a.status === 'rewritten') {
          clearInterval(timer); pollRef.current.delete(id)
          setRewritingIds(p => { const s = new Set(p); s.delete(id); return s })
          loadArticles()
        }
      } catch { clearInterval(timer); pollRef.current.delete(id); setRewritingIds(p => { const s = new Set(p); s.delete(id); return s }) }
    }, 15000)
    pollRef.current.set(id, timer)
    setTimeout(() => { if (pollRef.current.has(id)) { clearInterval(timer); pollRef.current.delete(id); setRewritingIds(p => { const s = new Set(p); s.delete(id); return s }); loadArticles() } }, 600000)
  }, [loadArticles])

  const handleRewrite = useCallback(async (id: number) => {
    const a = articles.find(x => x.id === id)
    try {
      await api('POST', `/api/articles/${id}/${a && a.status !== 'draft' ? 'regenerate' : 'rewrite'}`)
      pollRewrite(id)
    } catch (e) { setError((e as Error).message) }
  }, [articles, pollRewrite])

  const handleCollectSave = async (d: CollectData) => {
    await api('POST', '/api/articles', { title: d.title, content: d.content, category: d.category, source: 'extension', source_url: d.source_url })
    loadArticles()
  }

  const handleSync = useCallback(async (id: number) => {
    setSyncingId(id)
    try {
      const [detail, pre, dna, pvs] = await Promise.all([
        api('GET', `/api/articles/${id}`),
        api('GET', `/api/articles/${id}/preview`).catch(() => null),
        api('GET', '/api/platform-dna').catch(() => ({ platforms: [] })),
        api('GET', `/api/articles/${id}/platform-versions`).catch(() => ({ versions: [] })),
      ])
      const title = detail.rewritten_title || detail.title
      const master = detail.rewritten_content || detail.original_content
      const dnaMap: Record<string, { layer: string }> = {}
      ;(dna.platforms || []).forEach((p: { id: string; layer: string }) => dnaMap[p.id] = p)
      const plats = await new Promise<Record<string, unknown>[]>((resolve) => {
        chrome.runtime.sendMessage({ type: 'CHECK_ALL_AUTH' }, (r) => resolve(r?.platforms || []))
      })
      const usable = plats.filter(p => p.isAuthenticated)
      if (!usable.length) { setError('没有已登录的分发平台'); return }
      const failed: string[] = []
      for (const plat of usable) {
        const pid = plat.id as string
        let content = master
        const list = (pvs.versions || []).filter((pv: PlatformVersion) => pv.platform === pid)
        if (list.length > 0) {
          const latest = list.sort((a: PlatformVersion, b: PlatformVersion) => b.attempt - a.attempt)[0]
          const pvDetail = await api('GET', `/api/articles/${id}/platform-versions/${latest.id}`)
          content = pvDetail.content
        }
        // 与 MCP 桥接路径一致：markdown 先转 HTML 再走 SYNC_ARTICLE（含预处理/历史记录）
        let html = ''
        try { html = markdownToHtml(content) } catch { html = content.replace(/\n/g, '<br>') }
        const resp = await new Promise<{ results?: { success: boolean }[]; error?: string } | undefined>((resolve) => {
          chrome.runtime.sendMessage({
            type: 'SYNC_ARTICLE',
            payload: { article: { title, content: html, html, markdown: content }, platforms: [pid] },
          }, resolve)
        })
        if (!resp || resp.error || resp.results?.some(r => !r.success)) {
          failed.push((plat.name as string) || pid)
        }
      }
      setError(failed.length ? `部分平台同步失败：${failed.join('、')}（详情见同步历史）` : null)
    } catch (e) { setError((e as Error).message) }
    finally { setSyncingId(null) }
  }, [articles])

  useEffect(() => () => { pollRef.current.forEach(t => clearInterval(t)) }, [])

  if (authenticated === null)
    return <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">检查登录状态…</div>

  if (!authenticated) return (
    <>
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <div className="mb-grid mb-empty h-64 rounded-lg">
        <Lock className="w-8 h-8 text-muted-foreground mb-2" />
        <p className="text-sm font-semibold">妙笔稿件库</p>
        <p className="mb-empty-sub text-center px-8">登录妙笔账号后可在此管理稿件、改写并分发到全平台</p>
        <button className="mb-btn mb-btn-primary mt-2" onClick={() => setSettingsOpen(true)}>
          <Settings className="w-3 h-3" /> 去设置登录
        </button>
      </div>
    </>
  )

  return (
    <>
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <div className="flex flex-col h-full">
        <div className="mb-header">
          <div className="mb-header-left">
            <span
              style={{
                width: 20, height: 20, background: 'hsl(var(--primary))', color: 'hsl(var(--primary-foreground))',
                fontFamily: '"Noto Serif SC","Songti SC",serif', fontSize: 12, fontWeight: 700,
                display: 'inline-flex', alignItems: 'center', justifyContent: 'center',
                borderRadius: 3, transform: 'rotate(6deg)', flexShrink: 0,
              }}
            >妙</span>
            <h2 className="mb-header-title">稿件库</h2>
            <span className="mb-header-count">{articles.length} 篇</span>
          </div>
          <div className="mb-header-actions">
            <button className="mb-header-btn mb-header-btn-tools" onClick={() => { setShowTools(!showTools); setShowCollect(false) }}>
              <Wrench className="w-3 h-3" /> 工具
            </button>
            <button className="mb-header-btn mb-header-btn-collect" onClick={() => { setShowCollect(!showCollect); setShowTools(false) }}>
              <Download className="w-3 h-3" /> 采集
            </button>
            <button className="p-1.5 hover:bg-muted rounded cursor-pointer bg-transparent border-none" onClick={loadArticles} title="刷新">
              <RefreshCw className={`w-3.5 h-3.5 text-muted-foreground ${loading ? 'animate-spin' : ''}`} />
            </button>
            <button className="p-1.5 hover:bg-muted rounded cursor-pointer bg-transparent border-none" onClick={() => setSettingsOpen(true)} title="设置">
              <Settings className="w-3.5 h-3.5 text-muted-foreground" />
            </button>
          </div>
        </div>
        {showTools && <ToolsPanel onClose={() => setShowTools(false)} />}
        {showCollect && <CollectPanel onSave={handleCollectSave} onClose={() => setShowCollect(false)} />}

        {setupHint && (setupHint.wechat || setupHint.toutiao) && (
          <div className="mx-3 mt-2 p-2 rounded border flex items-center gap-2 text-[11px]" style={{ borderColor: 'hsl(var(--ochre) / .5)', background: 'hsl(var(--ochre) / .07)' }}>
            <span style={{ color: 'hsl(var(--ochre))', fontWeight: 600, flexShrink: 0 }}>让直发就绪</span>
            {setupHint.wechat && (
              <button
                className="mb-btn mb-btn-sm"
                style={{ color: 'hsl(var(--ochre))', borderColor: 'hsl(var(--ochre) / .6)' }}
                onClick={async (e) => {
                  const btn = e.currentTarget
                  btn.disabled = true; btn.textContent = '同步中…'
                  try { const m = await syncCookieFor('wechat'); btn.textContent = '✓ ' + m.slice(0, 18) }
                  catch (err) { btn.textContent = '重试'; alert((err as Error).message) }
                  btn.disabled = false; setTimeout(checkSetup, 600)
                }}
              >同步公众号 Cookie</button>
            )}
            {setupHint.toutiao && (
              <button
                className="mb-btn mb-btn-sm"
                style={{ color: 'hsl(var(--ochre))', borderColor: 'hsl(var(--ochre) / .6)' }}
                onClick={async (e) => {
                  const btn = e.currentTarget
                  btn.disabled = true; btn.textContent = '同步中…'
                  try { const m = await syncCookieFor('toutiao'); btn.textContent = '✓ ' + m.slice(0, 18) }
                  catch (err) { btn.textContent = '重试'; alert((err as Error).message) }
                  btn.disabled = false; setTimeout(checkSetup, 600)
                }}
              >同步头条 Cookie</button>
            )}
            <button className="ml-auto bg-transparent border-none cursor-pointer text-muted-foreground" style={{ fontSize: 13 }} onClick={() => setSetupHint(null)} title="忽略">×</button>
          </div>
        )}
        {error && (
          <div className="mb-error">{error}<button className="float-right font-bold bg-transparent border-none cursor-pointer" onClick={() => setError(null)}>×</button></div>
        )}
        {syncingId !== null && (
          <div className="mx-3 mt-2 p-2 rounded border text-[11px] font-medium" style={{ borderColor: 'hsl(var(--primary) / .3)', background: 'hsl(var(--primary) / .05)', color: 'hsl(var(--primary))' }}>
            正在分发到各平台…请稍候
          </div>
        )}

        <div className="flex-1 overflow-y-auto px-2 py-2">
          {loading ? <SkeletonCards />
          : articles.length === 0 ? (
            <div className="mb-grid mb-empty rounded">
              <p className="mb-empty-title">稿件库还是空的</p>
              <p className="mb-empty-sub">用「采集」按钮收藏第一篇文章</p>
            </div>
          ) : articles.map(a => (
            <ArticleCard key={a.id} article={a} onRewrite={handleRewrite} onSync={handleSync} rewriting={rewritingIds.has(a.id)} />
          ))}
        </div>
      </div>
    </>
  )
}
