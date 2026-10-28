# Windows 服务器部署（双端口）

面向服务器两套独立目录，分别监听 **8787** / **8788**，并启用天正 T3 预处理。  
本地开发机见 [windows-deploy.local.md](./windows-deploy.local.md)。

## 目录约定

| 目录 | 端口 | 用途 |
| --- | --- | --- |
| `D:\chenhaiqiang\fuwu_8787端口` | 8787 | 正式 / 指定端口实例 |
| `D:\chenhaiqiang\fuwu_8788测试端口` | 8788 | 测试实例 |

固定路径：

```text
T3CONV_EXE              = D:\chenhaiqiang\tianzheng\t3-conv\t3conv.exe
PLAYWRIGHT_CHROME_PATH  = C:\Program Files\Google\Chrome\Application\chrome.exe
  (NSSM 环境变量请用短路径 C:\PROGRA~1\Google\Chrome\Application\chrome.exe)
```

每个目录都是完整 `fuwu` 拷贝（含 `cad-data/`），**不要**跨机拷贝 `node_modules`。

## 1. 一次性安装（每个目录各做一次）

需要：Node.js 20+、系统 Chrome、（天正则另装）T20 V9 / AutoCAD / t3-conv。

```bat
cd /d D:\chenhaiqiang\fuwu_8787端口
npm install
npm run install:browser

cd /d D:\chenhaiqiang\fuwu_8788测试端口
npm install
npm run install:browser
```

把仓库里的 `start-fuwu.bat` 拷进两个目录后，**改默认端口**（仅手工双击用）：

- `fuwu_8787端口\start-fuwu.bat` → `if not defined PORT set PORT=8787`
- `fuwu_8788测试端口\start-fuwu.bat` → `if not defined PORT set PORT=8788`

> `.bat` 保持 **ASCII 英文注释**，不要写中文（UTF-8 会被 CMD 按 GBK 拆行）。

## 2. 命令行手动启动

```bat
D:\chenhaiqiang\fuwu_8787端口\start-fuwu.bat
D:\chenhaiqiang\fuwu_8788测试端口\start-fuwu.bat
```

或临时覆盖端口：

```bat
cd /d D:\chenhaiqiang\fuwu_8787端口
set PORT=8787
start-fuwu.bat
```

健康检查：

- http://127.0.0.1:8787/api/health
- http://127.0.0.1:8788/api/health

期望：`ok: true`、`fonts: true`；`t3` 字段表示天正是否就绪。

## 3. 开机自启（推荐 NSSM）

