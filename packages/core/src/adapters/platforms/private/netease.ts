/**
 * 网易号适配器（移植自官方构建，GPL-3.0）
 *
 * 认证：GET wemedia/navinfo.do 检查返回的 tid。
 * 发布：先在 mp.163.com 页面上下文调用 window.neg.getToken()
 * 取 ursToken，再 POST publishV2.do（operation=saveDraft）
 * 保存草稿（始终 draftOnly）；图片走 uploadCoverImage.do。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('Netease')

/** navinfo.do 返回的账号信息 */
interface NeteaseAccountInfo {
  tid: string
  tname?: string
  icon?: string
  realUserId?: string
}

/** navinfo.do 响应 */
interface NeteaseNavResponse {
  code?: number
  data?: NeteaseAccountInfo
}

/** publishV2.do 响应 */
interface NeteasePublishResponse {
  code?: number
  msg?: string
  data?: string
}

/** uploadCoverImage.do 响应 */
interface NeteaseUploadResponse {
  code?: number
  msg?: string
  data?: { url?: string; picUrl?: string }
}

export class NeteaseAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'netease',
    name: '网易号',
    icon: 'https://static.ws.126.net/163/f2e/news/yxybd_pc/resource/static/share-icon.png',
    homepage: 'https://mp.163.com/#/article-publish',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = { outputFormat: 'html' as const, convertTablesToText: true }

  private accountInfo: NeteaseAccountInfo | null = null

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.163.com/*',
      headers: {
        Origin: 'https://mp.163.com',
        Referer: 'https://mp.163.com/subscribe_v4/index.html',
      },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const resp = await this.get<NeteaseNavResponse>(
        `https://mp.163.com/wemedia/navinfo.do?_=${Date.now()}`
      )
      logger.debug('checkAuth response:', resp)
      if (resp.code !== 1 || !resp.data?.tid) {
        return { isAuthenticated: false }
      }
      this.accountInfo = resp.data
      return {
        isAuthenticated: true,
        userId: resp.data.tid,
        username: resp.data.tname,
        avatar: resp.data.icon,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')
      if (!this.accountInfo && !(await this.checkAuth()).isAuthenticated) {
        throw new Error('请先登录网易号')
      }
      const account = this.accountInfo as NeteaseAccountInfo
      const ursToken = await this.fetchUrsToken()
      let content = article.html || ''
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src), {
        skipPatterns: ['126.net', '163.com', 'netease.com'],
        onProgress: options?.onImageProgress,
      })
      const wemediaId = account.tid
      const realUserId = account.realUserId || ''
      const now = Date.now()
      const params = new URLSearchParams()
      params.append('wemediaId', wemediaId)
      params.append('articleId', '-1')
      params.append('title', article.title)
      params.append('content', content)
      params.append('cover', 'threeImg')
      params.append('operation', 'saveDraft')
      params.append('scheduled', '0')
      params.append('ursToken', ursToken)
      params.append('onlineState', '1')
      params.append('picUrl', '')
      params.append('original', '0')
      params.append('subjectId', '')
      const url = `https://mp.163.com/wemedia/article/status/api/publishV2.do?_=${now}&wemediaId=${wemediaId}&realUserId=${encodeURIComponent(realUserId)}`
      const resp = (await (
        await this.runtime.fetch(url, {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded; charset=UTF-8',
            'X-Requested-With': 'XMLHttpRequest',
          },
          body: params.toString(),
        })
      ).json()) as NeteasePublishResponse
      logger.debug('Publish response:', resp)
      if (resp.code !== 1) throw new Error(resp.msg || '保存草稿失败')
      let docId = ''
      if (resp.data) {
        docId = new URLSearchParams(resp.data).get('docId') || resp.data
      }
      const postUrl = `https://mp.163.com/subscribe_v4/index.html#/article-publish/${docId}?option=editDraft`
      return this.createResult(true, {
        postId: docId,
        postUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, { error: (error as Error).message }))
  }

  async ensureNeteaseTab(): Promise<number> {
    if (!this.runtime.tabs) throw new Error('网易号发布需要浏览器 tabs API 支持')
    const tabs = await this.runtime.tabs.query('https://mp.163.com/*')
    if (tabs.length > 0 && tabs[0].id) return tabs[0].id
    logger.info('No existing tab found, creating new one...')
    const tab = await this.runtime.tabs.create(
      'https://mp.163.com/subscribe_v4/index.html#/article-publish',
      false
    )
    await this.runtime.tabs.waitForLoad(tab.id, 30000)
    logger.info('New tab created and loaded:', tab.id)
    return tab.id
  }

  async fetchUrsToken(): Promise<string> {
    if (!this.runtime.tabs) {
      logger.warn('No tabs API, cannot get ursToken')
      return ''
    }
    const tabId = await this.ensureNeteaseTab()
    logger.debug('Using tab:', tabId, 'to get ursToken')
    const result = await this.runtime.tabs.executeScript<
      { success: boolean; token?: string; error?: string },
      []
    >(
      tabId,
      async () => {
        try {
          const neg = (
            window as Window & {
              neg?: { getToken?: () => Promise<{ code: number; token?: string }> }
            }
          ).neg
          if (!neg?.getToken) return { success: false, error: 'neg.getToken not available' }
          const resp = await neg.getToken()
          if (resp.code === 200 && resp.token) {
            return { success: true, token: resp.token }
          }
          return { success: false, error: `getToken returned code ${resp.code}` }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
      []
    )
    if (result?.success && result.token) {
      logger.debug('Got ursToken via neg.getToken()')
      return result.token
    }
    logger.warn('Failed to get ursToken:', result?.error)
    return ''
  }

  async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.accountInfo) throw new Error('未登录')
    const account = this.accountInfo
    const response = await fetch(src)
    if (!response.ok) throw new Error('图片下载失败: ' + src)
    const blob = await response.blob()
    const formData = new FormData()
    formData.append('file', blob, 'image.jpg')
    const resp = (await (
      await this.runtime.fetch(
        `https://mp.163.com/wemedia/article/api/uploadCoverImage.do?wemediaId=${account.tid}`,
        { method: 'POST', credentials: 'include', body: formData }
      )
    ).json()) as NeteaseUploadResponse
    logger.debug('Image upload response:', resp)
    if (resp.code !== 1 || !resp.data) {
      throw new Error('图片上传失败: ' + (resp.msg || '未知错误'))
    }
    const url = resp.data.url || resp.data.picUrl
    if (!url) throw new Error('图片上传返回数据不完整')
    return { url }
  }
}
