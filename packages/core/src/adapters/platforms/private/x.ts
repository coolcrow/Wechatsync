/**
 * X (Twitter) 适配器（移植自官方构建，GPL-3.0）
 *
 * 发布路线：走 X 私有 GraphQL 长文（Articles）接口——先 ArticleEntityDraftCreate
 * 建草稿，再 ArticleEntityUpdateTitle / ArticleEntityUpdateContent 写入标题与
 * Draft.js content_state，用户在 x.com/compose/articles 编辑页确认发布。
 * GraphQL queryId 会随站点发版变化：先从发现页扫出 client-web JS bundle
 * 列表，再用四组正则从 bundle 中提取 operationName → queryId 映射，
 * 结果缓存到 storage（TTL 24h），失败时回退到内置兜底 queryId；
 * 404 时强制刷新 queryId 后重试一次。
 * 图片走 upload.x.com v1.1 media 上传（INIT/APPEND/FINALIZE），
 * 正文图片以 atomic MEDIA block + media_items 嵌入，代码块转 MARKDOWN
 * 实体，分隔线转 DIVIDER，$$..$$ 公式转 LATEX。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'
import { parseMarkdownImages } from '../../../lib/markdown-images'
import { markdownToDraft } from 'markdown-draft-js'

const logger = createLogger('X')

/** GraphQL 操作名（queryId 需从站点 bundle 动态发现） */
const OPERATION_NAMES = {
  createDraft: 'ArticleEntityDraftCreate',
  updateTitle: 'ArticleEntityUpdateTitle',
  updateContent: 'ArticleEntityUpdateContent',
} as const

type QueryName = keyof typeof OPERATION_NAMES

/** 兜底 queryId（bundle 扫描失败时使用） */
const FALLBACK_QUERY_IDS: Record<QueryName, string> = {
  createDraft: 't5-e2kJcCqqJ_MsZ0c07Rg',
  updateTitle: '5wp_YbfxSfYJTiLWb4tYnA',
  updateContent: 'IzVdegTuct9uoXRK5L93Qg',
}

/** bundle 发现页列表 */
const DISCOVERY_PAGES = [
  'https://x.com/?lang=en',
  'https://x.com/explore',
  'https://x.com/compose/articles',
]

/** client-web JS bundle URL 匹配 */
const BUNDLE_URL_REGEX =
  /https:\/\/abs\.twimg\.com\/responsive-web\/client-web(?:-legacy)?\/[A-Za-z0-9.-]+\.js/g

/** bundle 内 queryId 提取模式（不同打包形态各一组） */
interface QueryIdPattern {
  regex: RegExp
  queryIdGroup: number
  operationGroup: number
}

