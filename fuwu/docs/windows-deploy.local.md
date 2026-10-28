# Windows 本地验证（单端口 8788）

面向开发机本地跑通转换 + 天正 T3。服务器双实例部署见 [windows-deploy.md](./windows-deploy.md)。

## 目录与路径

| 项 | 值 |
| --- | --- |
| 服务目录 | `D:\work\炽橙科技\图纸精灵\图纸精灵缓存acex\acex试用\fuwu` |
| 端口 | **8788** |
| `T3CONV_EXE` | `D:\work\tianzheng\t3-conv\t3conv.exe` |
| `PLAYWRIGHT_CHROME_PATH` | `C:\Program Files\Google\Chrome\Application\chrome.exe` |

启动脚本：仓库根下 `fuwu/start-fuwu.local.bat`（勿与服务器用的 `start-fuwu.bat` 混用）。

## 1. 一次性准备

需要：Node.js 20+、系统 Chrome；天正则另装 T20 V9 / AutoCAD / t3-conv（见 [tianzheng-t3.md](./tianzheng-t3.md)）。

```bat
cd /d "D:\work\炽橙科技\图纸精灵\图纸精灵缓存acex\acex试用\fuwu"
npm install
npm run install:browser
```

确认存在：

```text
D:\work\tianzheng\t3-conv\t3conv.exe
C:\Program Files\Google\Chrome\Application\chrome.exe
fuwu\cad-data\fonts\fonts.json
```

## 2. 启动

**不要双击本 `.md` 文档**（不会启动服务，窗口会闪一下就没了）。请启动 bat：

- 资源管理器进入 `fuwu` 目录，双击 **`start-fuwu.local.bat`**
- 或 CMD：

```bat
cd /d "D:\work\炽橙科技\图纸精灵\图纸精灵缓存acex\acex试用\fuwu"
start-fuwu.local.bat
```

启动成功时，**黑色窗口会一直开着**，并打印类似：

```text
ACEX convert server
  Local:   http://localhost:8788
```

若窗口一闪就关：再双击 bat，看停住后的报错（脚本已加 `pause`）。常见原因：

| 现象 | 处理 |
| --- | --- |
| 报 `SE_SWIFTSHADER` / `此时不应有 else` / 乱码命令 | 旧版 bat 含中文 UTF-8，CMD 按 GBK 解析会炸行。请用仓库里**无中文**的最新 `start-fuwu.local.bat` |
| 找不到 `node.exe` | 安装 Node 20+，或把 `D:\install\node` 加到**系统** PATH；也可改 bat 里的回退路径 |
| 端口被占用 | `netstat -ano \| findstr :8788` 结束占用进程，或改 `PORT` |
| 没有 `index.mjs` | 确认是在 `fuwu` 目录下的 bat，不是拷错位置 |

> `.bat` 请保持 **ASCII 英文注释**。不要在 bat 里写中文（易被记事本存成 UTF-8，CMD 再次乱解析）。说明文字写在本 md 即可。

健康检查：http://127.0.0.1:8788/api/health  

期望：`ok: true`、`fonts: true`；`t3` 表示天正是否就绪。服务窗口关掉后 health 会打不开。

临时关天正：启动前 `set T3_MODE=off`。

## 3. 本地验收

1. `GET /api/health` 正常。
2. 转一张普通 DWG / DXF → `ready` 可下载 zip。
3. 转一张天正 DWG → 日志出现 preprocessing / t3，最终 `ready`。
4. 任务目录：`fuwu\.cad-work\out\<jobId>\convert.log`。

API 对接见 [convert-api.md](./convert-api.md)。

## 4. 本机开机自启（NSSM 小白步骤）

NSSM（不是 MSSM）把程序注册成 Windows 服务，开机自动跑、不依赖你双击的黑窗口。  
手工验证用 `start-fuwu.local.bat`；NSSM 直接跑 `node.exe` + `index.mjs`（见下），不要把 bat 设成服务入口。

### 准备工作

