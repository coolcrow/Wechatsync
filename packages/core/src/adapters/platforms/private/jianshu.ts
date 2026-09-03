/**
 * 简书适配器（移植自官方构建，GPL-3.0）
 *
 * 认证：GET settings/basic.json 读取昵称，同时记录
 * preferred_note_type 决定正文用 markdown 还是 html。
 * 发布：POST author/notes 在默认文集创建草稿 →
 * PUT author/notes/{id} 写入正文（始终 draftOnly）；
 * 图片经 upload_images/token.json 取七牛凭证后上传至 upload.qiniup.com。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'
import type { PublishOptions } from '../../types'
import { createLogger } from '../../../lib/logger'

const logger = createLogger('Jianshu')

/** settings/basic.json 响应 */
interface JianshuSettingsResponse {
  data?: {
    nickname?: string
    avatar?: string
    preferred_note_type?: string
  }
}

/** 文集 */
interface JianshuNotebook {
  id: string
}

/** author/notes 创建/更新响应 */
interface JianshuNoteResponse {
  id?: string | number
}

/** upload_images/token.json 响应 */
interface JianshuUploadTokenResponse {
  token: string
  key: string
}

/** 七牛上传响应 */
interface JianshuUploadResponse {
  url?: string
}

export class JianshuAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'jianshu',
    name: '简书',
    icon: 'https://www.jianshu.com/favicon.ico',
    homepage: 'https://www.jianshu.com',
    capabilities: ['article', 'draft', 'image_upload', 'categories'],
  }

  readonly preprocessConfig = { outputFormat: 'html' as const }

  private defaultNotebookId: string | null = null
  private preferredNoteType: 'plain' | 'markdown' = 'plain'

  private readonly HEADER_RULES = [
    {
      urlFilter: '*://www.jianshu.com/*',
      headers: { Origin: 'https://www.jianshu.com', Referer: 'https://www.jianshu.com/writer' },
      resourceTypes: ['xmlhttprequest'],
    },
  ]

  async checkAuth(): Promise<AuthResult> {
    try {
      const resp = (await (
        await this.runtime.fetch('https://www.jianshu.com/settings/basic.json', {
          method: 'GET',
          credentials: 'include',
        })
      ).json()) as JianshuSettingsResponse
      if (resp.data?.nickname) {
        this.preferredNoteType = resp.data.preferred_note_type === 'markdown' ? 'markdown' : 'plain'
        logger.debug('preferred_note_type:', this.preferredNoteType)
        return {
          isAuthenticated: true,
          username: resp.data.nickname,
          avatar: resp.data.avatar,
        }
      }
      return { isAuthenticated: false }
    } catch (error) {
      logger.debug('checkAuth: not logged in -', error)
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async getNotebooks(): Promise<JianshuNotebook[]> {
    return (await (
      await this.runtime.fetch('https://www.jianshu.com/author/notebooks', {
        method: 'GET',
        credentials: 'include',
        headers: { Accept: 'application/json' },
      })
    ).json()) as JianshuNotebook[]
  }

  async getDefaultNotebookId(): Promise<string> {
    if (this.defaultNotebookId) return this.defaultNotebookId
    const notebooks = await this.getNotebooks()
    if (notebooks.length === 0) throw new Error('没有可用的文集')
    this.defaultNotebookId = notebooks[0].id
    return this.defaultNotebookId
  }

  async publish(article: Article, options?: PublishOptions): Promise<SyncResult> {
    return this.withHeaderRules(this.HEADER_RULES, async () => {
      logger.info('Starting publish...')
      await this.checkAuth()
      const notebookId = await this.getDefaultNotebookId()
      const draftResp = (await (
        await this.runtime.fetch('https://www.jianshu.com/author/notes', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
          body: JSON.stringify({ at_bottom: false, notebook_id: notebookId, title: article.title }),
        })
      ).json()) as JianshuNoteResponse
      if (!draftResp.id) throw new Error('创建草稿失败')
      const noteId = draftResp.id
      logger.debug('Draft created:', noteId)
      let content: string
      if (this.preferredNoteType === 'markdown') {
        content = article.markdown || ''
      } else {
        content = article.html || ''
      }
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src), {
        skipPatterns: ['jianshu.com', 'jianshuapi.com', 'upload-images.jianshu.io'],
        onProgress: options?.onImageProgress,
      })
      const updateResp = (await (
        await this.runtime.fetch(`https://www.jianshu.com/author/notes/${noteId}`, {
          method: 'PUT',
          credentials: 'include',
          headers: {
            'Content-Type': 'application/json; charset=UTF-8',
            Accept: 'application/json',
          },
          body: JSON.stringify({
            id: String(noteId),
            autosave_control: 1,
            title: article.title,
            content,
          }),
        })
      ).json()) as JianshuNoteResponse
      if (!updateResp.id) throw new Error('更新草稿失败')
      logger.debug('Draft updated')
      const postUrl = `https://www.jianshu.com/writer#/notebooks/${notebookId}/notes/${noteId}`
      return this.createResult(true, {
        postId: String(noteId),
        postUrl,
        draftOnly: options?.draftOnly ?? true,
      })
    }).catch((error) => this.createResult(false, { error: (error as Error).message }))
  }

  async getUploadToken(filename: string): Promise<JianshuUploadTokenResponse> {
    return (await (
      await this.runtime.fetch(
        `https://www.jianshu.com/upload_images/token.json?filename=${encodeURIComponent(filename)}`,
        { method: 'GET', credentials: 'include', headers: { Accept: 'application/json' } }
      )
    ).json()) as JianshuUploadTokenResponse
  }

  async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    try {
      const response = await fetch(src)
      if (!response.ok) throw new Error('图片下载失败')
      const blob = await response.blob()
      const ext = blob.type.split('/')[1]?.replace('jpeg', 'jpg') || 'jpg'
      let filename = `image_${Date.now()}.${ext}`
      try {
        if (!src.startsWith('data:')) {
          const basename = new URL(src).pathname.split('/').pop() || ''
          if (/\.(jpe?g|png|gif|webp|bmp|svg)$/i.test(basename)) {
            filename = basename
          }
        }
      } catch {}
      const { token, key } = await this.getUploadToken(filename)
      const formData = new FormData()
      formData.append('token', token)
      formData.append('key', key)
      formData.append('file', blob, filename)
      formData.append('x:protocol', 'https')
      const resp = (await (
        await fetch('https://upload.qiniup.com/', { method: 'POST', body: formData })
      ).json()) as JianshuUploadResponse
      logger.debug('Image upload response:', resp)
      if (resp.url) {
        return { url: resp.url }
      }
      throw new Error('图片上传失败')
    } catch (error) {
      logger.warn('Failed to upload image:', src, error)
      return { url: src }
    }
  }
}
