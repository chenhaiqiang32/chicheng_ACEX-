# ACEX 多文件包转换服务（预渲染 / html-exporter）

本目录可整包拷贝到 Windows 服务器，与演示前端解耦（同 `acex试用/fuwu`）。

服务器用 [`@mlightcad/cad-html-exporter`](https://www.npmjs.com/package/@mlightcad/cad-html-exporter)（**纯 Node，无浏览器**）把 DWG/DXF **一次**转成 ACEX multi zip；浏览器只加载显示几何。

架构对齐：[cad-viewer-nextjs-demo](https://github.com/mlightcad/cad-viewer-nextjs-demo) 预渲染路径。  
演示前端在同级 [`../frontend/`](../frontend/)，不要随本目录一起部署。

## 目录

```text
html-exporter/
  index.mjs                 # HTTP 服务入口
  lib/
    runExport.mjs           # 子进程调用 cad-html-exporter → zip
    resolveDwgParser.mjs    # dwg / libredwg 选择
    ensureNodeCanvas.mjs    # Node 下 OLE/EMF 栅格化（@napi-rs/canvas）
    t3Convert.mjs           # 天正检测 + t3-conv（可选）
  scripts/
    convert-one.mjs
    convert.mjs
    sync-cad-data.mjs
    detect-tianzheng.mjs
  docs/
    convert-api.md
    windows-deploy.md
  cad-data/                 # 自托管字体（postinstall 同步）
  start-server.bat
  package.json
```

## 与旧版 fuwu 的区别

| | 旧 fuwu | 本服务 |
| --- | --- | --- |
| 引擎 | cad-simple-viewer-cli + Playwright | cad-html-exporter |
| 浏览器 | 需要系统 Chrome | **不需要** |
| Node | ≥20 | **≥22** |
| API | import / status / download | **相同** |

## 快速开始

需要 **Node.js 22+**。

```bash
cd html-exporter
npm install
npm run server       # http://localhost:8787
```

Windows 也可双击 `start-server.bat`。

健康检查：`GET /api/health` → `ok: true`、`fonts: true`、`browser: false`。

本地联调前端（在仓库根目录，不在本目录）：

```bash
cd ..
npm install
npm run dev          # 代理 /api → http://127.0.0.1:8787
```

## API（摘要）

```text
POST /api/models/import
GET  /api/models/import/:jobId/status   # ready | failed | null
GET  /api/models/:jobId/download?type=zip
```

完整说明：[docs/convert-api.md](./docs/convert-api.md)

## CLI 批量转换

```bash
npm run convert -- ./drawings ./out
```

## 字体

转换使用本目录 `cad-data/`，不走 CDN。部署时务必带上完整 `fonts/`。

```bash
npm run sync:cad-data
```

## DWG 解析器

1. 已安装 `@mlightcad/dwg-converter`（optionalDependency，GitHub Packages tarball）→ 商业解析器  
2. 否则 → LibreDWG  
3. `DWG_PARSER=dwg|libredwg` 可强制；商业许可 `DWG_LICENSE_KEY`

安装商业包需要 `GITHUB_TOKEN`（`read:packages`），见 `.npmrc` 与官方文档。  
**版本必须对齐：** `dwg-converter` 与 `@mlightcad/data-model` 同版本（当前 `1.15.21`，与 `cad-html-exporter@1.7.8` 一致），否则会出现双份 data-model 单例错误。安装后请重启 `npm run server`。

## OLE 表格 / Excel 嵌入对象

图中白色“汇总表”一类对象常为 `OLE2FRAME`（Excel 嵌入），预览是 WMF/EMF。  
Node 无浏览器 Canvas 时无法栅格化，导出后右上角会空白。本服务依赖 `@napi-rs/canvas`，转换前注入 `OffscreenCanvas`（日志可见 `canvas=napi_rs_canvas`）。

## 天正（可选，Windows）

```bat
set T3_MODE=auto
set T3CONV_EXE=t3-conv\t3conv.exe
npm run server
```

## Windows 服务器

见 [docs/windows-deploy.md](./docs/windows-deploy.md)。  
**只拷贝本目录**（含完整 `cad-data/`），目标机重新 `npm install`；不要跨机拷 `node_modules`，也不要带上同级 `frontend/`。
