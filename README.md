# ACEX 预渲染看图 Demo

参考官方文档：[acex-web-hosting-guide.md](https://github.com/mlightcad/cad-viewer/blob/main/packages/cad-html-plugin/docs/acex-web-hosting-guide.md)

实现两条路径：

1. **方式二：服务端 / CI 批量转换**（`@mlightcad/cad-simple-viewer-cli` + Playwright 无头 Chromium）
2. **前端解压并打开**：`unzipAcExPackageFiles` → Cache Storage → Service Worker 虚拟静态目录 → 打开 `viewer.html`

## 准备

需要 **Node.js 20+**。

```bash
npm install
npm run install:browser
```

可选样例图纸（官方 canteen）：

```bash
# PowerShell
Invoke-WebRequest https://cdn.jsdelivr.net/gh/mlightcad/cad-data@main/data/canteen.dwg -OutFile drawings/canteen.dwg
```

## 启动

开两个终端：

```bash
# 终端 1：转换 API（默认 :8787）
npm run server

# 终端 2：前端（默认 :5173，已代理 /api）
npm run dev
```

浏览器打开 http://localhost:5173

1. 上传 `.dwg` / `.dxf` → 服务端 CLI 导出 multi zip  
2. 前端自动解压并打开查看器（也可单独选择已有 `.zip`，例如 `out/canteen.zip`）

## CLI 批量转换（CI）

```bash
npm run convert -- ./drawings ./out
# 输出：./out/*.zip（已用 canteen.dwg 验证成功）
```

解压后托管：

```text
my-drawing/
  viewer.html
  drawing.acex.json
  chunks/
    L0-000.acex.gz
    ...
```

## API

对接说明（拿 zip 继续开发）：[docs/convert-api.md](./docs/convert-api.md)

`POST /api/convert`  
- `multipart/form-data` 字段名：`file`  
- 返回：`application/zip`  
- 可选：`?publish=1` 时服务端同时解压到 `published/{id}/`，可通过 `/packages/{id}/viewer.html` 访问

## 注意

- 必须通过 `http(s)` 访问，不能 `file://` 双击打开 multi 包。
- `.acex.gz` / `.osnap.gz` **不要**加 `Content-Encoding: gzip`（本 Demo 的 SW / Express 静态托管已按原字节返回）。
- 转换依赖 headless Chromium，首跑请执行 `npm run install:browser`。
