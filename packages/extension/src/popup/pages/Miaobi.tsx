import { useEffect, useState, useCallback, useRef } from 'react'
import { Settings, Zap, Send, RefreshCw, ChevronRight, BookOpen, Lock, Download, X, Wrench, Play, Flame } from 'lucide-react'
import { SettingsDrawer } from '../components/SettingsDrawer'
import { cn } from '@/lib/utils'

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

interface CollectData {
  title: string
  content: string
  source_url: string
  category: string
}

const STATUS_MAP: Record<string, string> = {
  draft: '待改', rewritten: '已改', published: '已发', failed: '退稿',
}

const FLAVOR_TEXT: Record<string, string> = {
  clean: '干净', light: '轻度', heavy: '偏重',
}

async function api(method: string, path: string, body?: unknown) {
  const { miaobiToken } = await chrome.storage.local.get('miaobiToken')
  if (!miaobiToken) throw new Error('请先在设置中登录妙笔账号')
  const resp = await fetch(MIAOBI_API + path, {
    method,
    headers: {
      'Content-Type': 'application/json',
      Authorization: `Bearer ${miaobiToken}`,
    },
    body: body ? JSON.stringify(body) : undefined,
  })
  const data = await resp.json()
  if (!resp.ok) throw new Error(data.detail || `请求失败 (${resp.status})`)
  return data
}

function SealTag({ status }: { status: string }) {
  return <span className={cn('miaobi-seal', `miaobi-seal-${status}`)}>{STATUS_MAP[status] || status}</span>
}

function FlavorTag({ score, band }: { score: number | null; band: string | null }) {
  if (score == null) return <span className="miaobi-flavor text-muted-foreground">AI味 —</span>
  const color = band === 'clean' ? 'text-green-700' : band === 'heavy' ? 'text-red-600' : 'text-yellow-700'
  return <span className={cn('miaobi-flavor', color)}>AI味 {score}·{FLAVOR_TEXT[band || ''] || band}</span>
}