const QUERY_ID_PATTERNS: QueryIdPattern[] = [
  {
    regex: /e\.exports=\{queryId\s*:\s*["']([^"']+)["']\s*,\s*operationName\s*:\s*["']([^"']+)["']/g,
    queryIdGroup: 1,
    operationGroup: 2,
  },
  {
    regex: /e\.exports=\{operationName\s*:\s*["']([^"']+)["']\s*,\s*queryId\s*:\s*["']([^"']+)["']/g,
    operationGroup: 1,
    queryIdGroup: 2,
  },
  {
    regex: /operationName\s*[:=]\s*["']([^"']+)["'][\s\S]{0,500}?queryId\s*[:=]\s*["']([^"']+)["']/g,
    operationGroup: 1,
    queryIdGroup: 2,
  },
  {
    regex: /queryId\s*[:=]\s*["']([^"']+)["'][\s\S]{0,500}?operationName\s*[:=]\s*["']([^"']+)["']/g,
    queryIdGroup: 1,
    operationGroup: 2,
  },
]

/** queryId 缓存 TTL：24 小时 */
const QUERY_ID_TTL_MS = 24 * 60 * 60 * 1000

/** queryId 缓存的 storage key */
const QUERY_ID_STORAGE_KEY = 'x_query_id_cache'

/** GraphQL 请求携带的 features 开关 */
const GRAPHQL_FEATURES: Record<string, boolean> = {
  profile_label_improvements_pcf_label_in_post_enabled: true,
  responsive_web_profile_redirect_enabled: false,
  rweb_tipjar_consumption_enabled: true,
  verified_phone_label_enabled: false,
  responsive_web_graphql_skip_user_profile_image_extensions_enabled: false,
  responsive_web_graphql_timeline_navigation_enabled: true,
}

/** X Web 端公开 Bearer Token（使用前将 = 转义为 %3D） */
const WEB_BEARER_TOKEN =
  'AAAAAAAAAAAAAAAAAAAAANRILgAAAAAAnNwIzUejRCOuH5E6I8xnZz4puTs=1Zv7ttfk8LF81IUq16cHjhLTvJu4FA33AGWWjCpTnA'

/** queryId 缓存结构 */
interface QueryIdCache {
  ids: Record<string, string>
  fetchedAt: number
  ttlMs: number
}

/** GraphQL 响应外壳 */
interface GraphQLResponse {
  data?: unknown
  errors?: Array<{ message: string }>
}

interface GraphQLRequestOptions {
  retry404?: boolean
}

/** x.com/home __INITIAL_STATE__ 中的用户实体 */
interface XUserEntity {
  id_str: string
  screen_name: string
  name: string
  profile_image_url_https: string
}

/** X 长文 content_state 的 block */
interface XDraftBlock {
  key: string
  type: string
  text: string
  data: Record<string, unknown>
  entity_ranges: Array<{ key: number; offset: number; length: number }>
  inline_style_ranges: Array<{ style: string; offset: number; length: number }>
}

/** X 长文 content_state 的 entity（entity_map 为 {key, value} 数组） */
interface XDraftEntityEntry {
  key: string
  value: {
    type: string
    mutability: string
    data: Record<string, unknown>
  }
}

/** X 长文 content_state */
interface XDraftContent {
  blocks: XDraftBlock[]
  entity_map: XDraftEntityEntry[]
}

/** 正文图片占位符记录 */
interface XImagePlaceholder {
  placeholder: string
  src: string
  alt: string
}

export class XAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'x',
    name: 'X (Twitter)',
    icon: 'https://abs.twimg.com/favicons/twitter.3.ico',
    homepage: 'https://x.com/compose/articles',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  private userInfo: { userId: string; username: string; name: string; avatar: string } | null = null
  private csrfToken: string | null = null
  private xpForwardedFor: { str: string; expiryTimeMillis: number } | null = null
  private queryIdRefreshInProgress: Promise<void> | null = null

  async getQueryIdCache(): Promise<QueryIdCache | null> {
    try {
      return await this.runtime.storage.get<QueryIdCache>(QUERY_ID_STORAGE_KEY)
    } catch (error) {
      logger.debug('Failed to get query ID cache from storage:', error)
      return null
    }
  }

  async setQueryIdCache(cache: QueryIdCache): Promise<void> {
    try {
      await this.runtime.storage.set(QUERY_ID_STORAGE_KEY, cache)
    } catch (error) {
      logger.debug('Failed to save query ID cache to storage:', error)
    }
  }

  async getQueryId(operation: QueryName): Promise<string> {
    const cache = await this.getQueryIdCache()
    if (cache && Date.now() - cache.fetchedAt < cache.ttlMs) {
      const operationName = OPERATION_NAMES[operation]
      const id = cache.ids[operationName]
      if (id) {
        logger.debug(`Using cached query ID for ${operation}: ${id}`)
        return id
      }
    }
    try {
      await this.refreshQueryIds()
      const refreshed = await this.getQueryIdCache()
      const operationName = OPERATION_NAMES[operation]
      const id = refreshed?.ids[operationName]
      if (id) {
        logger.debug(`Using refreshed query ID for ${operation}: ${id}`)
        return id
      }
    } catch (error) {
      logger.warn('Failed to refresh query IDs:', error)
    }
    logger.debug(`Using fallback query ID for ${operation}: ${FALLBACK_QUERY_IDS[operation]}`)
    return FALLBACK_QUERY_IDS[operation]
  }

  async refreshQueryIds(force = false): Promise<void> {
    if (this.queryIdRefreshInProgress) return this.queryIdRefreshInProgress
    if (!force) {
      const cache = await this.getQueryIdCache()
      if (cache && Date.now() - cache.fetchedAt < cache.ttlMs) {
        logger.debug('Query ID cache still fresh, skipping refresh')
        return
      }
    }
    this.queryIdRefreshInProgress = this.doRefreshQueryIds()
    try {
      await this.queryIdRefreshInProgress
    } finally {
      this.queryIdRefreshInProgress = null
    }
  }

  async doRefreshQueryIds(): Promise<void> {
    logger.info('Refreshing X Query IDs from JS bundles...')
    try {
      const bundles = await this.discoverBundles()
      logger.debug(`Discovered ${bundles.length} bundles`)
      if (bundles.length === 0) throw new Error('No JS bundles found')
      const wantedOperations = new Set(Object.values(OPERATION_NAMES))
      const ids = await this.extractQueryIdsFromBundles(bundles, wantedOperations)
      logger.debug('Discovered query IDs:', Object.fromEntries(ids))
      if (ids.size === 0) throw new Error('No query IDs extracted from bundles')
      const cache: QueryIdCache = {
        ids: Object.fromEntries(ids),
        fetchedAt: Date.now(),
        ttlMs: QUERY_ID_TTL_MS,
      }
      await this.setQueryIdCache(cache)
      logger.info(`Refreshed ${ids.size} query IDs`)
    } catch (error) {
      logger.error('Failed to refresh query IDs:', error)
      throw error
    }
  }

  async discoverBundles(): Promise<string[]> {
    const urls = new Set<string>()
    for (const page of DISCOVERY_PAGES) {
      try {
        logger.debug(`Fetching discovery page: ${page}`)
        const html = await (await this.runtime.fetch(page, { credentials: 'include' })).text()
        for (const match of html.matchAll(BUNDLE_URL_REGEX)) {
          urls.add(match[0])
        }
      } catch (error) {
        logger.debug(`Failed to fetch ${page}:`, error)
      }
    }
    return Array.from(urls)
  }

  async extractQueryIdsFromBundles(
    bundles: string[],
    wantedOperations: Set<string>
  ): Promise<Map<string, string>> {
    const found = new Map<string, string>()
    const concurrency = 4
    for (let i = 0; i < bundles.length && !(found.size >= wantedOperations.size); i += concurrency) {
      const batch = bundles.slice(i, i + concurrency)
      await Promise.all(
        batch.map(async (bundle) => {
          if (!(found.size >= wantedOperations.size)) {
            try {
              const js = await (await this.runtime.fetch(bundle)).text()
              this.extractOperationsFromJs(js, wantedOperations, found)
            } catch (error) {
              logger.debug(`Failed to fetch bundle ${bundle}:`, error)
            }
          }
        })
      )
    }
    return found
  }

  extractOperationsFromJs(
    js: string,
    wantedOperations: Set<string>,
    found: Map<string, string>
  ): void {
    for (const pattern of QUERY_ID_PATTERNS) {
      pattern.regex.lastIndex = 0
      let match: RegExpExecArray | null
      while ((match = pattern.regex.exec(js)) !== null) {
        const operation = match[pattern.operationGroup]
        const queryId = match[pattern.queryIdGroup]
        if (
          (operation || queryId) &&
          wantedOperations.has(operation) &&
          !found.has(operation) &&
          /^[a-zA-Z0-9_-]+$/.test(queryId)
        ) {
          found.set(operation, queryId)
          logger.debug(`Found ${operation}: ${queryId}`)
          if (found.size >= wantedOperations.size) return
        }
      }
    }
  }

  async graphqlRequest(
    operation: QueryName,
    variables: Record<string, unknown>,
    options?: GraphQLRequestOptions
  ): Promise<GraphQLResponse> {
    const attempt = async (): Promise<{ data: GraphQLResponse; status: number }> => {
      const queryId = await this.getQueryId(operation)
      const operationName = OPERATION_NAMES[operation]
      const commonHeaders = await this.getCommonHeaders()
      const response = await this.runtime.fetch(
        `https://x.com/i/api/graphql/${queryId}/${operationName}`,
        {
          method: 'POST',
          credentials: 'include',
          headers: { ...commonHeaders, 'content-type': 'application/json' },
          body: JSON.stringify({ variables, features: GRAPHQL_FEATURES, queryId }),
        }
      )
      return { data: (await response.json()) as GraphQLResponse, status: response.status }
    }
    const first = await attempt()
    if (first.status === 404 && options?.retry404 !== false) {
      logger.warn(`Got 404 for ${operation}, refreshing query IDs and retrying...`)
      await this.refreshQueryIds(true)
      return (await attempt()).data
    }
    return first.data
  }

  async getCsrfToken(): Promise<string> {
    if (this.csrfToken) return this.csrfToken
    try {
      const cookie = await this.runtime.getCookie?.('https://x.com', 'ct0')
      if (cookie) {
        this.csrfToken = cookie
        logger.debug('Got CSRF token from cookie API')
        return this.csrfToken
      }
    } catch (error) {
      logger.debug('Cookie API failed:', error)
    }
    if (this.runtime.tabs) {
      try {
        const tabId = await this.ensureXTab()
        const result = await this.runtime.tabs.executeScript<
          { success: boolean; token?: string; error?: string },
          []
        >(
          tabId,
          async () => {
            try {
              const cookies = document.cookie.split(';')
              for (const cookie of cookies) {
                const [name, value] = cookie.trim().split('=')
                if (name === 'ct0' && value) {
                  return { success: true, token: value }
                }
              }
              return { success: false, error: 'ct0 cookie not found' }
            } catch (error) {
              return { success: false, error: (error as Error).message }
            }
          },
          []
        )
        if (result?.success && result.token) {
          this.csrfToken = result.token
          logger.debug('Got CSRF token from executeScript')
          return this.csrfToken
        }
        logger.debug('executeScript failed to get ct0:', result?.error)
      } catch (error) {
        logger.debug('executeScript error:', error)
      }
    }
    throw new Error('请先登录 X (Twitter)')
  }

  async ensureXTab(): Promise<number> {
    if (!this.runtime.tabs) throw new Error('X 发布需要浏览器 tabs API 支持')
    const tabs = await this.runtime.tabs.query('https://x.com/*')
    if (tabs.length > 0 && tabs[0].id) return tabs[0].id
    logger.info('No existing X tab found, creating new one...')
    const tab = await this.runtime.tabs.create('https://x.com/compose/articles', false)
    await this.runtime.tabs.waitForLoad(tab.id, 30000)
    logger.info('New X tab created and loaded:', tab.id)
    return tab.id
  }

  async getXPForwardedFor(): Promise<string> {
    if (this.xpForwardedFor && Date.now() < this.xpForwardedFor.expiryTimeMillis) {
      logger.debug('Using cached XP forwarded-for')
      return this.xpForwardedFor.str
    }
    if (!this.runtime.tabs) {
      logger.warn('tabs API not available, skipping XP forwarded-for')
      return ''
    }
    try {
      const tabId = await this.ensureXTab()
      logger.debug('Getting XP forwarded-for from tab:', tabId)
      const result = await this.runtime.tabs.executeScript<
        { success: boolean; data?: { str: string; expiryTimeMillis: string }; error?: string },
        []
      >(
        tabId,
        async () => {
          try {
            const sdk = (
              window as Window & {
                XPForwardedForSDK?: {
                  getForwardedForStr?: () => Promise<{ str: string; expiryTimeMillis: string }>
                }
              }
            ).XPForwardedForSDK
            if (!sdk || typeof sdk.getForwardedForStr !== 'function') {
              return { success: false, error: 'XPForwardedForSDK not found' }
            }
            return { success: true, data: await sdk.getForwardedForStr() }
          } catch (error) {
            return { success: false, error: (error as Error).message }
          }
        },
        []
      )
      if (!result || !result.success || !result.data) {
        logger.warn('Failed to get XP forwarded-for:', result?.error)
        return ''
      }
      this.xpForwardedFor = {
        str: result.data.str,
        expiryTimeMillis: parseInt(result.data.expiryTimeMillis, 10),
      }
      logger.debug('Got XP forwarded-for, expires at:', new Date(this.xpForwardedFor.expiryTimeMillis))
      return this.xpForwardedFor.str
    } catch (error) {
      logger.warn('Error getting XP forwarded-for:', error)
      return ''
    }
  }

  generateTransactionId(): string {
    const timestamp = Date.now().toString(36)
    const random = Math.random().toString(36).substring(2, 15)
    return `${timestamp}${random}`
  }

  async getCommonHeaders(): Promise<Record<string, string>> {
    const [csrfToken, xpForwardedFor] = await Promise.all([
      this.getCsrfToken(),
      this.getXPForwardedFor(),
    ])
    const headers: Record<string, string> = {
      authorization: `Bearer ${WEB_BEARER_TOKEN.replace(/=/g, '%3D')}`,
      'x-csrf-token': csrfToken,
      'x-twitter-active-user': 'yes',
      'x-twitter-auth-type': 'OAuth2Session',
      'x-twitter-client-language': 'en',
      'x-client-transaction-id': this.generateTransactionId(),
      'sec-ch-ua-mobile': '?0',
      'sec-ch-ua-platform': '"macOS"',
    }
    if (xpForwardedFor) headers['x-xp-forwarded-for'] = xpForwardedFor
    return headers
  }

  async setupHeaderRules(): Promise<void> {
    if (this.headerRuleIds.length > 0) return
    await this.addHeaderRules([
      {
        urlFilter: '*://x.com/i/api/*',
        headers: { Origin: 'https://x.com', Referer: 'https://x.com/compose/articles' },
        resourceTypes: ['xmlhttprequest'],
      },
      {
        urlFilter: '*://upload.x.com/*',
        headers: { Origin: 'https://x.com', Referer: 'https://x.com/' },
        resourceTypes: ['xmlhttprequest'],
      },
    ])
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      await this.setupHeaderRules()
      const html = await (await this.runtime.fetch('https://x.com/home', { credentials: 'include' })).text()
      logger.debug('Fetched x.com/home, length:', html.length)
      const stateIndex = html.indexOf('window.__INITIAL_STATE__=')
      if (stateIndex === -1) {
        logger.debug('Failed to find __INITIAL_STATE__')
        await this.clearHeaderRules()
        return { isAuthenticated: false }
      }
      const jsonStart = html.indexOf('{', stateIndex)
      if (jsonStart === -1) {
        logger.debug('Failed to find JSON start')
        await this.clearHeaderRules()
        return { isAuthenticated: false }
      }
      let depth = 0
      let jsonEnd = jsonStart
      for (let i = jsonStart; i < html.length; i++) {
        if (html[i] === '{') depth++
        else if (html[i] === '}') depth--
        if (depth === 0) {
          jsonEnd = i + 1
          break
        }
      }
      const jsonText = html.slice(jsonStart, jsonEnd)
      logger.debug('Extracted JSON length:', jsonText.length)
      let state: unknown
      try {
        state = JSON.parse(jsonText)
      } catch (error) {
        logger.debug('Failed to parse __INITIAL_STATE__:', error)
        await this.clearHeaderRules()
        return { isAuthenticated: false }
      }
      const entities = (
        state as {
          entities?: { users?: { entities?: Record<string, XUserEntity> } }
        }
      )?.entities?.users?.entities
      if (!entities) {
        logger.debug('No user entities found in state')
        await this.clearHeaderRules()
        return { isAuthenticated: false }
      }
      const userIds = Object.keys(entities)
      if (userIds.length === 0) {
        logger.debug('No user IDs found')
        await this.clearHeaderRules()
        return { isAuthenticated: false }
      }
      const firstUserId = userIds[0]
      const user = entities[firstUserId]
      if (user) {
        this.userInfo = {
          userId: user.id_str,
          username: user.screen_name,
          name: user.name,
          avatar: user.profile_image_url_https,
        }
        logger.info('X auth success:', this.userInfo.username)
        await this.clearHeaderRules()
        return {
          isAuthenticated: true,
          userId: this.userInfo.userId,
          username: this.userInfo.username,
          avatar: this.userInfo.avatar,
        }
      }
      await this.clearHeaderRules()
      return { isAuthenticated: false }
    } catch (error) {
      await this.clearHeaderRules()
      logger.error('checkAuth error:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    await this.setupHeaderRules()
    try {
      logger.info('Starting publish to X...')
      const draftId = await this.createDraft()
      logger.debug('Created draft:', draftId)
      await this.updateTitle(draftId, article.title)
      logger.debug('Updated title')
      const content = await this.markdownToDraftContent(article.markdown, options?.onImageProgress)
      logger.debug('Converted content to Draft.js format')
      await this.updateContent(draftId, content)
      logger.debug('Updated content')
      const postUrl = `https://x.com/compose/articles/edit/${draftId}`
      await this.clearHeaderRules()
      return this.createResult(true, {
        postId: draftId,
        postUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    } catch (error) {
      await this.clearHeaderRules()
      logger.error('Publish failed:', error)
      return this.createResult(false, { error: (error as Error).message })
    }
  }

  async createDraft(): Promise<string> {
    const response = await this.graphqlRequest('createDraft', {
      content_state: { blocks: [], entity_map: [] },
      title: '',
    })
    if (response.errors?.length) {
      throw new Error(response.errors[0].message)
    }
    const restId = (
      response.data as {
        articleentity_create_draft?: {
          article_entity_results?: { result?: { rest_id?: string } }
        }
      } | undefined
    )?.articleentity_create_draft?.article_entity_results?.result?.rest_id
    if (!restId) {
      throw new Error('创建草稿失败')
    }
    return restId
  }

  async updateTitle(articleEntityId: string, title: string): Promise<void> {
    const response = await this.graphqlRequest('updateTitle', {
      articleEntityId,
      title,
    })
    if (response.errors?.length) {
      throw new Error(response.errors[0].message)
    }
  }

  async updateContent(articleEntityId: string, contentState: XDraftContent): Promise<void> {
    const response = await this.graphqlRequest('updateContent', {
      content_state: contentState,
      article_entity: articleEntityId,
    })
    if (response.errors?.length) {
      throw new Error(response.errors[0].message)
    }
  }

  async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    let blob: Blob
    let mimeType: string
    if (src.startsWith('data:')) {
      const match = src.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) throw new Error('Invalid data URI')
      mimeType = match[1]
      const binary = atob(match[2])
      const bytes = new Uint8Array(binary.length)
      for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
      blob = new Blob([bytes], { type: mimeType })
    } else {
      blob = await (await fetch(src)).blob()
      mimeType = blob.type || 'image/jpeg'
    }
    const commonHeaders = await this.getCommonHeaders()
    const initUrl = `https://upload.x.com/i/media/upload.json?command=INIT&total_bytes=${blob.size}&media_type=${encodeURIComponent(mimeType)}&media_category=tweet_image`
    const initResult = await (
      await this.runtime.fetch(initUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { ...commonHeaders, 'content-length': '0' },
      })
    ).json() as { media_id_string?: string; error?: string }
    if (!initResult.media_id_string) {
      throw new Error(initResult.error || '图片上传初始化失败')
    }
    const mediaId = initResult.media_id_string
    logger.debug('Media INIT complete, mediaId:', mediaId)
    const formData = new FormData()
    formData.append('media', blob, 'image.jpg')
    const appendUrl = `https://upload.x.com/i/media/upload.json?command=APPEND&media_id=${mediaId}&segment_index=0`
    await this.runtime.fetch(appendUrl, {
      method: 'POST',
      credentials: 'include',
      headers: commonHeaders,
      body: formData,
    })
    logger.debug('Media APPEND complete')
    const finalizeUrl = `https://upload.x.com/i/media/upload.json?command=FINALIZE&media_id=${mediaId}`
    const finalizeResult = await (
      await this.runtime.fetch(finalizeUrl, {
        method: 'POST',
        credentials: 'include',
        headers: { ...commonHeaders, 'content-length': '0' },
      })
    ).json() as { media_id_string?: string; error?: string }
    if (!finalizeResult.media_id_string) {
      throw new Error(finalizeResult.error || '图片上传完成失败')
    }
    logger.debug('Media FINALIZE complete')
    return { url: mediaId, attrs: { 'media-id': mediaId } }
  }

  generateBlockKey(): string {
    const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
    let key = ''
    for (let i = 0; i < 5; i++) {
      key += chars.charAt(Math.floor(Math.random() * chars.length))
    }
    return key
  }

  generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = (Math.random() * 16) | 0
      return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16)
    })
  }

  convertInlineStyle(style: string): string | null {
    const styleMap: Record<string, string> = {
      BOLD: 'Bold',
      bold: 'Bold',
      ITALIC: 'Italic',
      italic: 'Italic',
      STRIKETHROUGH: 'Strikethrough',
      strikethrough: 'Strikethrough',
    }
    return styleMap[style] || null
  }

  async markdownToDraftContent(
    markdown: string,
    onImageProgress?: (current: number, total: number) => void
  ): Promise<XDraftContent> {
    const placeholders: XImagePlaceholder[] = []
    let index = 0
    let content = markdown
    for (const image of parseMarkdownImages(markdown)) {
      const replacement = `

[XIMG_PLACEHOLDER_${index}]

`
      placeholders.push({
        placeholder: `[XIMG_PLACEHOLDER_${index}]`,
        src: image.src,
        alt: image.alt || '',
      })
      content = content.replace(image.full, replacement)
      index++
    }

    const uploadedUrls = new Map<string, string>()
    let uploaded = 0
    for (const { src } of placeholders) {
      if (!uploadedUrls.has(src)) {
        uploaded++
        onImageProgress?.(uploaded, placeholders.length)
        try {
          logger.debug(`Uploading image ${uploaded}/${placeholders.length}: ${src.substring(0, 50)}...`)
          const result = await this.uploadImageByUrl(src)
          uploadedUrls.set(src, result.url)
          logger.debug(`Uploaded image ${uploaded}, mediaId: ${result.url}`)
          await this.delay(500)
        } catch (error) {
          logger.error('Failed to upload image:', error)
        }
      }
    }

    const draft = markdownToDraft(content)
    const blocks: XDraftBlock[] = []
    const entities: XDraftEntityEntry[] = []
    let localMediaId = 1
    const entityKeyMap = new Map<number, number>()
    let nextEntityKey = 0

    for (const [entityKeyStr, entity] of Object.entries(draft.entityMap)) {
      const oldKey = parseInt(entityKeyStr, 10)
      const type = entity.type.toUpperCase()
      if (type === 'IMAGE') {
        const src = (entity.data?.src as string | undefined) || ''
        const mediaId = uploadedUrls.get(src)
        if (mediaId) {
          const newKey = nextEntityKey++
          entityKeyMap.set(oldKey, newKey)
          entities.push({
            key: String(newKey),
            value: {
              type: 'MEDIA',
              mutability: 'Immutable',
              data: {
                entity_key: this.generateUUID(),
                media_items: [
                  {
                    local_media_id: localMediaId++,
                    media_category: 'DraftTweetImage',
                    media_id: mediaId,
                  },
                ],
              },
            },
          })
        }
      } else if (type === 'LINK') {
        const newKey = nextEntityKey++
        entityKeyMap.set(oldKey, newKey)
        entities.push({
          key: String(newKey),
          value: {
            type: 'LINK',
            mutability: 'Mutable',
            data: {
              url:
                (entity.data?.url as string | undefined) ||
                (entity.data?.href as string | undefined) ||
                '',
            },
          },
        })
      }
    }

    for (const block of draft.blocks) {
      const blockKey = block.key || this.generateBlockKey()
      const placeholderMatch = block.text.match(/^\[XIMG_PLACEHOLDER_(\d+)\]$/)
      if (placeholderMatch) {
        const placeholderIndex = parseInt(placeholderMatch[1], 10)
        const placeholder = placeholders[placeholderIndex]
        if (placeholder) {
          const mediaId = uploadedUrls.get(placeholder.src)
          if (mediaId) {
            const entityKey = nextEntityKey++
            entities.push({
              key: String(entityKey),
              value: {
                type: 'MEDIA',
                mutability: 'Immutable',
                data: {
                  entity_key: this.generateUUID(),
                  media_items: [
                    {
                      local_media_id: localMediaId++,
                      media_category: 'DraftTweetImage',
                      media_id: mediaId,
                    },
                  ],
                },
              },
            })
            blocks.push({
              key: blockKey,
              type: 'atomic',
              text: ' ',
              data: {},
              entity_ranges: [{ key: entityKey, offset: 0, length: 1 }],
              inline_style_ranges: [],
            })
            continue
          }
        }
        continue
      }
      let type = 'unstyled'
      const rawType = block.type
      if (rawType === 'header-one' || rawType === 'header-two') {
        type = rawType
      } else if (
        rawType === 'header-three' ||
        rawType === 'header-four' ||
        rawType === 'header-five' ||
        rawType === 'header-six'
      ) {
        type = 'header-two'
      } else if (rawType === 'blockquote') {
        type = 'blockquote'
      } else if (rawType === 'unordered-list-item') {
        type = 'unordered-list-item'
      } else if (rawType === 'ordered-list-item') {
        type = 'ordered-list-item'
      } else if (rawType === 'code-block') {
        const entityKey = nextEntityKey++
        entities.push({
          key: String(entityKey),
          value: {
            type: 'MARKDOWN',
            mutability: 'Mutable',
            data: { markdown: '```\n' + block.text + '\n```' },
          },
        })
        blocks.push({
          key: blockKey,
          type: 'atomic',
          text: ' ',
          data: {},
          entity_ranges: [{ key: entityKey, offset: 0, length: 1 }],
          inline_style_ranges: [],
        })
        continue
      } else if (
        rawType === 'hr' ||
        rawType === 'horizontal-rule' ||
        (rawType === 'unstyled' && /^(-{3,}|\*{3,}|_{3,})$/.test(block.text.trim()))
      ) {
        const entityKey = nextEntityKey++
        entities.push({
          key: String(entityKey),
          value: { type: 'DIVIDER', mutability: 'Immutable', data: {} },
        })
        blocks.push({
          key: blockKey,
          type: 'atomic',
          text: ' ',
          data: {},
          entity_ranges: [{ key: entityKey, offset: 0, length: 1 }],
          inline_style_ranges: [],
        })
        continue
      } else if (rawType === 'unstyled' && /^\$\$[\s\S]+\$\$$/.test(block.text.trim())) {
        const latex = block.text.trim().slice(2, -2).trim()
        const entityKey = nextEntityKey++
        entities.push({
          key: String(entityKey),
          value: { type: 'LATEX', mutability: 'Immutable', data: {} },
        })
        blocks.push({
          key: blockKey,
          type: 'atomic',
          text: latex,
          data: {},
          entity_ranges: [{ key: entityKey, offset: 0, length: latex.length }],
          inline_style_ranges: [],
        })
        continue
      } else if (rawType === 'atomic') {
        type = 'atomic'
      } else {
        type = 'unstyled'
      }
      const entityRanges: Array<{ key: number; offset: number; length: number }> = []
      if (block.entityRanges) {
        for (const range of block.entityRanges) {
          const mappedKey = entityKeyMap.get(range.key)
          if (mappedKey !== undefined) {
            entityRanges.push({ key: mappedKey, offset: range.offset, length: range.length })
          }
        }
      }
      const inlineStyleRanges: Array<{ style: string; offset: number; length: number }> = []
      if (block.inlineStyleRanges) {
        for (const range of block.inlineStyleRanges) {
          const style = this.convertInlineStyle(range.style)
          if (style) {
            inlineStyleRanges.push({ style, offset: range.offset, length: range.length })
          }
        }
      }
      blocks.push({
        key: blockKey,
        type,
        text: block.text || '',
        data: block.data || {},
        entity_ranges: entityRanges,
        inline_style_ranges: inlineStyleRanges,
      })
    }

    if (blocks.length === 0) {
      blocks.push({
        key: this.generateBlockKey(),
        type: 'unstyled',
        text: '',
        data: {},
        entity_ranges: [],
        inline_style_ranges: [],
      })
    }
    return { blocks, entity_map: entities }
  }
}
