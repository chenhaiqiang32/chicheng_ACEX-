# 天正 DWG → T3 预处理说明

面向运维与开发：如何在 `fuwu` 转换服务中启用天正图纸检测，并在命中时调用 [t3-conv](https://github.com/housyty/t3-conv) 转为 T3 DWG，再交给现有 ACEX 无头导出。

背景依据：[Supporting Tianzheng DWG Drawings](https://github.com/mlightcad/cad-viewer/wiki/Supporting-Tianzheng-DWG-Drawings)。

---

## 1. 为什么需要这一步

天正建筑（TArch）的墙、门窗、柱、标注等是**私有自定义实体**，不是 AutoCAD 标准图元。通用 DWG 解析器（含 CAD-Viewer / ACEX CLI）只能画标准实体，天正对象会被跳过或只剩代理图形。

行业做法：

```text
含天正实体的 DWG
  → 本机天正运行时（t3-conv / TBatSave）
  → T3 DWG（墙→线/多段线，门窗→块，标注→普通尺寸/文字）
  → 标准 DWG 解析 / ACEX 导出
```

`t3-conv` **不做检测**，给它任何 DWG 都会重存一遍。因此 `fuwu` 在调用前先做签名检测：**不是天正图则跳过转换，是天正图才执行 `t3conv.exe`**。

---

## 2. 端到端流程

```text
POST /api/models/import
  → downloading     下载到 .cad-work/out/<jobId>/input.dwg
  → preprocessing   检测签名；命中则 t3conv → input_t3.dwg
  → converting      runHeadless（输入为原图或 input_t3.dwg）
  → ready / failed
```

| 阶段 | 对外 `status` | 说明 |
| --- | --- | --- |
| pending / downloading / preprocessing / converting | `null` | 进行中 |
| ready | `ready` | 可下载 zip |
| failed | `failed` | 见 `errorMessage`（含 T3 失败） |

`.dxf` 不走 T3（工具只支持 DWG）。

CLI 批量 `npm run convert` 使用同一套 `maybeConvertTianzhengToT3`。

---

## 3. 部署前提（转换机）

仅 **Windows x64** 可跑 T3。Linux 上 `fuwu` 可照常转普通图；若检测到天正图会报错（除非 `T3_MODE=off`）。

### 3.1 必须安装的软件

| 软件 | 版本要求 | 说明 |
| --- | --- | --- |
| 天正建筑 TArch | **T20 V9** | 需合法授权；`TGStart.exe` + `SYS` |
| AutoCAD | **2020 或 2021**（优先 2020） | 需 `Fonts` 目录；对应天正 `sys23x64` / `sys24x64` |
| Node.js | **20+** | 跑 `fuwu` |
| Chrome / Edge | 系统浏览器 | ACEX 无头导出用 |

> T30 + AutoCAD 2025 **不符合**当前 t3-conv 生产路径，勿混用。

### 3.2 安装 t3-conv（便携包）

1. 从 [housyty/t3-conv](https://github.com/housyty/t3-conv) 下载 `release/t3-conv.zip`。
2. 解压到**纯英文路径**（重要：中文路径会导致 `Illegal byte sequence`）：

```text
D:\work\tianzheng\t3-conv\
  t3conv.exe
  t3conv.ini
  run-t3conv.ps1
  fonts\
  runtime\
```

3. 编辑 `t3conv.ini`（路径按本机实际安装修改）：

```ini
[paths]
tangent_root=D:\install\tianzhengT3\ruanjiananzhuang\tianzheng
autocad_root=D:\install\tianzhengT3\ruanjiananzhuang\cad2020\AutoCAD 2020
```

也可设环境变量 `T3CONV_TANGENT_ROOT` / `T3CONV_AUTOCAD_ROOT`（与 ini 二选一即可，ini 优先于自动探测）。

4. 本机验收（**管理员** PowerShell）。这一步只验证 `t3-conv` 本身，不启动 `fuwu`。两步都通过后，才进入第 4 节配置服务。

样图使用已确认含天正实体的图纸，例如 `D:\work\tianzheng\Drawing2.dwg`。源图、输出图、工具目录都必须是**纯英文绝对路径**。开始前关掉本机已打开的 AutoCAD / 天正窗口。

#### 4.1 计划检查（`--dry-run`，不启动 CAD）

```powershell
cd D:\work\tianzheng\t3-conv
.\t3conv.exe --dry-run -s "D:\work\tianzheng\Drawing2.dwg"
```

命令返回后，控制台应打出一整段 `key=value` 启动计划，且**没有** `argument_error` / `error=`。至少核对下表（路径按本机安装改，含义不能变）：

| 字段 | 通过标准 |
| --- | --- |
| `source` | 等于传入的样图绝对路径 |
| `target` | 默认为同目录 `Drawing2_t3.dwg`（此步只是计划，文件还不会生成） |
| `tarch_root` | 指向天正 T20 V9 根目录，且该目录下有 `TGStart.exe` 和 `SYS` |
| `autocad_root` | 指向 AutoCAD 2020 或 2021，且该目录下有 `acad.exe` |
| `tangent_sys_dir` | AutoCAD 2020 应为 `...\sys23x64`；AutoCAD 2021 应为 `...\sys24x64` |
| `autocad_fonts_dir` | 指向对应 AutoCAD 的 `Fonts` 目录，且目录存在 |
| `command` | 指向天正根目录下的 `TGStart.exe` |
| `timeout_seconds` | 默认 `600`（1～900 均可） |
| `host_strategy` | `tgstart-reuse-or-launch` |

本步通过的标志：

- 进程已结束，提示符回到 `PS ...>`
- 输出里同时出现上面的 `tarch_root`、`autocad_root`、`tangent_sys_dir`、`autocad_fonts_dir`
- **没有**弹出 UAC，也没有启动 `acad.exe`（`--dry-run` 只打印计划）

任一情况都算失败，先修配置再做真转：

| 控制台现象 | 含义 | 处理 |
| --- | --- | --- |
| `AutoCAD is not installed or not found` | 自动探测没找到 CAD | 在 `t3conv.ini` 写 `autocad_root`，或设置 `T3CONV_AUTOCAD_ROOT` |
| 找不到天正 / `TGStart.exe` | `tangent_root` 不对 | 写 `tangent_root`，目录内必须有 `TGStart.exe` 与 `SYS` |
| `Illegal byte sequence` | 工具或样图路径含中文 | 整包挪到英文目录，样图也拷到英文路径 |
| 弹出 UAC 或长时间无输出 | 当前窗口不是管理员，或路径写错后卡在提升权限 | 用「以管理员身份运行」重新打开 PowerShell；`--dry-run` 本身不应要求提升权限 |

#### 4.2 真转一张样图

`--dry-run` 通过后再执行。必须用包装脚本，不要直接敲 `.\t3conv.exe`：它是 Windows 子系统程序，PowerShell 会马上回到提示符，此时转换还在后台，`$LASTEXITCODE` 和日志都不可信。

```powershell
cd D:\work\tianzheng\t3-conv
.\run-t3conv.ps1 -s "D:\work\tianzheng\Drawing2.dwg" -o "D:\work\tianzheng\Drawing2_t3.dwg"
echo $LASTEXITCODE
```

第一张图会冷启动天正宿主，常见几十秒到数分钟；窗口回到提示符后才算结束。不要手动结束刚出现的 `acad.exe`。

真转必须同时满足下面三条，缺一条都不算部署通过：

1. **退出码为 0**

   ```powershell
   echo $LASTEXITCODE
   ```

   输出 `0`。非 0 直接看 4.3。

2. **产出文件存在且非空**

   ```powershell
   $out = Get-Item "D:\work\tianzheng\Drawing2_t3.dwg"
   $out | Select-Object FullName, Length, LastWriteTime
   ```

   `Length` 必须大于 0。可与源图对比（大小不必相等，但不应是几十字节的空壳）：

   ```powershell
   Get-Item "D:\work\tianzheng\Drawing2.dwg","D:\work\tianzheng\Drawing2_t3.dwg" |
     Select-Object Name, Length, LastWriteTime
   ```

3. **日志状态为成功**

   ```powershell
   Get-Content "D:\work\tianzheng\t3-conv\t3conv.log" -Tail 30
   ```

   最后一条记录应同时包含：

   | 字段 | 通过标准 |
   | --- | --- |
   | `name` | 源文件名，如 `Drawing2.dwg` |
   | `source` | 与 `-s` 一致的绝对路径 |
   | `output` | 与 `-o` 一致的绝对路径 |
   | `status` | `success` |
   | `duration` | 有耗时（冷启动常见数秒到数分钟） |
   | `source_mb` / `output_mb` | 均大于 0 |
   | `timeout_seconds` | 与配置一致，默认 `600` |

   成功示例（数值因机器而异）：

   ```text
   name=Drawing2.dwg
   source=D:\work\tianzheng\Drawing2.dwg
   output=D:\work\tianzheng\Drawing2_t3.dwg
   status=success
   started_at=2026-10-15 10:42:55
   duration=8.051s
   source_mb=0.04
   output_mb=0.05
   timeout_seconds=600
   ```

   日志里出现 `status=failure`、`error=`、`timeout=true` 时，即使磁盘上有旧的 `*_t3.dwg`，也按失败处理。

可选：同一窗口立刻再转一次同一张图。第二次应明显更快（宿主已热），`$LASTEXITCODE` 仍为 `0`。这用来确认服务连续调用时能复用 `acad.exe`。第二次结束后任务管理器里可以留下一个 `acad.exe`，这是预期行为，不要杀掉。

#### 4.3 失败时看哪里

真转失败时，除 `t3conv.log` 外，输出图所在目录旁通常还有：

```text
D:\work\tianzheng\failure\Drawing2.dwg
D:\work\tianzheng\failure_log\Drawing2\report.txt
```

先看 `report.txt` 里的 `exit_code`、`error`、完整 stdout/stderr。常见原因：

| 现象 | 处理 |
| --- | --- |
| `$LASTEXITCODE` 为空，提示符瞬间回来 | 用了裸 `t3conv.exe`。改跑 `.\run-t3conv.ps1` |
| `Illegal byte sequence` | 工具目录、`-s`、`-o` 改成纯英文路径后重试 |
| host / ownership / unowned | 关掉交互式 AutoCAD 后重试；不要去结束工具自己留下的宿主，除非确认它已卡死 |
| `timeout=true` | 图纸过大或宿主卡死；先确认没有弹窗，再单独重试这一张 |
| 退出码 0 但没有 `Drawing2_t3.dwg` | 不算成功。核对 `-o` 是否写到了别的盘符 |

部署门禁：4.1 计划字段齐全，且 4.2 的退出码、文件大小、`status=success` 三条同时成立。未通过不要启动 `fuwu` 的天正预处理。

### 3.3 运维约定

- 跑 `fuwu` / `t3conv` 的账户需**已提升管理员权限**（否则会弹 UAC，服务无人值守会卡住）。
- 转换机不要开交互式 AutoCAD；工具对「证明不了是自己起的」宿主会 fail-closed。
- 成功后 `acad.exe` 会留着复用，不要当垃圾进程杀掉。
- `t3-conv` 为 AGPL-3.0：以独立 exe 调用即可，不要把源码并进本仓库。

### 3.4 拷到服务器后要改的地方

`scripts/detect-tianzheng.mjs` 没有安装路径，拷贝后不用改。未设置 `T3CONV_EXE` 时，`lib/t3Convert.mjs` 的 `resolveT3convExe()` 按写死列表找 `t3conv.exe`。服务器目录不在该列表里时，会报 `t3conv.exe not found`。

本机实际目录：

| 项 | 服务器路径 |
| --- | --- |
| t3-conv 便携包 | `D:\chenhaiqiang\tianzheng\t3-conv` |
| 天正 TArch | `D:\chenhaiqiang\tianzheng\anzhuang\tianzheng` |
| AutoCAD 2020 | `D:\chenhaiqiang\tianzheng\anzhuang\cad2020\AutoCAD 2020` |

部署时改下面三处。文档前文里的 `D:\work\tianzheng\...`、`D:\install\tianzhengT3\...` 是开发机示例。

**1. `lib/t3Convert.mjs` 里写死的 exe 路径**

文件：服务器上的 `fuwu\lib\t3Convert.mjs`，函数 `resolveT3convExe()`。把 `candidates` 改成先写服务器上的 `t3conv.exe`（开发机路径可保留，本机没有该文件时会自动跳过）：

```js
const candidates = [
  'D:\\chenhaiqiang\\tianzheng\\t3-conv\\t3conv.exe',
  'D:\\work\\tianzheng\\t3-conv\\t3conv.exe',
  'D:\\work\\t3-conv\\t3conv.exe',
  path.join(process.cwd(), 't3-conv', 't3conv.exe'),
  path.join(process.cwd(), '..', 't3-conv', 't3conv.exe')
]
```

路径分隔符在 JS 字符串里写成 `\\`。改完后重启 Node，再转天正图。若已设置 `T3CONV_EXE`，环境变量优先，这段列表不会被用到。

**2. `t3conv.ini`（在 t3-conv 目录里，不在 `fuwu` 仓库）**

文件：`D:\chenhaiqiang\tianzheng\t3-conv\t3conv.ini`

```ini
[paths]
tangent_root=D:\chenhaiqiang\tianzheng\anzhuang\tianzheng
autocad_root=D:\chenhaiqiang\tianzheng\anzhuang\cad2020\AutoCAD 2020
```

`tangent_root` 下要有 `TGStart.exe` 和 `SYS`；`autocad_root` 下要有 `acad.exe` 和 `Fonts`。路径都已是纯英文，符合工具要求。`AutoCAD 2020` 目录名中间有空格，写进 ini 时不要加引号。

若 ini 已写对，不必再设 `T3CONV_TANGENT_ROOT` / `T3CONV_AUTOCAD_ROOT`。需要用环境变量覆盖时：

```bat
set T3CONV_TANGENT_ROOT=D:\chenhaiqiang\tianzheng\anzhuang\tianzheng
set T3CONV_AUTOCAD_ROOT=D:\chenhaiqiang\tianzheng\anzhuang\cad2020\AutoCAD 2020
```

**3. 启动 `fuwu` 时的 `T3CONV_EXE`（可选）**

第 1 处已写上服务器 exe 时，可以不设这个变量。需要覆盖写死路径时再设。`fuwu` 的安装目录按服务器实际位置填写（下面用 `D:\path\to\fuwu` 表示）：

```bat
cd /d D:\path\to\fuwu
set T3_MODE=auto
set T3CONV_EXE=D:\chenhaiqiang\tianzheng\t3-conv\t3conv.exe
set T3CONV_TIMEOUT_SECONDS=600
npm run server
```

验收命令同样换成服务器路径（样图换成服务器上已确认含天正实体的 DWG，且路径为纯英文）：

```powershell
cd D:\chenhaiqiang\tianzheng\t3-conv
.\t3conv.exe --dry-run -s "D:\chenhaiqiang\tianzheng\Drawing2.dwg"

.\run-t3conv.ps1 -s "D:\chenhaiqiang\tianzheng\Drawing2.dwg" -o "D:\chenhaiqiang\tianzheng\Drawing2_t3.dwg"
echo $LASTEXITCODE
```

`--dry-run` 输出里 `tarch_root` 应为 `D:\chenhaiqiang\tianzheng\anzhuang\tianzheng`，`autocad_root` 应为 `D:\chenhaiqiang\tianzheng\anzhuang\cad2020\AutoCAD 2020`。`GET /api/health` 的 `t3.exe` 应为 `D:\chenhaiqiang\tianzheng\t3-conv\t3conv.exe`，且 `t3.exeExists` / `t3.ready` 为 `true`。

---

## 4. 配置 `fuwu` 环境变量

| 变量 | 默认 | 含义 |
| --- | --- | --- |
| `T3_MODE` | `auto` | `auto` 检测到才转；`always` 所有 DWG 都转；`off` 关闭 |
| `T3CONV_EXE` | 见下方探测 | `t3conv.exe` **绝对路径**（强烈建议显式设置） |
| `T3CONV_TIMEOUT_SECONDS` | `600` | 单图超时 1～900 秒 |
| `T3CONV_TANGENT_ROOT` | （可选） | 传给子进程 |
| `T3CONV_AUTOCAD_ROOT` | （可选） | 传给子进程 |

未设 `T3CONV_EXE` 时，代码会依次尝试（见 `lib/t3Convert.mjs` 的 `candidates`，命中第一个存在的文件）：

- `D:\chenhaiqiang\tianzheng\t3-conv\t3conv.exe`（服务器）
- `D:\work\tianzheng\t3-conv\t3conv.exe`（开发机）
- `D:\work\t3-conv\t3conv.exe`
- `./t3-conv/t3conv.exe`（相对当前工作目录）
- `../t3-conv/t3conv.exe`

服务器上的 exe 不在这个列表里时，按 [3.4](#34-拷到服务器后要改的地方) 改 `candidates` 的第一条，或设置 `T3CONV_EXE`。改的是服务器上已拷贝的 `lib/t3Convert.mjs`，改完重启服务。

### Windows 启动示例

开发机示例。服务器启动命令见 3.4。

```bat
cd /d D:\path\to\fuwu
set T3_MODE=auto
set T3CONV_EXE=D:\work\tianzheng\t3-conv\t3conv.exe
set T3CONV_TIMEOUT_SECONDS=600
npm run server
```

健康检查：

```http
GET /api/health
```

响应中增加 `t3` 字段，例如：

```json
{
  "ok": true,
  "script": true,
  "fonts": true,
  "fontsMode": "local",
  "cadData": "/cad-data/",
  "t3": {
    "mode": "auto",
    "exe": "D:\\work\\tianzheng\\t3-conv\\t3conv.exe",
    "exeExists": true,
    "timeoutSeconds": 600,
    "platform": "win32",
    "ready": true
  }
}
```

注意：`ok` 仍只表示 ACEX 脚本 + 字体就绪；天正能力看 `t3.ready` / `t3.exeExists`。

---

## 5. 检测流程（如何判断是天正图）

### 5.1 原理

按 Wiki 建议：在文件字节中查找**天正代理实体类名 / 应用签名**（启发式，不启 CAD）。

实现：`lib/t3Convert.mjs` → `detectTianzhengDwg()`。

对每个签名同时扫：

- **ASCII** 字节序列  
- **UTF-16LE** 字节序列（T20 新图常见，如样图 `Drawing2.dwg` 中的 `TCH_`）

### 5.2 签名表

| 签名 | 含义 |
| --- | --- |
| `TCH_` | 天正类名前缀（最常见） |
| `TArch` | 天正建筑相关 |
| `TDb` / `TDbWall` / `TDbDoor` / `TDbWindow` / `TDbColumn` | 天正数据库实体类 |
| `Tangent` / `TANGENT` | 天正应用签名 |

**故意不单独使用** `AcDbProxyEntity`：其它厂商也有代理实体，误报高。

### 5.3 判定逻辑（`T3_MODE=auto`）

```text
读入 DWG 字节
  → 任一签名 ASCII 或 UTF-16LE 出现次数 > 0
       → isTianzheng = true → 调用 t3conv.exe
  → 全部为 0
       → 跳过 T3，原文件直接 ACEX
```

局限：

- **漏检**：类名落在压缩段、或签名不在表内 → 行为与关闭 T3 相同（天正图元可能缺失）。可临时 `T3_MODE=always`。  
- **误检**：偶然字节撞上短串 → 多跑一次 T3（通常可接受）。  

### 5.4 本地只测检测（不转）

```bash
cd fuwu
node scripts/detect-tianzheng.mjs "D:\work\tianzheng\Drawing2.dwg"
```

期望输出含 `YES` 与命中的签名（例如 `TCH_(a=0,u16=1)`）。

---

## 6. 代码结构说明

| 文件 | 职责 |
| --- | --- |
| `lib/t3Convert.mjs` | 签名表、检测、单飞队列、`spawn t3conv.exe`、`maybeConvertTianzhengToT3` |
| `index.mjs` | 下载后、`runHeadless` 前调用预处理；`/api/health` 暴露 `t3` |
| `scripts/convert.mjs` | CLI 批量同样走预处理 |
| `scripts/detect-tianzheng.mjs` | 仅检测，便于标定白名单 |

### 6.1 `maybeConvertTianzhengToT3(inputPath, workDir)`

返回：

```js
{
  inputPath,    // 送给 ACEX 的路径（原图或 input_t3.dwg）
  converted,    // 是否真的跑了 t3-conv
  skipped,      // 是否跳过
  reason,       // not_dwg | t3_mode_off | no_tianzheng_signature | tianzheng_signature | t3_mode_always
  detect,       // { isTianzheng, matches } 或 null
  durationMs    // 转换耗时；跳过时为 null
}
```

任务目录还会写：

- `t3-detect.json` — 检测快照  
- `t3conv.log` — 工具日志（仅实际转换时）  
- `input_t3.dwg` — T3 结果  

### 6.2 调用方式要点

- 用 Node `child_process.spawn` **直接**调 `t3conv.exe`（会等进程句柄）。  
- **不要**经 PowerShell 裸调用（Windows 子系统程序会立刻返回）。  
- 全局 **串行队列**（同时 1 个）：利于复用已热好的天正宿主。  
- T3 失败 → 整单 `failed`，**不会**拿原 DWG 继续 ACEX（避免「成功但缺墙门窗」）。  
- `fileId` 仍是**原始下载字节**的 MD5，与是否 T3 无关。

### 6.3 插入点（`index.mjs`）

```text
writeFile(input.dwg)
  → job.phase = preprocessing
  → maybeConvertTianzhengToT3(...)
  → job.phase = converting
  → runHeadless({ inputPath: t3.inputPath, ... })
```

---

## 7. 用样图验收

样图（天正）：`D:\work\tianzheng\Drawing2.dwg`

```powershell
cd fuwu

# 1) 只检测
node scripts\detect-tianzheng.mjs "D:\work\tianzheng\Drawing2.dwg"

# 2) 配置后 CLI 整链（检测 → T3 → ACEX）
set T3_MODE=auto
set T3CONV_EXE=D:\work\tianzheng\t3-conv\t3conv.exe
npm run convert -- "D:\work\tianzheng\Drawing2.dwg" .\out-t3-test
```

负样本：任意 AutoCAD 自带 Sample `.dwg`，检测应为 `no`，日志 `reason=no_tianzheng_signature`。

---

## 8. 排障

| 现象 | 处理 |
| --- | --- |
| `t3conv.exe not found` | 设置 `T3CONV_EXE` 为英文路径下的 exe |
| `Illegal byte sequence` | 把 t3-conv 整包挪到英文目录（如 `D:\work\tianzheng\t3-conv`） |
| 一直卡住 / UAC | 用管理员身份启动 Node 服务 |
| `AutoCAD is not installed` | 在 `t3conv.ini` 写 `autocad_root` |
| 检测为 no 但看图缺墙门窗 | 扩充签名或临时 `T3_MODE=always`，用 `detect-tianzheng.mjs` 对照 |
| 转换后 AutoCAD 命令行消失 | 运行 t3-conv 包内 `restore-autocad-settings.cmd` |

---

## 9. 参考链接

- [Supporting Tianzheng DWG Drawings](https://github.com/mlightcad/cad-viewer/wiki/Supporting-Tianzheng-DWG-Drawings)  
- [t3-conv](https://github.com/housyty/t3-conv)  
- 本服务 API：[convert-api.md](./convert-api.md)  
