/**
 * 插件软更新检查：拉取妙笔站点的 extension-info.json 与本地版本比对。
 * Chrome 对解压目录加载的扩展不会自动更新——把「发现更新」的摩擦降到零，
 * 更新动作仍需用户到下载页下载重载。
 */

import { createLogger } from './logger'

const logger = createLogger('UpdateCheck')

const INFO_URL = 'https://mp.aibolt.tech/static/extension-info.json'
const DOWNLOAD_URL = 'https://mp.aibolt.tech/static/download.html'
const STORAGE_KEY = 'pluginUpdateInfo'
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000

export interface PluginUpdateInfo {
  latest: string
  hasUpdate: boolean
  checkedAt: number
}

function versionLt(a: string, b: string): boolean {
  const pa = a.split('.').map(Number)
  const pb = b.split('.').map(Number)
  for (let i = 0; i < 3; i++) {
    if ((pa[i] || 0) !== (pb[i] || 0)) return (pa[i] || 0) < (pb[i] || 0)
  }
  return false
}

export async function checkPluginUpdate(force = false): Promise<PluginUpdateInfo | null> {
  try {
    const stored = (await chrome.storage.local.get(STORAGE_KEY))[STORAGE_KEY] as PluginUpdateInfo | undefined
    if (!force && stored && Date.now() - stored.checkedAt < CHECK_INTERVAL_MS) {
      return stored
    }
    const resp = await fetch(INFO_URL, { cache: 'no-cache', signal: AbortSignal.timeout(10_000) })
    if (!resp.ok) return stored || null
    const info = await resp.json()
    const latest = String(info.version || '')
    const current = chrome.runtime.getManifest().version
    const hasUpdate = !!latest && versionLt(current, latest)
    const result: PluginUpdateInfo = { latest, hasUpdate, checkedAt: Date.now() }
    await chrome.storage.local.set({ [STORAGE_KEY]: result })
    // 徽标提示（同步任务的 ✓ 徽标由 sync-service 管理，更新徽标仅在无同步徽标时设置）
    try {
      const badge = await chrome.action.getBadgeText({})
      if (hasUpdate && !badge) {
        await chrome.action.setBadgeBackgroundColor({ color: '#f59e0b' })
        await chrome.action.setBadgeText({ text: '●' })
      } else if (!hasUpdate && badge === '●') {
        await chrome.action.setBadgeText({ text: '' })
      }
    } catch { /* MV3 部分上下文无 action 权限场景忽略 */ }
    logger.info(`Update check: current=${current} latest=${latest} hasUpdate=${hasUpdate}`)
    return result
  } catch (e) {
    logger.warn('Update check failed:', e)
    return null
  }
}

export function openDownloadPage(): void {
  chrome.tabs.create({ url: DOWNLOAD_URL, active: true })
}
