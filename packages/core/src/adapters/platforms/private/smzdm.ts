/**
 * 什么值得买适配器（移植自官方构建，GPL-3.0）
 *
 * 发布路线：先抓取投稿台首页 HTML，从「发布新文章」入口（release-new）
 * 解析出新文章 ID，再把图片上传到 smzdm 图床，最后以表单
 * submit_type=auto_save 保存草稿，用户在编辑页确认发布。
 * 站点存在 WAF 挑战页（probe.js / var buid），所有请求带默认浏览器头，
 * 命中挑战时按递增延迟重试。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('Smzdm')

/** WAF 挑战页检测：命中说明响应被拦截 */
function isWafChallenge(text: string): boolean {
  return text.includes('probe.js') || text.includes('var buid')
}

/** 带随机抖动的延迟（0-500ms 抖动） */
function delayWithJitter(ms: number): Promise<void> {
  const jitter = Math.floor(Math.random() * 500)
  return new Promise((resolve) => setTimeout(resolve, ms + jitter))
}

/** 默认请求头：伪装成同站点的浏览器 XHR */
const DEFAULT_HEADERS: Record<string, string> = {
  Accept: 'application/json, text/plain, */*',
  'sec-ch-ua': '"Not:A-Brand";v="99", "Google Chrome";v="145", "Chromium";v="145"',
  'sec-ch-ua-mobile': '?0',
  'sec-ch-ua-platform': '"macOS"',
  'sec-fetch-dest': 'empty',
  'sec-fetch-mode': 'cors',
  'sec-fetch-site': 'same-origin',
}

interface SmzdmUploadResponse {
  error_code: number
  error_msg?: string
  data?: { url: string }
}

interface SmzdmSubmitResponse {
  error_code: number
  error_msg?: string
  data?: unknown
}

export class SmzdmAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'smzdm',
    name: '什么值得买',
    icon: 'https://www.smzdm.com/favicon.ico',
    homepage: 'https://post.smzdm.com/tougao/',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeLinks: true,
  }

  /** 什么值得买投稿台需要的 Header 规则 */
  private readonly HEADER_RULES = [
    {
      urlFilter: '*://post.smzdm.com/*',
      headers: {
        Origin: 'https://post.smzdm.com',
        Referer: 'https://post.smzdm.com/',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  private _currentArticleId: string | null = null

  async fetchWithRetry(url: string, options: RequestInit, maxRetries = 5): Promise<Response> {
    const headers = {
      ...DEFAULT_HEADERS,
      ...((options.headers as Record<string, string> | undefined) || {}),
    }
    const init = { ...options, headers }
    for (let attempt = 1; attempt <= maxRetries; attempt++) {
      const response = await this.runtime.fetch(url, init)
      const text = await response.clone().text()
      if (!isWafChallenge(text)) {
        return new Response(text, {
          status: response.status,
          statusText: response.statusText,
          headers: response.headers,
        })
      }
      logger.warn(`WAF challenge on attempt ${attempt}/${maxRetries}: ${url}`)
      if (attempt < maxRetries) await delayWithJitter(1500 * attempt)
    }
    throw new Error('请求被 WAF 拦截，请稍后重试')
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const html = await (
        await this.fetchWithRetry('https://post.smzdm.com/tougao/', { credentials: 'include' })
      ).text()
      if (!html.includes('release-new')) {
        return { isAuthenticated: false, error: '未登录' }
      }
      const nameMatch =
        html.match(/class="user-name[^"]*"[^>]*>([^<]+)</) ||
        html.match(/nickname['"]\s*:\s*['"]([^'"]+)/)
      const username = nameMatch ? nameMatch[1].trim() : undefined
      const avatarMatch =
        html.match(/class="user-avatar[^"]*"[^>]*src="([^"]+)"/) ||
        html.match(/avatar['"]\s*:\s*['"]([^'"]+)/)
      const avatar = avatarMatch ? avatarMatch[1] : undefined
      return { isAuthenticated: true, username, avatar }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async createNewArticle(): Promise<string> {
    const html = await (
      await this.fetchWithRetry('https://post.smzdm.com/tougao/', { credentials: 'include' })
    ).text()
    const match =
      html.match(/href="\/edit\/([^"]+)"\s+class="release-new"/) ||
      html.match(/class="release-new"[^>]*href="\/edit\/([^"]+)"/)
    if (!match) {
      throw new Error('无法创建新文章，请确认已登录什么值得买')
    }
    const articleId = match[1]
    logger.debug('Created new article:', articleId)
    return articleId
  }

  async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const blob = await (await this.runtime.fetch(src)).blob()
    if (!this._currentArticleId) {
      throw new Error('上传图片需要先创建文章')
    }
    const formData = new FormData()
    formData.append('imgFile', blob, 'WU_FILE_0')
    formData.append('type', blob.type || 'image/png')
    formData.append('article_id', this._currentArticleId)
    formData.append('insert', '1')
    formData.append('storage', '1')
    formData.append('size', String(blob.size))
    const result = await (
      await this.fetchWithRetry('https://post.smzdm.com/api/images/upload/local', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
    ).json() as SmzdmUploadResponse
    if (result.error_code !== 0 || !result.data?.url) {
      throw new Error(`图片上传失败: ${result.error_msg || JSON.stringify(result)}`)
    }
    logger.debug(`Image uploaded: ${result.data.url}`)
    return { url: result.data.url }
  }

  async publish(article: Article, _options?: PublishOptions): Promise<SyncResult> {
    const timestamp = Date.now()
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      try {
        const articleId = await this.createNewArticle()
        this._currentArticleId = articleId
        await delayWithJitter(800)
        let html = article.html || ''
        html = await this.processImages(html, (src) => this.uploadImageByUrl(src), {
          skipPatterns: ['zdmimg.com', 'smzdm.com'],
        })
        const params = new URLSearchParams()
        params.append('article_id', articleId)
        params.append('submit_type', 'auto_save')
        params.append('title', article.title)
        params.append('editorValue', html)
        params.append('series_title', '')
        params.append('focus_image', '')
        params.append('series_order_id', '0')
        params.append('series_id', '0')
        params.append('anonymous', '0')
        params.append('first_publish', '0')
        params.append('remark', '')
        params.append('create_state_type', '3')
        params.append('ai_state_type', '3')
        params.append('square_pic_url', '')
        params.append('cover_image_rectangle', '')
        params.append('custom_topics', '')
        params.append('group_id', '')
        const result = await (
          await this.fetchWithRetry('https://post.smzdm.com/api/editor/article/submit', {
            method: 'POST',
            credentials: 'include',
            headers: { 'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8' },
            body: params.toString(),
          })
        ).json() as SmzdmSubmitResponse
        if (result.error_code !== 0) {
          throw new Error(`保存草稿失败: ${result.error_msg || JSON.stringify(result)}`)
        }
        logger.debug('Draft saved:', result.data)
        return {
          platform: this.meta.id,
          success: true,
          postId: articleId,
          postUrl: `https://post.smzdm.com/edit/${articleId}`,
          draftOnly: true,
          timestamp,
        }
      } catch (error) {
        return {
          platform: this.meta.id,
          success: false,
          error: (error as Error).message,
          timestamp,
        }
      } finally {
        this._currentArticleId = null
      }
    })
  }
}
