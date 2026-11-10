# Windows 服务器部署（html-exporter / 预渲染）

本服务使用 `@mlightcad/cad-html-exporter`（纯 Node），**不需要**安装 Chrome 或 Playwright。

**只部署本目录 `html-exporter/`**（对齐 `acex试用/fuwu`）。同级 `frontend/` 演示页不要拷到服务器。

## 环境要求

- Windows Server（或 Win10/11）
- **Node.js 22+**（exporter 要求）
- 完整 `cad-data/`（`npm run sync:cad-data` 或从开发机拷贝）
- （可选）天正 T3：T20 / AutoCAD + `t3conv.exe`

## 1. 安装

```bat
cd /d D:\deploy\html-exporter
npm install
npm run sync:cad-data
```

确认健康：

```bat
node -e "console.log(require('fs').existsSync('cad-data/fonts/fonts.json'))"
```

应输出 `true`。

## 2. 手动启动

```bat
start-server.bat
```

或：

```bat
set PORT=8787
node index.mjs
```

健康检查：http://127.0.0.1:8787/api/health  
期望：`ok: true`、`fonts: true`、`browser: false`。

## 3. NSSM 开机自启（推荐）

管理员 CMD（路径按本机修改）：

```bat
set NSSM=D:\tools\nssm\win64\nssm.exe
set NODE=C:\Program Files\nodejs\node.exe
set APP=D:\deploy\html-exporter

mkdir "%APP%\logs"

"%NSSM%" install AcexHtmlExporter "%NODE%"
"%NSSM%" set AcexHtmlExporter AppDirectory "%APP%"
"%NSSM%" set AcexHtmlExporter AppParameters index.mjs
"%NSSM%" set AcexHtmlExporter AppStdout "%APP%\logs\stdout.log"
"%NSSM%" set AcexHtmlExporter AppStderr "%APP%\logs\stderr.log"
"%NSSM%" set AcexHtmlExporter AppRotateFiles 1
"%NSSM%" set AcexHtmlExporter AppExit Default Restart
"%NSSM%" set AcexHtmlExporter AppEnvironmentExtra PORT=8787 T3_MODE=off
"%NSSM%" set AcexHtmlExporter Start SERVICE_AUTO_START
"%NSSM%" start AcexHtmlExporter
```

启用天正时把环境变量改为例如：

```bat
"%NSSM%" set AcexHtmlExporter AppEnvironmentExtra PORT=8787 T3_MODE=auto T3CONV_EXE=D:\tianzheng\t3-conv\t3conv.exe
```

验证：

```bat
sc query AcexHtmlExporter
"%NSSM%" get AcexHtmlExporter Application
```

期望：`RUNNING`，`Application` 为 `node.exe`（不是 `cmd.exe`）。

## 4. 防火墙

```bat
netsh advfirewall firewall add rule name="AcexHtmlExporter 8787" dir=in action=allow protocol=TCP localport=8787
```

## 5. 环境变量

| 变量 | 说明 |
| --- | --- |
| `PORT` | 监听端口，默认 `8787` |
| `DWG_PARSER` | `dwg` / `libredwg`（默认自动选择；已装商业包时为 `dwg`） |
| `DWG_LICENSE_KEY` | 商业 DWG 解析器许可证（可选；不设走试用） |
| `GITHUB_TOKEN` | 仅 **安装时** 需要（`read:packages`），用于拉 GitHub Packages 的 `@mlightcad/dwg-converter` |
| `T3_MODE` | `off`（默认）/ `auto` / `always` |
| `T3CONV_EXE` | `t3conv.exe` 绝对路径 |
| `T3CONV_TIMEOUT_SECONDS` | 天正转换超时，默认 600 |

## 6. 与旧版 fuwu（Playwright）差异

| 项 | 旧 fuwu | 本服务 html-exporter |
| --- | --- | --- |
| 转换引擎 | cad-simple-viewer-cli + Chromium | cad-html-exporter（Node） |
| 浏览器依赖 | 需要系统 Chrome | **不需要** |
| Node | 20+ | **22+** |
| API | 相同三步导入 | 相同（可替换对接） |

## 7. 验收

1. `/api/health` → `ok: true`
2. 用一张普通 DWG 走 import → status → download
3. 解压 zip，确认有 `drawing.acex.json` + `chunks/`
4. 用 http(s) 打开 `viewer.html` 或把 JSON URL 交给业务 Viewer
