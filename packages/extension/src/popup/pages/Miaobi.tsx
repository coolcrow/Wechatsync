import { useEffect, useState, useCallback, useRef } from 'react'
import { Settings, Zap, Send, RefreshCw, ChevronRight, BookOpen, Lock } from 'lucide-react'
import { SettingsDrawer } from '../components/SettingsDrawer'
import { cn } from '@/lib/utils'

const MIAOBI_API = 'https://mp.aibolt.tech'

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

export function MiaobiTab({ onOpenSettings: _ }: { onOpenSettings?: () => void }) {
  const [articles, setArticles] = useState<Article[]>([])
  const [loading, setLoading] = useState(true)
  const [error, setError] = useState<string | null>(null)
  const [authenticated, setAuthenticated] = useState<boolean | null>(null)
  const [rewritingIds, setRewritingIds] = useState<Set<number>>(new Set())
  const [syncingId, setSyncingId] = useState<number | null>(null)
  const [settingsOpen, setSettingsOpen] = useState(false)
  const pollRef = useRef<Map<number, ReturnType<typeof setInterval>>>(new Map())

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
        <button onClick={loadArticles} className="p-1 hover:bg-muted rounded" title="刷新">
          <RefreshCw className={cn('w-3.5 h-3.5 text-muted-foreground', loading && 'animate-spin')} />
        </button>
      </div>

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
