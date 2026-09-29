# ACEX 转换服务（独立部署）

本目录可整包拷贝到其它服务器，与前端 Demo 解耦。

## 目录

```text
fuwu/
  index.mjs                 # HTTP 转换服务入口
  lib/
    runHeadlessLocal.mjs    # 无头转换：强制使用本地 cad-data（不访问 CDN）
    sanitizeAcexOutliers.mjs # 转换后剔除离群垃圾坐标并重写 viewExtents
  package.json
  cad-data/                 # 自托管字体与模板（转换 + 静态 /cad-data）
  scripts/
    export-html-multi.scr
    convert.mjs
  docs/
    convert-api.md
```

## 字体（本地，不依赖外网）

转换与看图均使用本目录 `cad-data/`，**不再请求** jsDelivr CDN。服务器网络不通外网时也能完整出图元。

实现方式对齐 [Self-Hosted Fonts and Templates](https://github.com/mlightcad/cad-viewer/wiki/Self-Hosted-Fonts-and-Templates)：

- 目录：`cad-data/fonts/`、`cad-data/templates/`、`cad-data/fonts/fonts.json`
- Headless 内把 CDN `cad-data` 请求拦截并落到本地文件
- HTTP 同时托管 `GET /cad-data/...`，便于前端 Viewer 同样自托管

部署时请一并拷贝完整 `cad-data/`（尤其 `fonts/`）。

## 部署

需要 **Node.js 20+**。

```bash
cd fuwu
npm install
npm run install:browser
# Linux 若缺系统库：npx playwright install-deps chromium
# 升级 CLI 后务必重装浏览器；Windows 也可设 PLAYWRIGHT_BROWSER_CHANNEL=chrome

npm run server
# 或：PORT=8787 node index.mjs
```

> **CLI 1.7.1 注意**：转换**强制使用系统 Chrome/Edge**（按常见安装路径解析 `chrome.exe`，可用 `PLAYWRIGHT_CHROME_PATH` 指定）。不要用 Playwright 自带 Chromium，否则易出现 chunks/图元缺失（见 [issue #667](https://github.com/mlightcad/cad-viewer/issues/667)）。仅调试时可设 `PLAYWRIGHT_BROWSER_CHANNEL=chromium`。

### 服务器部署排障

拷贝 `fuwu/` 后本地正常、服务器丢图元时，优先对照每次任务目录下的 `convert.log`（`.cad-work/out/<jobId>/convert.log`）：

| 日志字段 | 含义 |
| --- | --- |
| `cad-data fontFiles=` | 字体文件数量；过小说明 `cad-data/fonts` 没拷全 |
| `local cad-data miss` / `localMisses=` | 字体 404，文字几何会丢 |
| `astronomicalExtents=true` | viewExtents 天文数字，Fit 后像「全丢」；应被 sanitize 修正 |
| `zip BEFORE/AFTER sanitize` | 清洗前后 chunks/batches/extents |
| `page.warning Timed out waiting for scene idle` | 场景未就绪就导出，图元不完整 |

环境变量：

- `CONVERT_DEBUG=0` — 关闭详细控制台（文件日志仍写）
- `PLAYWRIGHT_CHROME_PATH` — 强制 chrome.exe 路径
- `CONVERT_CHROME_NO_SANDBOX=0` — 取消默认 `--no-sandbox`
- `CONVERT_CHROME_ARGS` — 追加 Chrome 启动参数（空格分隔）
- `CONVERT_IDLE_TIMEOUT_MS` — 等待图元转换完成超时（默认 `600000`=10 分钟；官方包仅 120 秒）
- `CONVERT_USE_SWIFTSHADER=1|0` — 强制开/关软渲染 WebGL（阿里云等无独显主机默认开启）

云主机若日志出现 `Timed out waiting for scene idle` / `deferred geometry`，说明 GPU/WebGL 太慢，导出被截断（典型 chunks~70/batches~390）。部署本目录最新代码后重启即可；仍不足则：

```bat
set CONVERT_IDLE_TIMEOUT_MS=900000
set CONVERT_USE_SWIFTSHADER=1
npm run server
```

健康检查：`GET http://localhost:8787/api/health`  
期望：`{ "ok": true, "script": true, "fonts": true, "fontsMode": "local" }`  
`fonts: false` 时不要调转换（本地字体目录不完整）。

## 迁移到其它机器

拷贝整个 `fuwu/`（含 **完整** `cad-data/`，**不要**跨平台拷贝 `node_modules`），在目标机重新 `npm install` 与 `install:browser`。

## CLI 批量转换（可选）

```bash
npm run convert -- ./drawings ./out
```

同样走本地 `cad-data` 字体。

## API

异步三步对接（详见 [docs/convert-api.md](./docs/convert-api.md)）：

```text
POST /api/models/import
GET  /api/models/import/:jobId/status   # ready | failed | null(转换中)
GET  /api/models/:jobId/download?type=zip
```
