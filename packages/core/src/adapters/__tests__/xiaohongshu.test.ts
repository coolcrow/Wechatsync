/**
 * 小红书适配器注册契约测试——getPrivateAdapters() 按此契约发现适配器：
 * 无参 new 不抛错、实例带 meta、checkAuth/publish 可调用。
 */
import { describe, it, expect } from 'vitest'
import { XiaohongshuAdapter } from '../platforms/private/xiaohongshu'

describe('XiaohongshuAdapter', () => {
  it('instantiates without runtime and exposes registration meta', () => {
    const adapter = new XiaohongshuAdapter()
    expect(adapter.meta.id).toBe('xiaohongshu')
    expect(adapter.meta.name).toBe('小红书')
    expect(adapter.meta.capabilities).toContain('draft')
    expect(typeof adapter.checkAuth).toBe('function')
    expect(typeof adapter.publish).toBe('function')
  })

  it('generates UUID v4-shaped draft ids', () => {
    const adapter = new XiaohongshuAdapter()
    const uuid = adapter.generateUUID()
    expect(uuid).toMatch(/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/)
    expect(adapter.generateUUID()).not.toBe(uuid)
  })

  it('counts plain text length ignoring html/markup syntax', () => {
    const adapter = new XiaohongshuAdapter()
    expect(adapter.getPlainTextLength('一二三')).toBe(3)
    expect(adapter.getPlainTextLength('<p>一<b>二</b>三</p>')).toBe(3)
    expect(adapter.getPlainTextLength('前![配图](https://x.com/a.png)后')).toBe(2)
    expect(adapter.getPlainTextLength('[链接](https://x.com)文字')).toBe(4)
  })
})
