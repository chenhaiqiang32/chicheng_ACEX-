# ACEX 转换服务接入说明

面向业务后端 / 其它服务：如何调用转换接口拿到 **zip**，解压后继续对接二维 Viewer。

默认地址：`http://localhost:8787`（环境变量 `PORT` 可改）

---

## 1. 对接流程

```text
上传 .dwg / .dxf  →  POST /api/convert  →  得到 zip
       →  业务侧解压落盘  →  对外提供 drawing.acex.json 地址
```

二维 Viewer 需要的是解压后的 **JSON 地址**（如 `…/drawing.acex.json`），不要把 zip 或原始 `.dwg` / `.dxf` 直接交给前端看图页。

---

## 2. 转换接口

```http
POST /api/convert
Content-Type: multipart/form-data
```

### 入参

| 字段 | 位置 | 必填 | 说明 |
| --- | --- | --- | --- |
| `file` | form-data | 是 | `.dwg` 或 `.dxf`，字段名必须为 `file`；单文件 ≤ 200MB |

### 返回（成功）

| 项 | 说明 |
| --- | --- |
| HTTP | `200` |
| `Content-Type` | `application/zip` |
| Body | zip 二进制 |
| `Content-Disposition` | `attachment; filename="<名称>.zip"` |

### 返回（失败）

```json
{ "error": "错误信息" }
```

| HTTP | 说明 |
| --- | --- |
| `400` | 缺少 `file`，或不是 `.dwg` / `.dxf` |
| `500` | 转换失败 |

### 调用示例

```bash
curl -X POST "http://localhost:8787/api/convert" \
  -F "file=@./canteen.dwg" \
  -o canteen.zip
```

```js
const form = new FormData()
form.append('file', file) // File / Blob，字段名必须是 file

const res = await fetch('http://localhost:8787/api/convert', {
  method: 'POST',
  body: form
})
if (!res.ok) throw new Error((await res.json()).error)
const zipBlob = await res.blob()
```

---

## 3. Zip 解压后结构

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

## 4. 健康检查（可选）

```http
GET /api/health
```

```json
{ "ok": true, "script": true }
```

`ok: true` 且 `script: true` 时再调转换。

---

## 5. 注意

- 转换依赖 headless Chromium，耗时随图纸变大，客户端超时建议放宽到数分钟  
- CORS 已开启，浏览器也可直连；生产建议由业务后端调用并落盘  
- 必须通过 http(s) 访问解压后的资源，不能用 `file://`
