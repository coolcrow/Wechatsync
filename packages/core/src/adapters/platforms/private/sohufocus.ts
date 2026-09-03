/**
 * 搜狐焦点适配器（移植自官方构建，GPL-3.0）
 *
 * 发布路线：HTML 压缩（去除标签间空白）后图片转传站内图床
 * （t-img.51f.com），再以 JSON 提交 publishNewsInfo（status=4 草稿态），
 * 用户在搜狐焦点创作者后台草稿箱确认发布。
 */

import { CodeAdapter, type ImageUploadResult } from '../../code-adapter'
import type { Article, AuthResult, SyncResult, PlatformMeta } from '../../../types'
import type { PublishOptions } from '../../types'

interface SohuFocusUserStatusResponse {
  data?: {
    uid: string
    accountName?: string
  }
}

interface SohuFocusUploadResponse {
  code: number
  data: string
}

interface SohuFocusPublishResponse {
  data?: {
    id: string
  }
}

export class SohuFocusAdapter extends CodeAdapter {
  readonly meta: PlatformMeta = {
    id: 'sohufocus',
    name: '搜狐焦点',
    icon: 'https://mp.focus.cn/favicon.ico',
    homepage: 'https://mp.focus.cn/fe/index.html#/info/draft',
    capabilities: ['article', 'draft', 'image_upload'],
  }

  readonly preprocessConfig = {
    outputFormat: 'html' as const,
  }

  async checkAuth(): Promise<AuthResult> {
    try {
      const response = await (
        await this.runtime.fetch('https://mp-fe-pc.focus.cn/user/status', {
          credentials: 'include',
        })
      ).json() as SohuFocusUserStatusResponse
      if (response.data?.uid) {
        return {
          isAuthenticated: true,
          userId: response.data.uid,
          username: response.data.accountName,
        }
      }
      return { isAuthenticated: false, error: '未登录' }
    } catch (error) {
      return { isAuthenticated: false, error: (error as Error).message }
    }
  }

  async uploadImageByUrl(src: string): Promise<ImageUploadResult> {
    const blob = await (await this.runtime.fetch(src)).blob()
    const formData = new FormData()
    formData.append('image', blob, `${Date.now()}.jpg`)
    const result = await (
      await this.runtime.fetch('https://mp-fe-pc.focus.cn/common/image/upload?type=2', {
        method: 'POST',
        credentials: 'include',
        body: formData,
      })
    ).json() as SohuFocusUploadResponse
    if (result.code !== 200) {
      throw new Error('图片上传失败')
    }
    return { url: `https://t-img.51f.com/sh740wsh${result.data}` }
  }

  async publish(article: Article, _options?: PublishOptions): Promise<SyncResult> {
    const timestamp = Date.now()
    try {
      let content = article.html || article.markdown || ''
      content = await this.processImages(content, (src) => this.uploadImageByUrl(src))
      content = content.replace(/>\s+</g, '><')
      const result = await (
        await this.runtime.fetch('https://mp-fe-pc.focus.cn/news/info/publishNewsInfo', {
          method: 'POST',
          credentials: 'include',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({
            projectIds: [],
            newsBasic: {
              id: '',
              cityId: 0,
              title: article.title,
              category: 1,
              headImg: '',
              newsAbstract: '',
              isGuide: 0,
              status: 4,
            },
            newsContent: { content },
            videoIds: [],
          }),
        })
      ).json() as SohuFocusPublishResponse
      if (!result.data?.id) {
        throw new Error('发布失败')
      }
      return {
        platform: this.meta.id,
        success: true,
        postId: result.data.id,
        postUrl: `https://mp.focus.cn/fe/index.html#/info/subinfo/${result.data.id}`,
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
