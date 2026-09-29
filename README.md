# ACEX 预渲染看图 Demo

参考官方文档：[acex-web-hosting-guide.md](https://github.com/mlightcad/cad-viewer/blob/main/packages/cad-html-plugin/docs/acex-web-hosting-guide.md)

本仓库拆成两部分：

1. **前端 Demo**（本目录 `frontend/`）：解压 multi zip → Cache Storage / Service Worker → 打开 `viewer.html`
2. **转换服务**（[`fuwu/`](./fuwu/)）：DWG/DXF → multi zip，可单独拷贝到其它服务器

## 前端准备

需要 **Node.js 20+**。

```bash
npm install
npm run dev
```

浏览器打开 http://localhost:5173

前端默认通过 Vite 代理调用远程/本地转换服务（见 `frontend/vite.config.js` 中的 `CONVERT_SERVER`）。

填写可访问的 `.dwg` / `.dxf` **在线 URL** 提交导入并轮询结果，或直接选择已有 multi `.zip`。

## 转换服务

见 [`fuwu/README.md`](./fuwu/README.md)。本地联调示例：

```bash
cd fuwu
npm install
npm run install:browser
npm run server
```

API 对接说明：[fuwu/docs/convert-api.md](./fuwu/docs/convert-api.md)

## 注意

- 必须通过 `http(s)` 访问，不能 `file://` 双击打开 multi 包。
- `.acex.gz` / `.osnap.gz` **不要**加 `Content-Encoding: gzip`（本 Demo 的 SW 已按原字节返回）。
