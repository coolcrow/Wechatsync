/**
 * 小红书适配器（移植自官方构建，GPL-3.0）
 *
 * 发布路线：不调发布 API，而是把草稿直接写入小红书创作中心页面的
 * IndexedDB 草稿库（draft-database-v1 / article-draft store）——用户在
 * 创作中心「草稿箱 → 长文笔记」里看到草稿后自行确认发布。
 * 正文以 prosemirror 文档存储（长文笔记编辑器格式），图片先经
 * ros-upload 临时凭证上传拿到 fileId/预览 URL 再嵌入节点。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'
import {
  markdownToProsemirror,
  XIAOHONGSHU_CAPABILITIES,
  type UploadedImage,
} from '../../../lib/markdown-prosemirror'

const logger = createLogger('Xiaohongshu')

const PUBLISH_URL = 'https://creator.xiaohongshu.com/publish/publish?from=menu&target=article'
const GALAXY_ORIGIN = 'https://creator.xiaohongshu.com'
const MAX_ARTICLE_LENGTH = 10000

interface GalaxyUserInfo {
  success: boolean
  data?: { userId: string; userName: string; userAvatar: string }
}

export class XiaohongshuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'xiaohongshu',
    name: '小红书',
    icon: 'https://www.xiaohongshu.com/favicon.ico',
    homepage: PUBLISH_URL,
    capabilities: ['article', 'draft', 'image_upload'],
  }

  private userId: string | null = null

  async setupHeaderRules(): Promise<void> {
    await this.addHeaderRules([
      {
        urlFilter: '*://creator.xiaohongshu.com/*',
        headers: { Origin: 'https://creator.xiaohongshu.com', Referer: PUBLISH_URL },
        resourceTypes: ['xmlhttprequest'],
      },
      {
        urlFilter: '*://ros-upload.xiaohongshu.com/*',
        headers: { Origin: 'https://creator.xiaohongshu.com', Referer: 'https://creator.xiaohongshu.com/' },
        resourceTypes: ['xmlhttprequest'],
      },
    ])
  }

  async ensureXHSTab(): Promise<number> {
    if (!this.runtime.tabs) throw new Error('小红书发布需要浏览器 tabs API 支持')
    const tabs = await this.runtime.tabs.query('https://creator.xiaohongshu.com/*')
    if (tabs.length > 0 && tabs[0].id) return tabs[0].id
    logger.info('No existing XHS creator tab found, creating new one...')
    const tab = await this.runtime.tabs.create(PUBLISH_URL, false)
    await this.runtime.tabs.waitForLoad(tab.id, 30000)
    logger.info('New XHS creator tab created and loaded:', tab.id)
    return tab.id
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      await this.setupHeaderRules()
      const resp = await this.runtime.fetch(`${GALAXY_ORIGIN}/api/galaxy/user/info`, {
        credentials: 'include',
        headers: { Accept: 'application/json, text/plain, */*' },
      })
      const info = (await resp.json()) as GalaxyUserInfo
      await this.clearHeaderRules()
      if (info.success && info.data) {
        this.userId = info.data.userId
        logger.info('XHS auth success:', info.data.userName)
        return {
          isAuthenticated: true,
          userId: this.userId,
          username: info.data.userName,
          avatar: info.data.userAvatar,
        }
      }
      return { isAuthenticated: false, error: '未登录小红书创作者平台' }
    } catch (error) {
      await this.clearHeaderRules()
      logger.error('checkAuth error:', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    await this.setupHeaderRules()
    try {
      logger.info('Starting publish to Xiaohongshu...')

      const markdown = article.markdown || ''
      const plainLength = this.getPlainTextLength(markdown)
      if (plainLength > MAX_ARTICLE_LENGTH) {
        throw new Error(`文章字数超出小红书限制：当前 ${plainLength} 字，最多 ${MAX_ARTICLE_LENGTH} 字`)
      }
      if (!this.runtime.tabs) throw new Error('小红书发布需要浏览器 tabs API 支持')

      const tabId = await this.ensureXHSTab()

      const doc = await markdownToProsemirror(markdown, XIAOHONGSHU_CAPABILITIES, {
        uploadImage: async (src) => {
          const uploaded = await this.uploadImageByUrl(src)
          return {
            url: uploaded.url,
            width: (uploaded.attrs?.width as number | undefined) ?? 0,
            height: (uploaded.attrs?.height as number | undefined) ?? 0,
            fileId: (uploaded.attrs?.fileId as string | undefined) ?? '',
          } satisfies UploadedImage
        },
        onImageProgress: options?.onImageProgress,
      })

      const draftId = this.generateUUID()

      if (!this.userId && !(await this.checkAuth()).isAuthenticated) {
        throw new Error('请先登录小红书创作者平台')
      }
      logger.info('userId before save:', this.userId)

      const saveResult = await this.runtime.tabs.executeScript<
        { success: boolean; error?: string },
        [string, string, Record<string, unknown>, string]
      >(
        tabId,
        async (draftUuid, articleTitle, richJson, uid) => {
          const slow = new Promise<{ success: boolean; error: string }>((resolve) => {
            setTimeout(() => resolve({ success: false, error: 'IndexedDB timeout (10s)' }), 10000)
          })
          const work = new Promise<{ success: boolean; error: string }>((resolve) => {
            try {
              const req = indexedDB.open('draft-database-v1')
              req.onerror = (event) => {
                resolve({ success: false, error: 'IndexedDB open error: ' + (event.target as IDBRequest).error?.message })
              }
              req.onsuccess = () => {
                try {
                  const db = req.result
                  const pageUrl = window.location.href
                  const storeNames = Array.from(db.objectStoreNames)
                  if (!db.objectStoreNames.contains('article-draft')) {
                    db.close()
                    resolve({
                      success: false,
                      error: `article-draft store not found. URL: ${pageUrl}, stores: ${storeNames.join(', ')}`,
                    })
                    return
                  }
                  const tx = db.transaction(['article-draft'], 'readwrite')
                  const store = tx.objectStore('article-draft')
                  const record = {
                    content: {
                      contextStore: {
                        liveContext: { time: 0, title: '' },
                        previewAuditContext: {
                          status: 0,
                          detail: {
                            hasLimit: true,
                            remainingCalls: 0,
                            taskId: '',
                            taskType: '1',
                            status: 0,
                            taskResultInfo: { detectionStatus: 1, optimizationPoints: [] },
                          },
                          isChange: false,
                        },
                        coverContext: {
                          coverUrl: '',
                          cover: {
                            width: 0,
                            height: 0,
                            fileid: '',
                            frame: { ts: 0, isUserSelect: false, isUpload: false },
                            stickers: { version: 2, neptune: [] },
                            fonts: [],
                            coverTemplateId: '',
                            extra_info_json: '',
                          },
                          templateBlob: null,
                          rate: 0,
                          recommendCoverIdx: -1,
                        },
                        goodsContext: { goodsInfo: {}, goodsPreviewDetail: [] },
                        bizRelationContext: { bizRelation: [] },
                        recommendCovers: [],
                      },
                      draftStore: {
                        descInnerHTML: '',
                        descLength: 0,
                        video: {
                          width: 0,
                          height: 0,
                          fileid: '',
                          fsize: 0,
                          duration: 0,
                          videoId: '',
                          videoMarks: [],
                          timelines: [],
                          frame: { ts: 0, userSelect: false },
                          transcodeVideoFileId: '',
                          coverInfo: {},
                        },
                        videoInfo: null,
                        audioInfo: null,
                        videoMeta: '',
                        audioMeta: '',
                        cover: {
                          width: 0,
                          height: 0,
                          fileid: '',
                          frame: { ts: 0, userSelect: false, isUpload: false },
                          stickers: { neptune: [], version: 2 },
                          fonts: [],
                        },
                        chapters: [],
                        markers: [],
                        needTranscode: false,
                        imgList: [],
                        colorGroup: null,
                        title: articleTitle,
                        desc: '',
                        ats: [],
                        hashTag: [],
                      },
                      settingStore: {
                        privacyInfo: { opType: 1, type: 0, userIds: [] },
                        collectionId: '',
                        orderId: '',
                        brandAccountId: '',
                        noteSketch: { id: '', name: '' },
                        original: false,
                        originalDateStamp: '',
                        coProduceBind: { enable: true },
                        noteCopyBind: { copyable: true },
                        coOrderId: '',
                        interactionPermissionBind: { commentPermission: 0 },
                        fileRelate: { fileId: '', docId: '', docName: '', docShowName: '', docType: '', docSize: 0 },
                      },
                      articleStore: {
                        articleContent: '',
                        summeryContent: '',
                        orderPattern: '',
                        richJson,
                        articleTitle,
                        articleEditorMode: 0,
                        authorAndSummaryTemp: { author: '', summary: '', readingStats: '' },
                        selectedThemeId: 6,
                        selectedColorIndexMap: {},
                        blob2Map: {},
                        coverSetting: { styleType: 0, showAuthor: true, showReadingStats: true, showSummery: true },
                        editPageSource: 'import',
                        schemaCopy: {},
                        url2FileIdMap: {},
                      },
                      shortDraftStore: {
                        isShort: true,
                        editStatus: 0,
                        textCardList: [
                          {
                            createTime: Date.now(),
                            text: '',
                            originText: '',
                            length: 0,
                            image: '',
                            imageFileId: '',
                            isManualInsert: false,
                          },
                        ],
                        coverList: [],
                        currentCoverIdx: 0,
                        cacheData: {},
                      },
                      publishStore: { publishType: 1, imageNoteOrigin: 0, systemId: 'web', step: 0, uploadState: 2, status: 0, codec: 'unknown' },
                    },
                    draftId: draftUuid,
                    uid,
                    timeStamp: Date.now(),
                  }
                  const put = store.put(record)
                  put.onsuccess = () => {
                    db.close()
                    resolve({ success: true, error: `saved with uid: ${uid}` })
                  }
                  put.onerror = () => {
                    db.close()
                    resolve({ success: false, error: 'put error: ' + put.error?.message })
                  }
                  tx.onerror = () => {
                    db.close()
                    resolve({ success: false, error: 'transaction error: ' + tx.error?.message })
                  }
                } catch (err) {
                  resolve({ success: false, error: 'db error: ' + (err as Error).message })
                }
              }
            } catch (err) {
              resolve({ success: false, error: 'open error: ' + (err as Error).message })
            }
          })
          return Promise.race([work, slow])
        },
        [draftId, article.title || '', doc as unknown as Record<string, unknown>, this.userId || '']
      )

      if (!saveResult?.success) {
        throw new Error(saveResult?.error || '保存草稿失败')
      }

      logger.info('Draft saved to IndexedDB:', draftId, 'debug:', saveResult?.error)
      await this.clearHeaderRules()
      return this.createResult(true, {
        postId: draftId,
        postUrl: PUBLISH_URL,
        draftOnly: true,
        message: '请到「草稿箱 → 长文笔记」查看',
      })
    } catch (error) {
      await this.clearHeaderRules()
      logger.error('Publish failed:', error)
      return this.createResult(false, { error: (error as Error).message })
    }
  }

  async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    if (!this.runtime.tabs) throw new Error('小红书图片上传需要浏览器 tabs API 支持')
    const tabId = await this.ensureXHSTab()

    let base64: string
    let mimeType: string
    let width = 0
    let height = 0

    if (src.startsWith('data:')) {
      const match = src.match(/^data:([^;]+);base64,(.+)$/)
      if (!match) throw new Error('Invalid data URI')
      mimeType = match[1]
      base64 = match[2]
      try {
        const binary = atob(base64)
        const bytes = new Uint8Array(binary.length)
        for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
        const bitmap = await createImageBitmap(new Blob([bytes], { type: mimeType }))
        width = bitmap.width
        height = bitmap.height
        bitmap.close()
      } catch (err) {
        logger.warn('Failed to get image dimensions from data URI:', err)
      }
    } else {
      const blob = await (await fetch(src)).blob()
      mimeType = blob.type || 'image/jpeg'
      try {
        const bitmap = await createImageBitmap(blob)
        width = bitmap.width
        height = bitmap.height
        bitmap.close()
      } catch (err) {
        logger.warn('Failed to get image dimensions:', err)
      }
      const buffer = new Uint8Array(await blob.arrayBuffer())
      let binary = ''
      for (let i = 0; i < buffer.length; i++) binary += String.fromCharCode(buffer[i])
      base64 = btoa(binary)
    }

    const uploadResult = await this.runtime.tabs.executeScript<
      { success: boolean; fileId?: string; previewUrl?: string | null; error?: string },
      [string, string]
    >(
      tabId,
      async (imageBase64, contentType) => {
        try {
          const permitPath =
            '/api/media/v1/upload/creator/permit?biz_name=spectrum&scene=image&file_count=1&version=1&source=web'
          const page = window as Window & {
            _webmsxyw?: (path: string) => Record<string, string> | undefined
          }
          const headers: Record<string, string> = { Accept: 'application/json, text/plain, */*' }
          if (typeof page._webmsxyw === 'function') {
            const signature = page._webmsxyw(permitPath)
            if (signature) {
              headers['X-s'] = signature['X-s']
              headers['X-t'] = signature['X-t']
              headers['X-s-common'] = signature['X-s-common']
            }
          }
          const permitResp = await (
            await fetch('https://creator.xiaohongshu.com' + permitPath, {
              method: 'GET',
              credentials: 'include',
              headers,
            })
          ).json()
          if (
            !permitResp.success ||
            !permitResp.data?.uploadTempPermits?.[0]
          ) {
            return { success: false, error: '获取上传凭证失败: ' + JSON.stringify(permitResp) }
          }
          const permit =
            permitResp.data.uploadTempPermits.find(
              (p: { uploadAddr: string }) => p.uploadAddr === 'ros-upload.xiaohongshu.com'
            ) || permitResp.data.uploadTempPermits[0]
          const fileId = permit.fileIds?.[0]
          if (!fileId) return { success: false, error: '获取 fileId 失败' }

          const binary = atob(imageBase64)
          const bytes = new Uint8Array(binary.length)
          for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i)
          const uploadResp = await fetch(`https://${permit.uploadAddr}/${fileId}`, {
            method: 'PUT',
            headers: {
              Authorization: permit.token,
              'Content-Type': contentType,
              'x-cos-security-token': permit.token,
            },
            body: new Blob([bytes], { type: contentType }),
          })
          if (!uploadResp.ok) {
            return { success: false, error: `上传失败: ${uploadResp.status} ${uploadResp.statusText}` }
          }
          const previewUrl = uploadResp.headers.get('x-ros-preview-url')
          return { success: true, fileId, previewUrl }
        } catch (err) {
          return { success: false, error: (err as Error).message }
        }
      },
      [base64, mimeType]
    )

    if (!uploadResult?.success || !uploadResult.fileId) {
      throw new Error(uploadResult?.error || '图片上传失败')
    }
    logger.debug('Image uploaded:', uploadResult.fileId)
    return {
      url: uploadResult.previewUrl || `https://ros-preview.xhscdn.com/${uploadResult.fileId}`,
      attrs: { fileId: uploadResult.fileId, width, height },
    }
  }

  generateUUID(): string {
    return 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (char) => {
      const random = (Math.random() * 16) | 0
      return (char === 'x' ? random : (random & 0x3) | 0x8).toString(16)
    })
  }

  getPlainTextLength(content: string): number {
    let text = content
    if (/<[^>]+>/.test(text)) {
      text = text
        .replace(/<script[\s\S]*?<\/script>/gi, '')
        .replace(/<style[\s\S]*?<\/style>/gi, '')
        .replace(/<[^>]+>/g, '')
        .replace(/&nbsp;/g, ' ')
        .replace(/&lt;/g, '<')
        .replace(/&gt;/g, '>')
        .replace(/&amp;/g, '&')
        .replace(/&quot;/g, '"')
    }
    // markdown 图片与链接语法不计入字数
    return text.replace(/!\[[^\]]*\]\([^)]*\)/g, '').replace(/\[([^\]]+)\]\([^)]*\)/g, '$1').length
  }
}
