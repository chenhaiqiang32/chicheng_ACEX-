# ACEX 转换服务接入说明

面向业务后端 / 其它服务：如何通过 **异步导入** 拿到 **zip**，解压后继续对接二维 Viewer。

默认地址：`http://localhost:8787`（环境变量 `PORT` 可改）

---

## 1. 对接流程

```text
提交图纸 URL
  →  POST /api/models/import          得到 jobId（202）
  →  GET  /api/models/import/:jobId/status   轮询直到 ready / failed
  →  GET  /api/models/:jobId/download?type=zip   下载转换后 zip
  →  业务侧解压落盘  →  对外提供 drawing.acex.json 地址
```

状态约定：

| `status` | 含义 |
| --- | --- |
| `null` | 转换中（`pending` / `downloading` / `converting`） |
| `ready` | 成功，可下载 zip；同时返回 `fileId`（源文件 MD5） |
| `failed` | 失败，见 `errorMessage` |

二维 Viewer 需要的是解压后的 **JSON 地址**（如 `…/drawing.acex.json`），不要把 zip 或原始 `.dwg` / `.dxf` 直接交给前端看图页。

---

## 2. 提交 URL 导入任务

```http
POST /api/models/import
Content-Type: application/json
```

服务端根据 URL **下载**图纸并在后台执行转换；接口立即返回任务句柄 `jobId`，用状态接口轮询进度。

### 入参（Body JSON）

| 字段 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `url` | string | 是 | 远程文件地址，仅支持 `http` / `https`（含 OSS 预签名 URL） |
| `filename` | string | 否 | 原始文件名（含扩展名）。省略时从 URL 路径末段推断 |
| `headers` | object | 否 | 下载时额外请求头（OSS 鉴权 / 签名场景） |

仅支持 `.dwg` / `.dxf`。

### 请求示例

```json
{
  "url": "https://oss.example.com/canteen.dwg",
  "filename": "canteen.dwg"
}
```

### 返回（202 Accepted）

```json
{
  "code": 0,
  "message": "accepted",
  "data": {
    "jobId": "3f2a1c9e-7b40-4d2e-9a11-8c5f0b2d6e77",
    "status": "pending"
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `jobId` | 导入任务句柄，用于轮询状态与下载 |
| `status` | 初始为 `pending`；内部流转：`pending` → `downloading` → `converting` → `ready` / `failed` |

### 调用示例

```bash
curl -X POST "http://localhost:8787/api/models/import" \
  -H "Content-Type: application/json" \
  -d '{"url":"https://oss.example.com/canteen.dwg","filename":"canteen.dwg"}'
```

```js
const res = await fetch('http://localhost:8787/api/models/import', {
  method: 'POST',
  headers: { 'Content-Type': 'application/json' },
  body: JSON.stringify({
    url: 'https://oss.example.com/canteen.dwg',
    filename: 'canteen.dwg'
  })
})
const { data } = await res.json()
const { jobId } = data
```

---

## 3. 查询导入任务状态

```http
GET /api/models/import/:jobId/status
```

建议每隔 1～2 秒轮询，直到 `status` 为 `ready` 或 `failed`。

### 路径参数

| 参数 | 类型 | 必填 | 说明 |
| --- | --- | --- | --- |
| `jobId` | string | 是 | 导入接口返回的任务句柄 |

### 返回（200 OK）

```json
{
  "code": 0,
  "data": {
    "jobId": "3f2a1c9e-7b40-4d2e-9a11-8c5f0b2d6e77",
    "status": "ready",
    "fileId": "60bb0ee9f0658d1d675b55feefc4f136",
    "errorMessage": null
  }
}
```

| 字段 | 说明 |
| --- | --- |
| `status` | `ready` 成功；`failed` 失败；转换中为 `null` |
| `fileId` | 下载源文件内容的 MD5；仅 `ready` 时有值，否则 `null` |
| `errorMessage` | 失败原因（如下载失败 / 转换失败）；仅 `failed` 时非空 |

### 调用示例

```js
async function waitReady(jobId) {
  for (;;) {
    const res = await fetch(
      `http://localhost:8787/api/models/import/${jobId}/status`
    )
    const { data } = await res.json()
    if (data.status === 'ready') return data
    if (data.status === 'failed') {
      throw new Error(data.errorMessage || 'conversion failed')
    }
    // status === null → 转换中
    await new Promise((r) => setTimeout(r, 1500))
  }
}
```

---

## 4. 下载转换结果 zip

```http
GET /api/models/:jobId/download?type=zip
```

其中 `:jobId` 为 **导入接口返回的 `jobId`**（须已 `ready`）。

### 返回（成功）

| 项 | 说明 |
| --- | --- |
| HTTP | `200` |
| `Content-Type` | `application/zip` |
| Body | zip 二进制 |
| `Content-Disposition` | `attachment; filename="<名称>.zip"` |

**一次性下载：** 响应写完后服务端会删除该任务在 `.cad-work/out/<jobId>/` 下的留存（源图纸、zip、日志）。同一 `jobId` 再次下载会 `409`（`zip already downloaded and removed`）。业务侧请自行保存 zip。

### 返回（未就绪 / 失败）

```json
{ "code": 409, "message": "job not ready", "data": { "jobId": "...", "status": null } }
```

### 调用示例

```bash
curl -L "http://localhost:8787/api/models/<jobId>/download?type=zip" -o canteen.zip
```

```js
const res = await fetch(
  `http://localhost:8787/api/models/${jobId}/download?type=zip`
)
if (!res.ok) throw new Error(`download HTTP ${res.status}`)
const zipBlob = await res.blob()
```

---

## 5. Zip 解压后结构

| 路径 | 说明 |
| --- | --- |
| `viewer.html` | 包内自带看图页（须 http(s) 打开） |
| `drawing.acex.json` | **二维 Viewer 应使用的入口 JSON** |
| `chunks/*.acex.gz` 等 | 分块资源，与 JSON 同目录树一起托管 |

业务侧建议：

1. 下载 zip 并解压到可访问的静态目录 / OSS  
2. 把 `drawing.acex.json` 的可访问 URL 交给 Viewer（见三维 iframe 对接里的 `getModelUrl`）  
3. 保证同包内 `chunks/` 等相对路径资源可访问  

**注意：** `.acex.gz` / `.osnap.gz` 按原字节返回，不要加 `Content-Encoding: gzip`。

---

## 6. 健康检查（可选）

```http
GET /api/health
```

```json
{ "ok": true, "script": true, "fonts": true, "fontsMode": "local", "cadData": "/cad-data/" }
```

`ok: true` 表示脚本与本地 `cad-data/fonts/fonts.json` 都就绪后再调转换。转换强制使用本地字体，不访问 CDN。

---

## 7. 注意

- 转换依赖 headless Chromium，耗时随图纸变大；请用状态接口轮询，不要把客户端超时设得过短  
- 转换字体来自本机 `fuwu/cad-data/`，部署时勿漏拷；健康检查 `fonts: true` 再上线  
- 转换完成后会清洗 ACEX 包中的离群垃圾坐标（重写 `viewExtents` 并剔除异常 batch），避免预渲染 Fit 空白  
- CORS 已开启，浏览器也可直连；生产建议由业务后端调用并落盘  
- 必须通过 http(s) 访问解压后的资源，不能用 `file://`  
- 任务状态保存在进程内存中；服务重启后旧 `jobId` 失效
