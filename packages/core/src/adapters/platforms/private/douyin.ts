/**
 * 抖音图文适配器（移植自官方构建，GPL-3.0）
 *
 * 认证：检查 .douyin.com 域 passport_assist_user cookie。
 * 发布：在 creator.douyin.com 页面上下文 POST
 * web/api/media/aweme/draft 保存长文草稿（始终 draftOnly）。
 * 图片：STS 凭证取自 web/api/media/upload/auth/v5，经 ImageX
 * ApplyImageUpload → TOS PUT → CommitImageUpload 上传（AWS4 签名），
 * 再换 get/url 预览 URL 填入草稿 image_info。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'
import { signAWS4, crc32 } from '../../../lib'

const logger = createLogger('Douyin')

// ImageX 服务常量
const IMAGEX_SERVICE_ID = 'jm8ajry58r'
const AID = '1128'
const MAX_CONTENT_LENGTH = 8000

/** 生成 creation_id：8 位随机小写字母/数字 + 时间戳 */
function generateCreationId(): string {
  const chars = 'abcdefghijklmnopqrstuvwxyz0123456789'
  let id = ''
  for (let i = 0; i < 8; i++) {
    id += chars[Math.floor(Math.random() * chars.length)]
  }
  return id + Date.now().toString()
}

/** STS 上传凭证（auth 字段 JSON 解析结果） */
interface DouyinSTSToken {
  AccessKeyID: string
  SecretAccessKey: string
  SessionToken: string
  ExpiredTime: string
}

/** creator.douyin.com 页面代理接口通用响应 */
interface DouyinApiResponse {
  status_code?: number
  status_msg?: string
  auth?: string
  url?: { url_list?: string[] }
}

/** ImageX ApplyImageUpload 响应 */
interface ImageXApplyResponse {
  Result?: { UploadAddress?: ImageXUploadAddress }
}

/** ImageX ApplyImageUpload 返回的上传地址 */
interface ImageXUploadAddress {
  StoreInfos: Array<{ StoreUri: string; Auth: string }>
  UploadHosts: string[]
  SessionKey: string
}

/** ImageX CommitImageUpload 响应 */
interface ImageXCommitResponse {
  Result?: ImageXCommitResult
}

/** ImageX CommitImageUpload 返回结果 */
interface ImageXCommitResult {
  PluginResult?: Array<{
    ImageWidth?: number
    ImageHeight?: number
  }>
}

/** 草稿 image_info 数组元素 */
interface DouyinImageInfo {
  key: string
  value: { url: string; width: number; height: number }
}

/** uploadImageFull 完整结果 */
interface DouyinUploadResult {
  storeUri: string
  imageInfo?: DouyinImageInfo
}

