/**
 * 一点号适配器（移植自官方构建，GPL-3.0）
 *
 * 发布路线：从 mp.yidianzixun.com 首页内嵌 script（id="__val_"）中提取
 * window.mpcode 请求码与 window.mpuser 用户信息；图片优先走
 * getImageFromUrl 站内转存，失败回退 multipart 上传；正文以 HTML 提交
 * /model/Article 保存草稿（status=0），用户在一点号写作台确认发布。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('Yidian')

/** window.mpuser 解析后的用户信息 */
interface YidianUser {
  id?: string
  media_name?: string
  media_pic?: string
}

/** getImageFromUrl 站内转存响应 */
interface YidianUrlUploadResponse {
  status: string
  inner_addr?: string
}

/** multipart 上传响应 */
interface YidianMultipartUploadResponse {
  status: string
  url?: string
}

/** /model/Article 保存草稿响应 */
interface YidianArticleResponse {
  id?: string
}

export class YidianAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'yidian',
    name: '一点号',
    icon: 'https://www.yidianzixun.com/favicon.ico',
    homepage: 'https://mp.yidianzixun.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
    removeLinks: true,
  }

  private mpCode: string | null = null

  async checkAuth(): Promise<AuthResult> {
    try {
      const scriptMatch = (
        await (await this.runtime.fetch('https://mp.yidianzixun.com', { credentials: 'include' })).text()
      ).match(/<script id="__val_"[^>]*>([\s\S]*?)<\/script>/)
      if (!scriptMatch) {
        return { isAuthenticated: false, error: '未找到用户数据' }
      }
      const scriptContent = scriptMatch[1]
      const mpCodeMatch = scriptContent.match(/window\.mpcode\s*=\s*['"]([a-f0-9]+)['"]/)
      if (mpCodeMatch) {
        this.mpCode = mpCodeMatch[1]
        logger.debug('mpCode extracted:', this.mpCode)
      }
      const mpUserMatch = scriptContent.match(/window\.mpuser\s*=\s*(\{[\s\S]*?\});/)
      if (!mpUserMatch) {
        return { isAuthenticated: false, error: '未登录' }
      }
      try {
        const user = JSON.parse(mpUserMatch[1]) as YidianUser
        return user.id
          ? {
              isAuthenticated: true,
              userId: user.id,
              username: user.media_name,
              avatar: user.media_pic,
            }
          : { isAuthenticated: false, error: '未登录' }
      } catch {
        return { isAuthenticated: false, error: '解析用户数据失败' }
      }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  getHeaders(contentType?: string): Record<string, string> {
    const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' }
    if (contentType) headers['Content-Type'] = contentType
    if (this.mpCode) headers['x-mp-code'] = this.mpCode
    return headers
  }

  async ensureMpCode(): Promise<void> {
    if (!this.mpCode) {
      await this.checkAuth()
      if (!this.mpCode) logger.warn('mpCode not found, requests may fail')
    }
  }

  async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    await this.ensureMpCode()
    try {
      const headers = this.getHeaders()
      const url = `https://mp.yidianzixun.com/api/getImageFromUrl?src=${encodeURIComponent(src)}`
      const result = await (
        await this.runtime.fetch(url, { credentials: 'include', headers })
      ).json() as YidianUrlUploadResponse
      if (result.status === 'success' && result.inner_addr) {
        logger.debug(`Image uploaded via URL: ${result.inner_addr}`)
        return { url: result.inner_addr }
      }
    } catch (error) {
      logger.debug('URL upload failed, trying multipart upload:', error)
    }
    const blob = await (await this.runtime.fetch(src)).blob()
    const ext = src.match(/\.(png|jpg|jpeg|gif|webp)/i)?.[1] || 'png'
    const filename = `image_${Date.now()}.${ext}`
    const formData = new FormData()
    formData.append('upfile', blob, filename)
    const headers = this.getHeaders()
    const result = await (
      await this.runtime.fetch('https://mp.yidianzixun.com/upload?action=uploadimage&picType=wemedia_cnt', {
        method: 'POST',
        credentials: 'include',
        headers,
        body: formData,
      })
    ).json() as YidianMultipartUploadResponse
    if (result.status !== 'success' || !result.url) {
      throw new Error(`图片上传失败: ${JSON.stringify(result)}`)
    }
    logger.debug(`Image uploaded via multipart: ${result.url}`)
    return { url: result.url }
  }

  async publish(article: Article, _options?: PublishOptions): Promise<SyncResult> {
    const timestamp = Date.now()
    try {
      await this.ensureMpCode()
      let html = article.html || ''
      html = await this.processImages(html, (src) => this.uploadImageByUrl(src))
      const payload = {
        title: article.title,
        cate: '',
        cateB: '',
        coverType: 'default',
        covers: [] as unknown[],
        content: html,
        hasSubTitle: 0,
        subTitle: '',
        original: 0,
        reward: 0,
        videos: [] as unknown[],
        audios: [] as unknown[],
        votes: {
          vote_id: '',
          vote_options: [] as unknown[],
          vote_end_time: '',
          vote_title: '',
          vote_type: 1,
          isAdded: false,
        },
        images: [] as unknown[],
        goods: [] as unknown[],
        is_mobile: 0,
        status: 0,
        import_url: '',
        import_hash: '',
        image_urls: {} as Record<string, unknown>,
        minTimingHour: 3,
        maxTimingDay: 7,
        tags: [] as unknown[],
        isPubed: false,
        lastSaveTime: '',
        dirty: false,
        editorType: 'articleEditor',
        activity_id: 0,
        join_activity: 0,
        wm_globallink: '',
        wm_globaltime: '',
        outsideImages: [] as unknown[],
        wm_content_source: { type: 1 },
        notSaveToStore: true,
      }
      const result = await (
        await this.runtime.fetch('https://mp.yidianzixun.com/model/Article', {
          method: 'POST',
          credentials: 'include',
          headers: this.getHeaders('application/json;charset=UTF-8'),
          body: JSON.stringify(payload),
        })
      ).json() as YidianArticleResponse
      if (!result.id) {
        throw new Error('同步错误: ' + JSON.stringify(result))
      }
      return {
        platform: this.meta.id,
        success: true,
        postId: result.id,
        postUrl: `https://mp.yidianzixun.com/#/Writing/${result.id}`,
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
    }
  }
}
