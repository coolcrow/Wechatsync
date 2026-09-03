/**
 * 大鱼号适配器（移植自官方构建，GPL-3.0）
 *
 * 认证：抓取 mp.dayu.com/dashboard/index 页面内嵌的 globalConfig
 * JS 变量（utoken / wmid / weMediaName 等）判断登录态。
 * 发布：POST dashboard/save-draft 保存草稿（始终 draftOnly）；
 * 图片经 ns.dayu.com/article/imageUpload 上传后替换 URL。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('DaYu')

/** dashboard 页面 globalConfig 变量解析结果 */
interface DayuGlobalConfig {
  utoken?: string
  nsImageUploadSign?: string
  wmid?: string
  weMediaName?: string
  wmAvator?: string
}

/** checkAuth 成功后缓存的账号信息 */
interface DayuCacheMeta {
  utoken: string
  uploadSign?: string
  uid?: string
  title?: string
  avatar?: string
}

/** save-draft 接口响应 */
interface DayuSaveDraftResponse {
  error?: string
  data?: { _id?: string }
}

/** ns.dayu.com 图片上传响应 */
interface DayuUploadResponse {
  data?: { imgInfo?: { org_url?: string; url?: string } }
}

/** 已上传图片记录（用于取第一张作封面） */
interface DayuUploadedImage {
  org_url?: string
  url: string
}

export class DaYuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'dayu',
    name: '大鱼号',
    icon: 'https://image.uc.cn/s/uae/g/1v/images/index/favicon.ico',
    homepage: 'https://mp.dayu.com/dashboard/account/profile',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = { outputFormat: 'html' as const }

  private cacheMeta: DayuCacheMeta | null = null
  private uploadedImages: DayuUploadedImage[] = []

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://mp.dayu.com/*',
      headers: { Origin: 'https://mp.dayu.com', Referer: 'https://mp.dayu.com/' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://ns.dayu.com/*',
      headers: { Origin: 'https://mp.dayu.com', Referer: 'https://mp.dayu.com/' },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const html = await (
        await this.runtime.fetch('https://mp.dayu.com/dashboard/index', {
          method: 'GET',
          credentials: 'include',
        })
      ).text()
      const marker = 'var globalConfig = '
      const idx = html.indexOf(marker)
      if (idx === -1) return { isAuthenticated: false }
      const raw = html.substring(idx + marker.length, html.indexOf('var G = {', idx))
      const config = this.parseGlobalConfig(raw)
      if (!config || !config.utoken) return { isAuthenticated: false }
      const avatarRaw = config.wmAvator
      const avatar =
        avatarRaw !== undefined && avatarRaw.indexOf('http') > -1
          ? avatarRaw
          : avatarRaw?.replace('//', 'https://') || ''
      this.cacheMeta = {
        utoken: config.utoken,
        uploadSign: config.nsImageUploadSign,
        uid: config.wmid,
        title: config.weMediaName,
        avatar,
      }
      return {
        isAuthenticated: true,
        userId: this.cacheMeta.uid,
        username: this.cacheMeta.title,
        avatar: this.cacheMeta.avatar,
      }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  parseGlobalConfig(source: string): DayuGlobalConfig | null {
    try {
      let text = source.trim()
      if (text.endsWith(';')) text = text.slice(0, -1)
      const normalized = text
        .replace(/'/g, '"')
        .replace(/(\w+):/g, '"$1":')
        .replace(/,\s*}/g, '}')
        .replace(/,\s*]/g, ']')
      return JSON.parse(normalized) as DayuGlobalConfig
    } catch {
      const result: Record<string, string> = {}
      const patterns: Record<string, RegExp> = {
        utoken: /utoken['":\s]+['"]([^'"]+)['"]/,
        nsImageUploadSign: /nsImageUploadSign['":\s]+['"]([^'"]+)['"]/,
        wmid: /wmid['":\s]+['"]([^'"]+)['"]/,
        weMediaName: /weMediaName['":\s]+['"]([^'"]+)['"]/,
        wmAvator: /wmAvator['":\s]+['"]([^'"]+)['"]/,
      }
      for (const [key, pattern] of Object.entries(patterns)) {
        const match = source.match(pattern)
        if (match) result[key] = match[1]
      }
      return Object.keys(result).length > 0 ? result : null
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')
      this.uploadedImages = []
      if (!this.cacheMeta && !(await this.checkAuth()).isAuthenticated) {
        throw new Error('请先登录大鱼号')
      }
      const meta = this.cacheMeta as DayuCacheMeta
      let content = article.html || ''
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src), {
        skipPatterns: ['dayu.com', 'uc.cn'],
        onProgress: options?.onImageProgress,
      })
      const coverImg = this.uploadedImages.length > 0 ? this.uploadedImages[0].url : ''
      const params = new URLSearchParams()
      params.append('title', article.title)
      params.append('content', content)
      params.append('author', String(meta.title))
      params.append('coverImg', coverImg)
      params.append('article_type', '1')
      params.append('utoken', meta.utoken)
      params.append('cover_from', 'auto')
      const resp = (await (
        await this.runtime.fetch('https://mp.dayu.com/dashboard/save-draft', {
          method: 'POST',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
            utoken: meta.utoken,
          },
          body: params,
        })
      ).json()) as DayuSaveDraftResponse
      logger.debug('Save response:', resp)
      if (resp.error) throw new Error(resp.error)
      if (!resp.data?._id) throw new Error('保存草稿失败')
      const draftId = resp.data._id
      const postUrl = `https://mp.dayu.com/dashboard/article/write?draft_id=${draftId}`
      return this.createResult(true, {
        postId: draftId,
        postUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, { error: (error as Error).message }))
  }

  async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.cacheMeta) throw new Error('未登录')
    const meta = this.cacheMeta
    const response = await fetch(src)
    if (!response.ok) throw new Error('图片下载失败: ' + src)
    const blob = await response.blob()
    const uploadUrl = `https://ns.dayu.com/article/imageUpload?appid=website&fromMaterial=0&wmid=${meta.uid}&wmname=${encodeURIComponent(String(meta.title))}&sign=${meta.uploadSign}`
    const formData = new FormData()
    const filename = `${Date.now()}.jpg`
    formData.append('upfile', blob, filename)
    formData.append('type', blob.type || 'image/jpeg')
    formData.append('id', 'WU_FILE_1')
    formData.append('fileid', `uploadm-${Math.floor(Math.random() * 1e6)}`)
    formData.append('name', filename)
    formData.append('lastModifiedDate', new Date().toString())
    formData.append('size', String(blob.size))
    const resp = (await (
      await this.runtime.fetch(uploadUrl, {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
    ).json()) as DayuUploadResponse
    logger.debug('Image upload response:', resp)
    if (!resp.data?.imgInfo?.url) throw new Error('图片上传失败')
    const uploaded: DayuUploadedImage = {
      org_url: resp.data.imgInfo.org_url,
      url: resp.data.imgInfo.url,
    }
    this.uploadedImages.push(uploaded)
    return { url: uploaded.url }
  }
}