function ArticleCard({ article, onRewrite, onSync, rewriting }: {
  article: Article
  onRewrite: (id: number) => void
  onSync: (id: number) => void
  rewriting: boolean
}) {
  const [expanded, setExpanded] = useState(false)
  const displayTitle = article.rewritten_title || article.title
  const canSync = article.status !== 'draft'

  return (
    <div
      className={cn(
        'border rounded-md p-2.5 mb-1.5 transition-colors',
        expanded ? 'border-primary/30 bg-accent/5' : 'border-border hover:border-primary/20'
      )}
    >
      <div className="flex items-start gap-2 cursor-pointer" onClick={() => setExpanded(!expanded)}>
        <div className="flex-1 min-w-0">
          <p className="text-xs font-medium truncate leading-snug">{displayTitle}</p>
          <div className="flex items-center gap-2 mt-1 flex-wrap">
            <SealTag status={article.status} />
            <FlavorTag score={article.ai_flavor_score} band={article.ai_flavor_band} />
            {article.cur_version && (
              <span className="text-[10px] text-muted-foreground font-mono">v{article.cur_version}</span>
            )}
          </div>
        </div>
        <ChevronRight className={cn('w-3.5 h-3.5 text-muted-foreground shrink-0 transition-transform', expanded && 'rotate-90')} />
      </div>

      {expanded && (
        <div className="mt-2 pt-2 border-t border-border/50 flex gap-1.5">
          {rewriting ? (
            <span className="miaobi-rewriting text-[11px] text-primary font-medium flex items-center gap-1">
              <RefreshCw className="w-3 h-3" /> 改写中…
            </span>
          ) : (
            <>
              {article.status === 'draft' ? (
                <button
                  onClick={() => onRewrite(article.id)}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded bg-primary text-primary-foreground font-medium hover:opacity-90"
                >
                  <Zap className="w-3 h-3" /> 改写
                </button>
              ) : (
                <button
                  onClick={() => onRewrite(article.id)}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-border text-foreground hover:border-foreground/30 font-medium"
                >
                  <RefreshCw className="w-3 h-3" /> 重新改写
                </button>
              )}
              {canSync && (
                <button
                  onClick={() => onSync(article.id)}
                  className="flex items-center gap-1 text-[11px] px-2 py-1 rounded border border-primary/40 text-primary font-medium hover:bg-accent/10"
                >
                  <Send className="w-3 h-3" /> 分发
                </button>
              )}
            </>
          )}
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
          const suggested = suggestCategory(art.title + ' ' + art.content?.substring(0, 200))
          setData({
            title: art.title.substring(0, 100),
            content: art.content,
            source_url: tab.url || '',
            category: suggested,
          })
        } else {
          throw new Error('未能提取文章内容，请确认当前页面是一篇文章')
        }
      } catch (e) {
        setError((e as Error).message)
      } finally {
        setLoading(false)
      }
    }
    extract()
  }, [])

  const suggestCategory = (text: string): string => {
    if (/情感|爱情|婚姻|夫妻|分手|离婚|恋爱/.test(text)) return '情感'
    if (/职场|工作|加班|裁员|老板|同事|求职/.test(text)) return '职场'
    if (/育儿|孩子|亲子|教育|家长|宝宝/.test(text)) return '育儿'
    if (/家庭|父母|婆媳|亲情|家风/.test(text)) return '家庭'
    if (/科技|AI|编程|代码|互联网|数码/.test(text)) return '科技'
    return '生活'
  }

  const handleSave = async () => {
    if (!data?.title || !data?.content) return
    setSaving(true)
    try {
      await onSave(data)
      onClose()
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSaving(false)
    }
  }

  return (
    <div style={{ padding: '12px', borderBottom: '1px solid hsl(var(--border))' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '8px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Download className="w-3.5 h-3.5 text-primary" /> 采集文章
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--muted-foreground))' }}>
          <X className="w-4 h-4" />
        </button>
      </div>
      {loading && <div style={{ textAlign: 'center', padding: '16px', fontSize: '12px', color: 'hsl(var(--muted-foreground))' }}>正在提取页面内容…</div>}
      {error && (
        <div style={{ padding: '8px 12px', background: 'hsl(var(--destructive) / 0.05)', borderRadius: '6px', fontSize: '11px', color: 'hsl(var(--destructive))' }}>
          {error}
          <button onClick={onClose} style={{ marginLeft: '8px', background: 'none', border: 'none', color: 'inherit', fontWeight: 600, cursor: 'pointer' }}>关闭</button>
        </div>
      )}
      {data && (
        <div style={{ display: 'flex', flexDirection: 'column', gap: '8px' }}>
          <div>
            <label style={{ fontSize: '10px', fontWeight: 600, color: 'hsl(var(--muted-foreground))', display: 'block', marginBottom: '2px' }}>标题</label>
            <input
              value={data.title}
              onChange={(e) => setData({ ...data, title: e.target.value })}
              style={{ width: '100%', padding: '6px 10px', fontSize: '12px', border: '1px solid hsl(var(--border))', borderRadius: '6px', background: 'hsl(var(--card))', color: 'hsl(var(--foreground))' }}
            />
          </div>
          <div style={{ display: 'flex', gap: '8px' }}>
            <div style={{ flex: 1 }}>
              <label style={{ fontSize: '10px', fontWeight: 600, color: 'hsl(var(--muted-foreground))', display: 'block', marginBottom: '2px' }}>分类</label>
              <select
                value={data.category}
                onChange={(e) => setData({ ...data, category: e.target.value })}
                style={{ width: '100%', padding: '6px 8px', fontSize: '12px', border: '1px solid hsl(var(--border))', borderRadius: '6px', background: 'hsl(var(--card))', color: 'hsl(var(--foreground))' }}
              >
                {CATEGORIES.map(c => <option key={c} value={c}>{c}</option>)}
              </select>
            </div>
            <div style={{ flex: 2 }}>
              <label style={{ fontSize: '10px', fontWeight: 600, color: 'hsl(var(--muted-foreground))', display: 'block', marginBottom: '2px' }}>字数</label>
              <span style={{ fontSize: '12px', color: 'hsl(var(--muted-foreground))', fontFamily: 'monospace', lineHeight: '2' }}>{data.content.length} 字</span>
            </div>
          </div>
          <button
            onClick={handleSave}
            disabled={saving || !data.title}
            className="w-full bg-primary text-primary-foreground text-sm py-1.5 rounded-md hover:bg-primary/90 disabled:opacity-50"
            style={{ fontSize: '12px', fontWeight: 600, padding: '6px', cursor: 'pointer', border: 'none' }}
          >
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
  const [videoResult, setVideoResult] = useState<{ title: string; video_url: string; description: string } | null>(null)
  const [videoError, setVideoError] = useState<string | null>(null)
  const [hotPlatform, setHotPlatform] = useState('weibo')
  const [hotKeyword, setHotKeyword] = useState('')
  const [hotTopics, setHotTopics] = useState<{ topic_title: string; topic_url: string; hot_score: number }[]>([])
  const [hotLoading, setHotLoading] = useState(false)

  const parseVideo = async () => {
    if (!videoUrl.trim()) return
    setVideoParsing(true)
    setVideoError(null)
    setVideoResult(null)
    try {
      const d = await api('POST', '/api/video/parse', { url: videoUrl.trim() })
      setVideoResult(d)
    } catch (e) {
      setVideoError((e as Error).message)
    } finally {
      setVideoParsing(false)
    }
  }

  const searchHot = async () => {
    setHotLoading(true)
    try {
      const params = new URLSearchParams({ platform: hotPlatform })
      if (hotKeyword.trim()) params.set('keyword', hotKeyword.trim())
      const d = await api('GET', `/api/hot-topics?${params}`)
      setHotTopics((d.topics || d.items || []).slice(0, 8))
    } catch (e) {
      setHotTopics([])
    } finally {
      setHotLoading(false)
    }
  }

  return (
    <div style={{ padding: '12px', borderBottom: '1px solid hsl(var(--border))', maxHeight: '300px', overflowY: 'auto' }}>
      <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center', marginBottom: '10px' }}>
        <span style={{ fontSize: '12px', fontWeight: 600, display: 'flex', alignItems: 'center', gap: '4px' }}>
          <Wrench className="w-3.5 h-3.5 text-primary" /> 工具箱
        </span>
        <button onClick={onClose} style={{ background: 'none', border: 'none', cursor: 'pointer', color: 'hsl(var(--muted-foreground))' }}>
          <X className="w-4 h-4" />
        </button>
      </div>

      {/* 视频解析 */}
      <div style={{ marginBottom: '14px' }}>
        <div style={{ fontSize: '10px', fontWeight: 600, color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}>无水印视频下载</div>
        <div style={{ display: 'flex', gap: '6px' }}>
          <input
            value={videoUrl}
            onChange={(e) => setVideoUrl(e.target.value)}
            placeholder="粘贴抖音/小红书/B站/快手链接"
            style={{ flex: 1, padding: '5px 8px', fontSize: '11px', border: '1px solid hsl(var(--border))', borderRadius: '4px', background: 'hsl(var(--card))', color: 'hsl(var(--foreground))' }}
          />
          <button
            onClick={parseVideo}
            disabled={videoParsing}
            className="bg-primary text-primary-foreground rounded text-[11px] font-semibold px-3"
            style={{ border: 'none', cursor: 'pointer', padding: '5px 10px' }}
          >
            {videoParsing ? '解析中…' : '解析'}
          </button>
        </div>
        {videoError && <div style={{ fontSize: '10px', color: 'hsl(var(--destructive))', marginTop: '4px' }}>{videoError}</div>}
        {videoResult && (
          <div style={{ marginTop: '6px', padding: '8px', border: '1px solid hsl(var(--border))', borderRadius: '6px' }}>
            <div style={{ fontSize: '11px', fontWeight: 600, marginBottom: '4px', lineHeight: 1.4 }}>{videoResult.title}</div>
            {videoResult.video_url && (
              <a href={videoResult.video_url} target="_blank" rel="noopener" download
                style={{ display: 'inline-flex', alignItems: 'center', gap: '3px', fontSize: '10px', color: 'hsl(var(--primary))', fontWeight: 600, textDecoration: 'none' }}>
                <Play className="w-3 h-3" /> 下载视频
              </a>
            )}
          </div>
        )}
      </div>

      {/* 热点追踪 */}
      <div>
        <div style={{ fontSize: '10px', fontWeight: 600, color: 'hsl(var(--muted-foreground))', marginBottom: '4px' }}>热点追踪</div>
        <div style={{ display: 'flex', gap: '6px', marginBottom: '6px' }}>
          <select value={hotPlatform} onChange={(e) => setHotPlatform(e.target.value)}
            style={{ padding: '5px 6px', fontSize: '11px', border: '1px solid hsl(var(--border))', borderRadius: '4px', background: 'hsl(var(--card))' }}>
            <option value="weibo">微博</option>
            <option value="zhihu">知乎</option>
            <option value="douyin">抖音</option>
            <option value="baidu">百度</option>
            <option value="bilibili">B站</option>
          </select>
          <input
            value={hotKeyword}
            onChange={(e) => setHotKeyword(e.target.value)}
            placeholder="关键词（可选）"
            style={{ flex: 1, padding: '5px 8px', fontSize: '11px', border: '1px solid hsl(var(--border))', borderRadius: '4px', background: 'hsl(var(--card))' }}
          />
          <button
            onClick={searchHot}
            disabled={hotLoading}
            className="bg-primary text-primary-foreground rounded text-[11px] font-semibold px-3"
            style={{ border: 'none', cursor: 'pointer', padding: '5px 10px' }}
          >
            {hotLoading ? '…' : '搜索'}
          </button>
        </div>
        {hotTopics.length > 0 && (
          <div style={{ display: 'flex', flexDirection: 'column', gap: '3px' }}>
            {hotTopics.map((t, i) => (
              <a key={i} href={t.topic_url} target="_blank" rel="noopener"
                style={{ display: 'flex', alignItems: 'center', gap: '6px', padding: '4px 6px', borderRadius: '4px', textDecoration: 'none', color: 'hsl(var(--foreground))', fontSize: '11px' }}
                onMouseOver={(e) => e.currentTarget.style.background = 'hsl(var(--muted))'}
                onMouseOut={(e) => e.currentTarget.style.background = 'transparent'}
              >
                <Flame className="w-3 h-3 text-orange-500 shrink-0" />
                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>{t.topic_title}</span>
                {t.hot_score && <span style={{ fontSize: '9px', color: 'hsl(var(--muted-foreground))', fontFamily: 'monospace' }}>{t.hot_score}</span>}
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
  const pollRef = useRef<Map<number, ReturnType<typeof setInterval>>>(new Map())

  const handleCollectSave = async (d: CollectData) => {
    await api('POST', '/api/articles', {
      title: d.title,
      content: d.content,
      category: d.category,
      source: 'extension',
      source_url: d.source_url,
    })
    setArticles(prev => [...prev])
    loadArticles()
  }

  const checkAuth = useCallback(async () => {
    const { miaobiToken } = await chrome.storage.local.get('miaobiToken')
    setAuthenticated(!!miaobiToken)
    return !!miaobiToken
  }, [])

  const loadArticles = useCallback(async () => {
    try {
      setError(null)
      const data = await api('GET', '/api/articles?size=50')
      setArticles(data.items || [])
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setLoading(false)
    }
  }, [])

  useEffect(() => {
    const init = async () => {
      const ok = await checkAuth()
      if (ok) await loadArticles()
      else setLoading(false)
    }
    init()
  }, [checkAuth, loadArticles])

  const pollRewrite = useCallback((id: number) => {
    setRewritingIds(prev => new Set(prev).add(id))
    const timer = setInterval(async () => {
      try {
        const data = await api('GET', `/api/articles/${id}`)
        if (data.status === 'rewritten') {
          clearInterval(timer)
          pollRef.current.delete(id)
          setRewritingIds(prev => { const s = new Set(prev); s.delete(id); return s })
          loadArticles()
        }
      } catch {
        clearInterval(timer)
        pollRef.current.delete(id)
        setRewritingIds(prev => { const s = new Set(prev); s.delete(id); return s })
      }
    }, 15000)
    pollRef.current.set(id, timer)
    setTimeout(() => {
      if (pollRef.current.has(id)) {
        clearInterval(timer)
        pollRef.current.delete(id)
        setRewritingIds(prev => { const s = new Set(prev); s.delete(id); return s })
        loadArticles()
      }
    }, 600000)
  }, [loadArticles])

  const handleRewrite = useCallback(async (id: number) => {
    const article = articles.find(a => a.id === id)
    const isRegen = article && article.status !== 'draft'
    try {
      await api('POST', `/api/articles/${id}/${isRegen ? 'regenerate' : 'rewrite'}`)
      pollRewrite(id)
    } catch (e) {
      setError((e as Error).message)
    }
  }, [articles, pollRewrite])

  const handleSync = useCallback(async (id: number) => {
    setSyncingId(id)
    try {
      const [detail, pre, dna] = await Promise.all([
        api('GET', `/api/articles/${id}`),
        api('GET', `/api/articles/${id}/preview`).catch(() => null),
        api('GET', '/api/platform-dna').catch(() => ({ platforms: [] })),
      ])
      const versions = pre?.versions || []
      const platformVersions = await api('GET', `/api/articles/${id}/platform-versions`).catch(() => ({ versions: [] }))
      const title = detail.rewritten_title || detail.title
      const master = detail.rewritten_content || detail.original_content

      // Get logged-in platforms from bridge
      const plats = await new Promise<Record<string, unknown>[]>((resolve) => {
        chrome.runtime.sendMessage({ type: 'LIST_PLATFORMS' }, (resp) => {
          resolve(resp?.platforms || [])
        })
      })
      const usable = plats.filter(p => p.isAuthenticated)
      if (!usable.length) {
        setError('没有已登录的分发平台')
        return
      }

      // For each platform, use platform version if available
      const dnaMap: Record<string, { layer: string }> = {}
      ;(dna.platforms || []).forEach((p: { id: string; layer: string }) => dnaMap[p.id] = p)

      for (const plat of usable) {
        const pid = plat.id as string
        let content = master

        // Find latest platform version for this platform
        const pvs = (platformVersions.versions || []).filter(
          (pv: PlatformVersion) => pv.platform === pid
        )
        if (pvs.length > 0) {
          const latest = pvs.sort((a: PlatformVersion, b: PlatformVersion) => b.attempt - a.attempt)[0]
          const pvDetail = await api('GET', `/api/articles/${id}/platform-versions/${latest.id}`)
          content = pvDetail.content
        }

        // Send to bridge for this platform
        await new Promise((resolve) => {
          chrome.runtime.sendMessage({
            type: 'SYNC_TO_PLATFORM',
            payload: { platform: pid, title, content },
          }, resolve)
        })
      }

      setError(null)
      alert(`已分发 ${usable.length} 个平台（均为草稿）`)
    } catch (e) {
      setError((e as Error).message)
    } finally {
      setSyncingId(null)
    }
  }, [articles])

  useEffect(() => {
    return () => {
      pollRef.current.forEach(timer => clearInterval(timer))
    }
  }, [])

  if (authenticated === null) {
    return <div className="flex items-center justify-center h-64 text-muted-foreground text-sm">检查登录状态…</div>
  }

  if (!authenticated) {
    return (
      <>
        <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
        <div className="miaobi-grid flex flex-col items-center justify-center h-64 gap-3">
          <Lock className="w-8 h-8 text-muted-foreground" />
          <p className="text-sm font-medium">妙笔稿件库</p>
          <p className="text-xs text-muted-foreground text-center px-8">
            登录妙笔账号后可在此管理稿件、改写并分发到全平台
          </p>
          <button
            onClick={() => setSettingsOpen(true)}
            className="flex items-center gap-1.5 text-xs px-3 py-1.5 rounded bg-primary text-primary-foreground font-medium"
          >
            去设置登录 <Settings className="w-3 h-3" />
          </button>
        </div>
      </>
    )
  }

  return (
    <>
      <SettingsDrawer open={settingsOpen} onClose={() => setSettingsOpen(false)} />
      <div className="flex flex-col h-full">
      {/* 头部 */}
      <div className="flex items-center justify-between px-3 py-2 border-b border-border">
        <div className="flex items-center gap-2">
          <BookOpen className="w-4 h-4 text-primary" />
          <h2 className="miaobi-brand text-sm font-bold">稿件库</h2>
          <span className="text-[10px] text-muted-foreground">{articles.length} 篇</span>
        </div>
        <div className="flex items-center gap-1">
          <button
            onClick={() => { setShowTools(!showTools); setShowCollect(false); }}
            className="flex items-center gap-1 px-2 py-1 rounded bg-accent/10 text-foreground/70 text-[11px] font-semibold hover:bg-accent/20"
            title="视频解析、热点追踪等工具"
          >
            <Wrench className="w-3 h-3" /> 工具
          </button>
          <button
            onClick={() => { setShowCollect(!showCollect); setShowTools(false); }}
            className="flex items-center gap-1 px-2 py-1 rounded bg-primary/10 text-primary text-[11px] font-semibold hover:bg-primary/20"
            title="采集当前页面的文章到稿件库"
          >
            <Download className="w-3 h-3" /> 采集
          </button>
          <button onClick={loadArticles} className="p-1 hover:bg-muted rounded" title="刷新">
            <RefreshCw className={cn('w-3.5 h-3.5 text-muted-foreground', loading && 'animate-spin')} />
          </button>
        </div>
      </div>
      {showTools && <ToolsPanel onClose={() => setShowTools(false)} />}
      {showCollect && <CollectPanel onSave={handleCollectSave} onClose={() => setShowCollect(false)} />}

      {/* 错误提示 */}
      {error && (
        <div className="mx-2 mt-2 p-2 rounded border border-destructive/30 bg-destructive/5 text-[11px] text-destructive">
          {error}
          <button onClick={() => setError(null)} className="float-right font-bold">×</button>
        </div>
      )}

      {/* 同步中提示 */}
      {syncingId !== null && (
        <div className="mx-2 mt-2 p-2 rounded border border-primary/30 bg-accent/10 text-[11px] text-primary font-medium">
          正在分发到各平台…请稍候
        </div>
      )}

      {/* 文章列表 */}
      <div className="flex-1 overflow-y-auto px-2 py-2">
        {loading ? (
          <div className="flex items-center justify-center h-32 text-muted-foreground text-xs">加载中…</div>
        ) : articles.length === 0 ? (
          <div className="miaobi-grid flex flex-col items-center justify-center h-32 gap-1 rounded">
            <p className="text-xs font-medium">稿件库还是空的</p>
            <p className="text-[10px] text-muted-foreground">在管理台或用采集功能添加文章</p>
          </div>
        ) : (
          articles.map(a => (
            <ArticleCard
              key={a.id}
              article={a}
              onRewrite={handleRewrite}
              onSync={handleSync}
              rewriting={rewritingIds.has(a.id)}
            />
          ))
        )}
      </div>
      </div>
    </>
  )
}
