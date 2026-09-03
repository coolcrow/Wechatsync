/**
 * private 适配器注册契约测试——getPrivateAdapters() 按此契约发现适配器：
 * 无参 new 不抛错、实例带 meta、checkAuth/publish 可调用。
 */
import { describe, it, expect } from 'vitest'
import { DaYuAdapter } from '../platforms/private/dayu'
import { DouyinAdapter } from '../platforms/private/douyin'
import { JianshuAdapter } from '../platforms/private/jianshu'
import { NeteaseAdapter } from '../platforms/private/netease'
import { SmzdmAdapter } from '../platforms/private/smzdm'
import { SohuFocusAdapter } from '../platforms/private/sohufocus'
import { XAdapter } from '../platforms/private/x'
import { YidianAdapter } from '../platforms/private/yidian'

const CASES: Array<{ name: string; Adapter: new () => InstanceType<typeof DaYuAdapter> }> = [
  { name: 'dayu', Adapter: DaYuAdapter },
  { name: 'douyin', Adapter: DouyinAdapter },
  { name: 'jianshu', Adapter: JianshuAdapter },
  { name: 'netease', Adapter: NeteaseAdapter },
  { name: 'smzdm', Adapter: SmzdmAdapter },
  { name: 'sohufocus', Adapter: SohuFocusAdapter },
  { name: 'x', Adapter: XAdapter },
  { name: 'yidian', Adapter: YidianAdapter },
]

describe('private adapters registration contract', () => {
  for (const { name, Adapter } of CASES) {
    it(`${name}: instantiates without runtime and exposes registration meta`, () => {
      const adapter = new Adapter()
      expect(adapter.meta.id).toBe(name)
      expect(adapter.meta.name.length).toBeGreaterThan(0)
      expect(adapter.meta.capabilities).toContain('draft')
      expect(typeof adapter.checkAuth).toBe('function')
      expect(typeof adapter.publish).toBe('function')
    })
  }
})