- 版本：**[NSSM 2.24-101](https://nssm.cc/download)**（Server 2022 用 pre-release，勿用 2014 旧版 2.24）。
- 本机路径：`D:\chenhaiqiang\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe`
- **直接跑 `node.exe` + `AppParameters index.mjs`**，不要用 `cmd /c bat` 当服务入口。
- 若 `install` 报「服务已存在」：不要重复 install，执行下面的 `set`，并确认 **`Application` 就是 `node.exe`**。若仍是 `cmd.exe` 而参数是 `index.mjs`，会出现 `RUNNING` 但 **端口拒绝连接**。

管理员 CMD（`NODE` 若不是默认安装路径，先 `where node` 再改）：

```bat
set NSSM=D:\chenhaiqiang\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe
set NODE=C:\Program Files\nodejs\node.exe

mkdir "D:\chenhaiqiang\fuwu_8787端口\logs"
mkdir "D:\chenhaiqiang\fuwu_8788测试端口\logs"
```

### 8787 服务

```bat
"%NSSM%" install AcexConvert8787 "%NODE%"
"%NSSM%" set AcexConvert8787 AppDirectory "D:\chenhaiqiang\fuwu_8787端口"
"%NSSM%" set AcexConvert8787 AppParameters index.mjs
"%NSSM%" set AcexConvert8787 AppStdout "D:\chenhaiqiang\fuwu_8787端口\logs\stdout.log"
"%NSSM%" set AcexConvert8787 AppStderr "D:\chenhaiqiang\fuwu_8787端口\logs\stderr.log"
"%NSSM%" set AcexConvert8787 AppRotateFiles 1
"%NSSM%" set AcexConvert8787 AppExit Default Restart
"%NSSM%" set AcexConvert8787 AppEnvironmentExtra PORT=8787 CONVERT_IDLE_TIMEOUT_MS=600000 CONVERT_USE_SWIFTSHADER=1 T3_MODE=auto T3CONV_EXE=D:\chenhaiqiang\tianzheng\t3-conv\t3conv.exe PLAYWRIGHT_CHROME_PATH=C:\PROGRA~1\Google\Chrome\Application\chrome.exe
"%NSSM%" set AcexConvert8787 Start SERVICE_AUTO_START
"%NSSM%" start AcexConvert8787
```

### 8788 服务

```bat
"%NSSM%" install AcexConvert8788 "%NODE%"
"%NSSM%" set AcexConvert8788 AppDirectory "D:\chenhaiqiang\fuwu_8788测试端口"
"%NSSM%" set AcexConvert8788 AppParameters index.mjs
"%NSSM%" set AcexConvert8788 AppStdout "D:\chenhaiqiang\fuwu_8788测试端口\logs\stdout.log"
"%NSSM%" set AcexConvert8788 AppStderr "D:\chenhaiqiang\fuwu_8788测试端口\logs\stderr.log"
"%NSSM%" set AcexConvert8788 AppRotateFiles 1
"%NSSM%" set AcexConvert8788 AppExit Default Restart
"%NSSM%" set AcexConvert8788 AppEnvironmentExtra PORT=8788 CONVERT_IDLE_TIMEOUT_MS=600000 CONVERT_USE_SWIFTSHADER=1 T3_MODE=auto T3CONV_EXE=D:\chenhaiqiang\tianzheng\t3-conv\t3conv.exe PLAYWRIGHT_CHROME_PATH=C:\PROGRA~1\Google\Chrome\Application\chrome.exe
"%NSSM%" set AcexConvert8788 Start SERVICE_AUTO_START
"%NSSM%" start AcexConvert8788
```

验证：

```bat
sc query AcexConvert8787
sc query AcexConvert8788
"%NSSM%" get AcexConvert8787 Application
"%NSSM%" get AcexConvert8788 Application
```

期望：`STATE` 为 `RUNNING`；`Application` 为 `...\node.exe`（不是 `cmd.exe`）；两端口 `/api/health` 可打开。

常用：

```bat
set NSSM=D:\chenhaiqiang\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe
"%NSSM%" restart AcexConvert8787
"%NSSM%" stop AcexConvert8788
"%NSSM%" status AcexConvert8787
```

> 若天正转换在服务账号下失败，把服务「登录」改成本机有天正/AutoCAD 授权的用户。

### 已装错过时的重配（RUNNING 但 health 不通）

```bat
"%NSSM%" stop AcexConvert8787
"%NSSM%" set AcexConvert8787 Application "%NODE%"
"%NSSM%" set AcexConvert8787 AppDirectory "D:\chenhaiqiang\fuwu_8787端口"
"%NSSM%" set AcexConvert8787 AppParameters index.mjs
"%NSSM%" set AcexConvert8787 AppEnvironmentExtra PORT=8787 CONVERT_IDLE_TIMEOUT_MS=600000 CONVERT_USE_SWIFTSHADER=1 T3_MODE=auto T3CONV_EXE=D:\chenhaiqiang\tianzheng\t3-conv\t3conv.exe PLAYWRIGHT_CHROME_PATH=C:\PROGRA~1\Google\Chrome\Application\chrome.exe
"%NSSM%" start AcexConvert8787

"%NSSM%" stop AcexConvert8788
"%NSSM%" set AcexConvert8788 Application "%NODE%"
"%NSSM%" set AcexConvert8788 AppDirectory "D:\chenhaiqiang\fuwu_8788测试端口"
"%NSSM%" set AcexConvert8788 AppParameters index.mjs
"%NSSM%" set AcexConvert8788 AppEnvironmentExtra PORT=8788 CONVERT_IDLE_TIMEOUT_MS=600000 CONVERT_USE_SWIFTSHADER=1 T3_MODE=auto T3CONV_EXE=D:\chenhaiqiang\tianzheng\t3-conv\t3conv.exe PLAYWRIGHT_CHROME_PATH=C:\PROGRA~1\Google\Chrome\Application\chrome.exe
"%NSSM%" start AcexConvert8788
```

必要时先结束占用端口的残留进程：`netstat -ano | findstr :8787` / `:8788`。

### 备选：任务计划（不装 NSSM）

管理员 PowerShell，两个任务各绑一份 bat（bat 内 PORT 已改好）：

```powershell
$settings = New-ScheduledTaskSettingsSet -AllowStartIfOnBatteries -DontStopIfGoingOnBatteries -RestartCount 3 -RestartInterval (New-TimeSpan -Minutes 1)
$principal = New-ScheduledTaskPrincipal -UserId "SYSTEM" -RunLevel Highest

Register-ScheduledTask -TaskName "AcexConvert8787" -Action (New-ScheduledTaskAction -Execute "D:\chenhaiqiang\fuwu_8787端口\start-fuwu.bat") -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -Principal $principal

Register-ScheduledTask -TaskName "AcexConvert8788" -Action (New-ScheduledTaskAction -Execute "D:\chenhaiqiang\fuwu_8788测试端口\start-fuwu.bat") -Trigger (New-ScheduledTaskTrigger -AtStartup) -Settings $settings -Principal $principal
```

## 4. 防火墙

```bat
netsh advfirewall firewall add rule name="AcexConvert 8787" dir=in action=allow protocol=TCP localport=8787
netsh advfirewall firewall add rule name="AcexConvert 8788" dir=in action=allow protocol=TCP localport=8788
```

## 5. 验收清单

1. 重启服务器后 `sc query AcexConvert8787` / `8788` 为 `RUNNING`，且 **不是**仅服务绿、health 不通。
2. `nssm get ... Application` 为 `node.exe`；两端口 `/api/health` 均 `ok`、`fonts: true`。
3. 各转一张普通 DWG、一张天正 DWG，查对应目录 `.cad-work\out\<jobId>\convert.log`。

更多环境变量与天正排障见 [../README.md](../README.md)、[tianzheng-t3.md](./tianzheng-t3.md)。

## 6. 与本地的差异

除路径外，主要差在**双实例**；NSSM 做法已与本地对齐（`node.exe` + `index.mjs`）。

| 项 | 本地 | 服务器 |
| --- | --- | --- |
| 文档 / 手工 bat | `windows-deploy.local.md` / `start-fuwu.local.bat` | `windows-deploy.md` / `start-fuwu.bat` |
| 实例数 | 单实例 | **双实例**（8787 + 8788，两套目录） |
| 服务名 | `AcexConvertLocal` | `AcexConvert8787` / `AcexConvert8788` |
| 默认手工端口 | 8788 | bat 默认 8788，8787 目录需改一行 |
| 环境变量含义 | 相同 | 相同 |
| NSSM 用法 | `node.exe` + `index.mjs` + `AppEnvironmentExtra` | **相同** |
| 防火墙 | 一般本机不用 | 需放行 8787 / 8788 |
| OS | Win11 | Server 2022（NSSM 同用 2.24-101） |

路径对照：

| 项 | 本地 | 服务器 |
| --- | --- | --- |
| fuwu 目录 | `D:\work\炽橙科技\...\fuwu` | `D:\chenhaiqiang\fuwu_8787端口`、`...\fuwu_8788测试端口` |
| T3CONV_EXE | `D:\work\tianzheng\t3-conv\t3conv.exe` | `D:\chenhaiqiang\tianzheng\t3-conv\t3conv.exe` |
| NSSM | `D:\install\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe` | `D:\chenhaiqiang\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe` |
| node（文档默认） | `D:\install\node\node.exe` | `C:\Program Files\nodejs\node.exe`（以服务器 `where node` 为准） |
| Chrome | 两边相同（手工 bat 长路径；NSSM 用 `C:\PROGRA~1\...`） | 同左 |