export class DouyinAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'douyin',
    name: '抖音图文',
    icon: 'https://lf1-cdn-tos.bytegoofy.com/goofy/ies/douyin_web/public/favicon.ico',
    homepage: 'https://creator.douyin.com',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = { outputFormat: 'markdown' as const }

  private cachedSTS: DouyinSTSToken | null = null
  private stsExpiry = 0

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://imagex.bytedanceapi.com/*',
      headers: { Origin: 'https://creator.douyin.com', Referer: 'https://creator.douyin.com/' },
      resourceTypes: ['xmlhttprequest'],
    },
    {
      urlFilter: '*://tos-hl-x.snssdk.com/*',
      headers: { Origin: 'https://creator.douyin.com', Referer: 'https://creator.douyin.com/' },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const cookies = await this.runtime.cookies.get('.douyin.com')
      const cookie = cookies.find((item) => item.name === 'passport_assist_user')
      return cookie != null && cookie.value
        ? { isAuthenticated: true }
        : { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')
      let content = article.markdown || ''
      const imageInfos: DouyinImageInfo[] = []
      content = await this.processImages(
        content,
        async (src) => {
          const uploaded = await this.uploadImageFull(src)
          if (uploaded.imageInfo) imageInfos.push(uploaded.imageInfo)
          return { url: uploaded.storeUri }
        },
        {
          skipPatterns: ['douyin.com', 'snssdk.com', 'byteimg.com', 'bytedanceapi.com', 'jm8ajry58r'],
          onProgress: options?.onImageProgress,
        }
      )
      let truncated = false
      if (content.length > MAX_CONTENT_LENGTH) {
        content = content.slice(0, MAX_CONTENT_LENGTH)
        truncated = true
        logger.warn('Content truncated to 8000 chars for Douyin limit')
      }
      const creationId = generateCreationId()
      const initTimestamp = Math.floor(Date.now() / 1000)
      const draftPayload = {
        item: {
          common: {
            draft: {
              title: article.title,
              description: '',
              long_article: content,
              image_info: imageInfos,
              head_poster: '',
              text_extra: '[]',
              visibility_type: 0,
              timing: 0,
              creation_id: creationId,
              init_timestamp: initTimestamp,
              req_type: 0,
            },
          },
          cover: {},
        },
      }
      const resp = await this.executeInDouyinTab<DouyinApiResponse>(
        `https://creator.douyin.com/web/api/media/aweme/draft?aid=${AID}`,
        'POST',
        draftPayload
      )
      if (resp.status_code !== 0) {
        throw new Error(resp.status_msg || '保存草稿失败')
      }
      logger.info('Draft saved successfully')
      const postUrl = `https://creator.douyin.com/creator-micro/content/post/article?enter_from=draft&creation_id=${creationId}&init_timestamp=${initTimestamp}`
      return this.createResult(true, {
        postUrl,
        draftOnly: options?.draftOnly ?? true,
        message: truncated ? '内容已截断至 8000 字（抖音图文字数限制）' : undefined,
      })
    }).catch((error) => this.createResult(false, { error: (error as Error).message }))
  }

  async ensureDouyinTab(): Promise<number> {
    if (!this.runtime.tabs) throw new Error('抖音发布需要浏览器 tabs API 支持')
    const tabs = await this.runtime.tabs.query('https://creator.douyin.com/*')
    if (tabs.length > 0 && tabs[0].id) return tabs[0].id
    logger.info('No existing tab found, creating new one...')
    const tab = await this.runtime.tabs.create(
      'https://creator.douyin.com/creator-micro/content/post/article',
      false
    )
    await this.runtime.tabs.waitForLoad(tab.id, 30000)
    logger.info('New tab created and loaded:', tab.id)
    return tab.id
  }

  async executeInDouyinTab<T = Record<string, unknown>>(
    url: string,
    method: string,
    body?: unknown
  ): Promise<T> {
    if (!this.runtime.tabs) throw new Error('抖音发布需要浏览器 tabs API 支持')
    const tabId = await this.ensureDouyinTab()
    logger.debug('Using tab:', tabId, 'for', method, url.substring(0, 80))
    const result = await this.runtime.tabs.executeScript<
      { success: boolean; data?: unknown; error?: string },
      [string, string, string | null]
    >(
      tabId,
      async (requestUrl, requestMethod, bodyStr) => {
        try {
          const options: RequestInit = { method: requestMethod, credentials: 'include' }
          if (bodyStr) {
            options.headers = { 'Content-Type': 'application/json' }
            options.body = bodyStr
          }
          return { success: true, data: await (await fetch(requestUrl, options)).json() }
        } catch (error) {
          return { success: false, error: (error as Error).message }
        }
      },
      [url, method, body ? JSON.stringify(body) : null]
    )
    if (!result || !result.success) {
      throw new Error(result?.error || '请求失败')
    }
    return result.data as T
  }

  async getSTSCredentials(): Promise<DouyinSTSToken> {
    if (this.cachedSTS && Date.now() < this.stsExpiry - 60000) {
      return this.cachedSTS
    }
    const resp = await this.executeInDouyinTab<DouyinApiResponse>(
      `https://creator.douyin.com/web/api/media/upload/auth/v5/?aid=${AID}`,
      'GET'
    )
    if (resp.status_code !== 0 || !resp.auth) {
      throw new Error('获取上传凭证失败')
    }
    const token = JSON.parse(resp.auth) as DouyinSTSToken
    if (!token.AccessKeyID || !token.SecretAccessKey) {
      throw new Error('上传凭证无效')
    }
    this.cachedSTS = token
    this.stsExpiry = new Date(token.ExpiredTime).getTime()
    logger.debug('Got STS credentials, expires:', token.ExpiredTime)
    return this.cachedSTS
  }

  async uploadImageFull(src: string): Promise<DouyinUploadResult> {
    let blob: Blob
    if (src.startsWith('data:')) {
      blob = await fetch(src).then((resp) => resp.blob())
    } else {
      const resp = await this.runtime.fetch(src, { method: 'GET' })
      if (!resp.ok) {
        logger.warn('Failed to download image:', resp.status)
        return { storeUri: src }
      }
      blob = await resp.blob()
    }
    const sts = await this.getSTSCredentials()
    const uploadAddress = await this.applyImageUpload(sts)
    const storeUri = uploadAddress.StoreInfos[0]?.StoreUri
    if (!storeUri) throw new Error('No store URI in upload address')
    logger.debug('Apply upload success, storeUri:', storeUri)
    await this.uploadToTOS(uploadAddress, blob)
    const committed = (await this.commitImageUpload(sts, uploadAddress.SessionKey)).PluginResult?.[0]
    const previewUrl = await this.getImagePreviewUrl(storeUri)
    const imageInfo: DouyinImageInfo = {
      key: storeUri,
      value: {
        url: previewUrl,
        width: committed?.ImageWidth || 0,
        height: committed?.ImageHeight || 0,
      },
    }
    logger.debug('Image uploaded:', storeUri, `(${imageInfo.value.width}x${imageInfo.value.height})`)
    return { storeUri, imageInfo }
  }

  async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      return { url: (await this.uploadImageFull(src)).storeUri }
    } catch (error) {
      logger.warn('Failed to upload image:', src, error)
      return { url: src }
    }
  }

  async applyImageUpload(sts: DouyinSTSToken): Promise<ImageXUploadAddress> {
    const url = `https://imagex.bytedanceapi.com/?Action=ApplyImageUpload&Version=2018-08-01&ServiceId=${IMAGEX_SERVICE_ID}`
    const sign = await signAWS4({
      method: 'GET',
      url,
      accessKeyId: sts.AccessKeyID,
      secretAccessKey: sts.SecretAccessKey,
      securityToken: sts.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
    })
    const resp = (await (
      await this.runtime.fetch(url, { method: 'GET', headers: { ...sign.headers } })
    ).json()) as ImageXApplyResponse
    if (!resp.Result?.UploadAddress) {
      throw new Error('Failed to apply image upload')
    }
    return resp.Result.UploadAddress
  }

  async uploadToTOS(uploadAddress: ImageXUploadAddress, blob: Blob): Promise<void> {
    const storeInfo = uploadAddress.StoreInfos[0]
    const uploadHost = uploadAddress.UploadHosts[0]
    if (!storeInfo || !uploadHost) throw new Error('Invalid upload address')
    const uploadUrl = `https://${uploadHost}/${storeInfo.StoreUri}`
    const arrayBuffer = await blob.arrayBuffer()
    const uint8 = new Uint8Array(arrayBuffer)
    const crc32Value = crc32(uint8)
    logger.debug('Uploading to TOS:', uploadUrl, 'size:', blob.size, 'crc32:', crc32Value)
    const response = await this.runtime.fetch(uploadUrl, {
      method: 'PUT',
      headers: {
        Authorization: storeInfo.Auth,
        'Content-Type': blob.type || 'application/octet-stream',
        'Content-CRC32': crc32Value,
      },
      body: blob,
    })
    if (!response.ok) {
      const text = await response.text()
      throw new Error(`TOS upload failed: ${response.status} ${text}`)
    }
    logger.debug('TOS upload success')
  }

  async commitImageUpload(sts: DouyinSTSToken, sessionKey: string): Promise<ImageXCommitResult> {
    const url = `https://imagex.bytedanceapi.com/?Action=CommitImageUpload&Version=2018-08-01&ServiceId=${IMAGEX_SERVICE_ID}`
    const body = JSON.stringify({ SessionKey: sessionKey })
    const sign = await signAWS4({
      method: 'POST',
      url,
      accessKeyId: sts.AccessKeyID,
      secretAccessKey: sts.SecretAccessKey,
      securityToken: sts.SessionToken,
      region: 'cn-north-1',
      service: 'imagex',
      body,
    })
    const resp = (await (
      await this.runtime.fetch(url, {
        method: 'POST',
        headers: { ...sign.headers, 'Content-Type': 'application/json' },
        body,
      })
    ).json()) as ImageXCommitResponse
    if (!resp.Result) {
      throw new Error('Failed to commit image upload')
    }
    return resp.Result
  }

  async getImagePreviewUrl(storeUri: string): Promise<string> {
    const resp = await this.executeInDouyinTab<DouyinApiResponse>(
      `https://creator.douyin.com/aweme/v1/creator/get/url/?uri=${encodeURIComponent(storeUri)}&aid=${AID}`,
      'GET'
    )
    const url = resp.url?.url_list?.[0]
    if (!url) throw new Error('获取图片预览 URL 失败')
    return url
  }
}
