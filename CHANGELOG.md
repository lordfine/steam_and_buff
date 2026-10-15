# Changelog

## v2.2.0 (2026-10-16)

- 项目更名为 SkinLedger · 饰账，以 MIT 协议公开，统一桌面版与 MV3 插件版本号。
- 两端共享墨绿 / 浅色设计令牌、原创标志与工作台布局；补充 README、预览、CI 和安全说明。
- 插件新增限定扩展发起方的 Steam 经典页请求偏好，兼容新版页面，拒绝外币与相似饰品误匹配。
- 插件新增空表错误诊断、待处理入口、过期和部分报价重试；修复扫描完成按钮状态、最高价 0、未知数据展示及表头遮挡。
- 插件构建改为跨平台、白名单、确定性 ZIP，确保共享解析器和样式资源完整打包。
- 保留旧桌面数据目录、收藏与历史，不自动迁移或同步浏览器账号。

## v2.1.1 (2026-10-16)

- 桌面兼容 Steam 新版 SSR 与经典市场页面，精确识别币种与饰品。
- 使用精确订单总数恢复搜索截断导致的流动性缺失。
- 原有 7 件求购盘失败饰品实测恢复，缺少成交量仍保持未完整复核。

## v2.1.0 (2026-10-15)

- 增加行情新鲜度、收藏、单件详情、历史恢复与过滤状态。

## v2.0.0 (2026-10-15)

- 增加独立 Electron 桌面版、只读请求适配、磁盘持久化和离线演示。


## v1.1.2 (2026-10-11)

### 修复
- 当默认“只看达标候选”暂时筛出 0 件、Steam 行情仍在复核时，弹窗和数据面板显示最多 20 件待复核预选项，避免看起来像没有扫描结果；结果计数明确区分已达标与待复核。

## v1.1.1 (2026-10-11)

### 修复
- 移除扫描前对 `chrome.cookies.getAll()` 的硬性登录拦截；该检查会把有效 BUFF 登录态误判为未登录。
- 以 BUFF API 实际响应作为登录态判据；只有 API 返回 Login Required/未授权时才报告登录问题，并给出更准确的提示。
- 移除不再需要的 `cookies` 扩展权限。

## v1.1.0 (2026-10-11)

### 改进
- 修复扫描消息等待全量完成才响应的问题，弹窗现在可实时显示扫描进度并停止任务。
- BUFF 登录态检查收窄到 BUFF 域，并使用浏览器凭证执行只读请求；当前页扫描读取当前 BUFF 标签页的页码。
- 新增 Steam 求购盘核实：缓存 Steam item_nameid，读取最高求购价与买卖盘数据，快速卖出比例按最高求购价估算。
- 扫描后自动按 BUFF 参考成本筛选并限速复核最多 20 个候选；支持手动分批补查，保存部分复核结果。
- 增加“挂单成本率”“快速卖出成本率”“Steam 近 24 小时成交量”和供给覆盖天数，默认成本率 ≤0.75、覆盖 ≤3 天。
- 搜索支持完整 Steam 市场名、名称、游戏和物品 ID；精确市场名优先展示；过滤条件在弹窗与数据面板持久化。
- 数据面板重做为双价格口径对照，导出中包含两种成本率、报价时间和流动性字段。
- 新增术语表、ADR 与成本/流动性测试；版本升级至 1.1.0。

### 注意
- Steam 求购盘接口属于社区市场页面接口，可能限流或暂时不可用；未获取到求购价的物品不会标为达标候选。
- “供给覆盖天数 = Steam 在售数量 ÷ 近 24 小时成交量”是大盘流动性代理值，不保证单件商品在三天内成交。
- BUFF 扫描需要用户已在浏览器登录 BUFF；Steam Wallet 余额不可提现或转账。## v1.0.1 (2026-08-04)

### 修复
- **Steam 在售数据缺失**：Steam listings 页面已改为 React SPA，HTML 中无法抓取 `item_nameid`。改用 `/market/search/render/` 接口，直接用 `market_hash_name` 查询，返回 `sell_listings`（在售数）。

### 已知限制
- **Steam 求购数据（buy_order）暂时无法获取**：Steam 改版后必须用浏览器渲染整个 listings 页面才能拿到 buy_order 数据，超出当前扩展能力。UI 中"Steam 求购"列显示 "—"，提示用户此字段需后续方案。

## v1.0.0 (2026-08-04)

首发版本，但包含一次完整的优化重构。

### 修复的 Bug
- **CSV 公式注入 (CWE-1236)**：导出名称以 `=` `+` `-` `@` 开头的物品不再被 Excel 当公式
- **content.js createBadge 抛 TypeError**：移除整个 `content_scripts`（死代码 + 抛错）
- **profit.toFixed undefined 抛错**：表格/CSV 计算加 `(|| 0)` 防御
- **扫描时间显示错误**：dashboard 不再用 `new Date()`，改用实际扫描时间；>15min 加 ⚠
- **storage 配额超限静默失败**：识别 `QUOTA` 错误，popup 立即变红提示
- **enrich 失败静默吞错**：加 `enrichFailed` / `enrichSkipped` 计数 + UI 显示

### 新增功能
- **数据陈旧度**：popup 顶栏 + 每件物品的 enrichment 时间
- **SW 重启自愈**：扫描期间 `chrome.alarms` 防 idle 30s 回收；popup 启动检测 stale heartbeat 自动修复
- **fetchWithRetry**：Steam 5xx 指数退避重试 3 次，尊重 `Retry-After`
- **enrichment 错误分类**：429/404/5xx/网络错误分别处理，404 + 正则失败永久标记 `steamUnsupported`
- **scanAll 并发 = 2**：worker pool 理论加速 ~1.85x

### 安全改进
- **innerHTML → DOM API**：popup/dashboard 改用 `el()` + `setAttribute`，防 item.name XSS
- **safeUrl 协议白名单**：javascript:/data: URL 自动剔除
- **manifest CSP**：显式 `script-src 'self'; object-src 'self'`
- **manifest 精简**：删 `activeTab`（未用）、`unlimitedStorage`（单次扫描 ~5MB）

### 清理
- 删除 4 个无人调用的 message handler（`getScanState`/`getSettings`/`saveSettings`/`clearData`）
- 删除 2 个未用 storage 函数（`clearScanState`/`loadScanState`/`saveSettings`/`loadSettings`）
- 删除 `STORAGE_KEYS.SETTINGS` 常量
- 删除 `btnSettings` 死按钮

### 新文件
- `lib/dom.js`：DOM 工具（`el`/`escapeHtml`/`safeUrl`/`clearChildren`）
- `tests/run-tests.js`：27 个单元测试
- `tests/integration-test.js`：21 个集成测试
- `build/package.js`：打包脚本

### 改动统计
- 改动文件：13 个
- 测试通过：48/48
- 打包大小：26.6 KB

## v0.x (历史版本)

仅在本地迭代，无版本记录。

