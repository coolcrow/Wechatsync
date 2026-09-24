import { useEffect, useState } from 'react'
import { checkPluginUpdate, openDownloadPage, type PluginUpdateInfo } from '../lib/update-check'

/** 顶部更新横幅：有新版时显示，一键直达下载页（更新需手动重载——解压加载的物理上限）。 */
export function UpdateBanner() {
  const [info, setInfo] = useState<PluginUpdateInfo | null>(null)

  useEffect(() => {
    checkPluginUpdate().then(setInfo).catch(() => {})
    const listener = (changes: Record<string, chrome.storage.StorageChange>) => {
      if (changes.pluginUpdateInfo?.newValue) setInfo(changes.pluginUpdateInfo.newValue)
    }
    chrome.storage.onChanged.addListener(listener)
    return () => chrome.storage.onChanged.removeListener(listener)
  }, [])

  if (!info?.hasUpdate) return null
  return (
    <button
      onClick={openDownloadPage}
      className="w-full flex items-center justify-between gap-2 px-3 py-2 bg-amber-50 border-b border-amber-200 text-amber-800 text-xs hover:bg-amber-100 transition-colors"
      title="Chrome 不会自动更新解压目录加载的扩展——到下载页获取新版并重新加载"
    >
      <span>🆕 新版本 v{info.latest} 可用</span>
      <span className="font-medium underline underline-offset-2">立即更新 →</span>
    </button>
  )
}
