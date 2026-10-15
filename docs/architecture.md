# 双端架构

## 共享核心

`background.js` 定义扫描、限速、复核与持久化流程。`lib/` 负责成本口径、行情新鲜度、查询匹配与安全的数据解析。

- 浏览器直接以 MV3 service worker 运行共享管线；`lib/extension-transport.js` 提供扩展范围内的 DNR 页面偏好。
- 桌面 `desktop/engine.js` 在隔离上下文中承载同一管线，注入磁盘存储、请求和计时适配；`desktop/security.js` 提供独立 Electron 会话中的受限请求。
- `ui/` 为共享样式与品牌资源。根目录保留可直接加载的 MV3 入口；无需复制一份扫描核心到另一端。

## 发布

`npm run build:extension` 只打包显式列出的入口与 `lib/ui/icons`，使用 Node 内置压缩与固定 ZIP 元数据，跨平台生成可加载目录和 ZIP。

`npm run dist` 使用 Electron Builder 生成 Windows x64 便携包。两端统一使用 2.2.0 起的版本号。旧正式数据目录保持不变，避免更名造成用户配置丢失。

## 验收

纯逻辑与桌面后端测试覆盖金额、缺失值、跨版本市场页面、外币拒绝、磁盘恢复和安全边界；Electron E2E 验证真实窗口；MV3 验证真实 service worker、popup/dashboard、DNR、旧报价重试与空表错误提示。

真实网络测试单独启用，不把平台可用性耦合进默认 CI。发布前额外检查单文件便携包与插件白名单内容，确认账号目录及诊断文件未混入产物。