1. **先关掉**正在双击运行的 `start-fuwu.local.bat` 窗口（否则 8788 被占用，服务会起不来）。
2. 下载 NSSM：**[2.24-101 pre-release](https://nssm.cc/download)**（Win10 / Server 2022 不要用 2014 的旧稳定版 2.24）。
3. 本机 NSSM 已就绪：`D:\install\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe`。
4. 在开始菜单搜 **cmd** → 右键 **以管理员身份运行**。

### 一步步安装（复制粘贴）

下面路径已按本机写好。**推荐直接跑 `node.exe`**（比 `cmd /c bat` 更稳，避免 `PAUSED` / 端口残留）。

若提示「服务已存在」，先执行「修复 / 重配」一节，不要重复 `install`。  
**重要**：必须把 `Application` 改成 `node.exe`。若仍是 `cmd.exe` 而参数却是 `index.mjs`，服务会显示 `RUNNING`，但 **8788 无监听**（`ERR_CONNECTION_REFUSED`）。

```bat
set NSSM=D:\install\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe
set FUWU=D:\work\炽橙科技\图纸精灵\图纸精灵缓存acex\acex试用\fuwu
set NODE=D:\install\node\node.exe

mkdir "%FUWU%\logs"

"%NSSM%" install AcexConvertLocal "%NODE%"
"%NSSM%" set AcexConvertLocal AppDirectory "%FUWU%"
"%NSSM%" set AcexConvertLocal AppParameters index.mjs
"%NSSM%" set AcexConvertLocal AppStdout "%FUWU%\logs\stdout.log"
"%NSSM%" set AcexConvertLocal AppStderr "%FUWU%\logs\stderr.log"
"%NSSM%" set AcexConvertLocal AppRotateFiles 1
"%NSSM%" set AcexConvertLocal AppExit Default Restart
"%NSSM%" set AcexConvertLocal AppEnvironmentExtra PORT=8788 CONVERT_IDLE_TIMEOUT_MS=600000 CONVERT_USE_SWIFTSHADER=1 T3_MODE=auto T3CONV_EXE=D:\work\tianzheng\t3-conv\t3conv.exe PLAYWRIGHT_CHROME_PATH=C:\PROGRA~1\Google\Chrome\Application\chrome.exe
"%NSSM%" set AcexConvertLocal Start SERVICE_AUTO_START
"%NSSM%" start AcexConvertLocal
```

`PLAYWRIGHT_CHROME_PATH` 用 `C:\PROGRA~1\...`（短路径），避免空格把 NSSM 环境变量截断。

含义简述：

| 命令 | 作用 |
| --- | --- |
| `install ... node.exe` | 服务进程就是 Node |
| `AppParameters index.mjs` | 在 `AppDirectory` 下执行入口 |
| `AppEnvironmentExtra ...` | 端口 / T3 / Chrome 等环境变量 |
| `Start SERVICE_AUTO_START` | **开机自动启动** |
| `start AcexConvertLocal` | 立刻启动一次 |

### 修复 / 重配（你截图里的 PAUSED 情况）

截图含义：

1. `install` 报「服务已存在」→ 以前装过，可忽略，继续 `set` 即可。  
2. `sc query` 显示 **`STATE: 7 PAUSED`** → NSSM 认为进程反复退出，进入节流暂停（常见于 `cmd /c bat` + 8788 被旧 `node` 占用）。  
3. 此时 health 有时仍能打开 → 多半是残留的 `node.exe` 还占着 8788，但服务状态不健康，**开机自启不可靠**。

管理员 CMD 按顺序执行（先关掉手工双击的 bat）：

```bat
set NSSM=D:\install\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe
set FUWU=D:\work\炽橙科技\图纸精灵\图纸精灵缓存acex\acex试用\fuwu
set NODE=D:\install\node\node.exe

"%NSSM%" stop AcexConvertLocal
taskkill /F /IM node.exe /FI "WINDOWTITLE eq *" 2>nul
for /f "tokens=5" %%p in ('netstat -ano ^| findstr :8788 ^| findstr LISTENING') do taskkill /F /PID %%p

"%NSSM%" set AcexConvertLocal Application "%NODE%"
"%NSSM%" set AcexConvertLocal AppDirectory "%FUWU%"
"%NSSM%" set AcexConvertLocal AppParameters index.mjs
"%NSSM%" set AcexConvertLocal AppStdout "%FUWU%\logs\stdout.log"
"%NSSM%" set AcexConvertLocal AppStderr "%FUWU%\logs\stderr.log"
"%NSSM%" set AcexConvertLocal AppRotateFiles 1
"%NSSM%" set AcexConvertLocal AppExit Default Restart
"%NSSM%" set AcexConvertLocal AppEnvironmentExtra PORT=8788 CONVERT_IDLE_TIMEOUT_MS=600000 CONVERT_USE_SWIFTSHADER=1 T3_MODE=auto T3CONV_EXE=D:\work\tianzheng\t3-conv\t3conv.exe PLAYWRIGHT_CHROME_PATH=C:\PROGRA~1\Google\Chrome\Application\chrome.exe
"%NSSM%" set AcexConvertLocal Start SERVICE_AUTO_START
"%NSSM%" start AcexConvertLocal
"%NSSM%" status AcexConvertLocal
sc query AcexConvertLocal
```

期望：`status` 为 `SERVICE_RUNNING`，`sc query` 的 `STATE` 为 **`RUNNING`**（不是 `PAUSED`）。

### 验证是否成功

管理员 CMD：

```bat
sc query AcexConvertLocal
```

看到 `STATE` 为 `RUNNING` 后，浏览器打开：http://127.0.0.1:8788/api/health  

若打不开：看日志 `%FUWU%\logs\stderr.log` / `stdout.log`。

也可打开「服务」窗口（`services.msc`），找 **AcexConvertLocal**，应显示「正在运行」，启动类型「自动」。

### 日常常用命令

```bat
set NSSM=D:\install\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe

"%NSSM%" stop AcexConvertLocal
"%NSSM%" start AcexConvertLocal
"%NSSM%" restart AcexConvertLocal
"%NSSM%" status AcexConvertLocal
```

改配置后要重启服务才生效。改端口/T3/Chrome：用 `nssm set ... AppEnvironmentExtra ...` 改环境变量，再 `restart`。

### 卸载（不需要自启时）

```bat
set NSSM=D:\install\nssm\nssm-2.24-101-g897c7ad\win64\nssm.exe
"%NSSM%" stop AcexConvertLocal
"%NSSM%" remove AcexConvertLocal confirm
```

### 注意

- 装服务、启停都要用**管理员** CMD。
- 服务跑着时不要再双击 `start-fuwu.local.bat`（端口冲突）。
- 若天正在服务账号下失败：`services.msc` → AcexConvertLocal → 右键属性 →「登录」改成你的 Windows 用户（有天正/AutoCAD 授权的那个），输入密码确定后重启服务。
