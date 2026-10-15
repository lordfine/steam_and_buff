# 参与开发

欢迎报告可复现的问题、改进文档或提交小而明确的 PR。

1. Node.js 22+，执行 `npm ci`。
2. 计算、解析与行情新鲜度放在 `lib/`；扫描管线统一在 `background.js`。
3. `desktop/` 负责本地存储、窗口与受限 IPC；根目录 popup/dashboard 是 MV3 插件界面。两端共用 `ui/` 设计令牌与品牌资源。
4. 行情缺失不伪造为 0；不混用币种、饰品变体或新旧时间；不自动交易。
5. 修改网络逻辑要增加失败路径测试。优先使用合成行情，不要提交真实账号数据。

```sh
npm test
npm run build:extension
npx playwright install chromium
npm run test:extension
npm run test:e2e
```

桌面 UI 测试需要桌面环境；Linux CI 若自行扩展请使用虚拟显示。当前自动化验收基线是 Windows。

真实 Steam 检查是可选项：设置 `SKINLEDGER_LIVE_TEST=1` 后运行插件测试。该检查使用临时配置，只请求公开商品页，不自动登录。

PR 请说明：问题、改动范围、验证命令、界面截图（如适用）。不要携带生成的安装包、浏览器配置、日志、密钥或个人路径。
