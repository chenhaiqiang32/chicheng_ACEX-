# ACEX 预渲染 Demo（html-exporter）

与 `acex试用` 相同拆分方式：

| 目录 | 角色 | 部署 |
| --- | --- | --- |
| [`html-exporter/`](./html-exporter/) | 转换服务（`@mlightcad/cad-html-exporter`，纯 Node） | **单独拷贝到 Windows 服务器** |
| [`frontend/`](./frontend/) | 演示前端（URL 导入 / 解压打开 / JSON 打开） | 本地或静态托管，不随转换服务部署 |

官方预渲染说明：[cad-viewer-nextjs-demo](https://github.com/mlightcad/cad-viewer-nextjs-demo)

## 本地联调

```bash
# 终端 1：转换服务
cd html-exporter
npm install
npm run server          # http://localhost:8787

# 终端 2：演示前端（仓库根目录）
cd ..
npm install
npm run dev             # https://localhost:5173 ，代理 /api → 8787
```

代理目标可覆盖：

```bash
set CONVERT_SERVER=http://127.0.0.1:8787
npm run dev
```

## Windows 服务器

只部署 `html-exporter/`（含 `cad-data/`），见 [html-exporter/docs/windows-deploy.md](./html-exporter/docs/windows-deploy.md)。  
**不要**把本仓库根目录的 `frontend/`、`node_modules` 拷到服务器。
