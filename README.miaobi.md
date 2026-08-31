# 妙笔·全渠道发布（Wechatsync Fork）

基于开源项目 [Wechatsync](https://github.com/wechatsync/Wechatsync)（GPLv3）的定制发行版。

## 本 Fork 的改动
- 品牌：妙笔·全渠道发布（图标/名称/描述）
- 默认桥接服务器：`wss://mp.aibolt.tech/ws-bridge`
- 新增「妙笔一键配置」：登录妙笔账号自动完成 Token 与服务器配置

## 上游贡献
平台适配器、同步核心全部来自上游 Wechatsync，感谢原作者与社区。
本 Fork 遵循 GPLv3 开源，改动以叠加为主，便于持续合并上游更新。

## 构建
```bash
pnpm install --filter @wechatsync/extension...
pnpm --filter @wechatsync/extension run build
# 产物在 packages/extension/dist/
```
