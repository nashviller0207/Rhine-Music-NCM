# Rhine Music 架构勘察（面向「网易云在线源」改造）

> **勘察对象**：`D:\DSH creat world\rhine-music\app`（只读副本，MIT，Bong712/Rhine-Music-Windows）
> **版本**：0.6.0-dev.57（`version.json`，`src/build-version.ts:2`）
> **方法**：纯静态阅读（read/grep/glob）+ 本机环境核对；**未**执行 npm install / 构建 / 运行（基线由 Lead 负责）。
> **引用约定**：下文 `path:line` 一律相对 `rhine-music/app/`；行号对应当前检出的 0.6.0-dev.57。
> **配套文档**：网易云接口/鉴权细节见 `docs/netease-integration.md`（task-2 产出），本文只讨论"接在哪里、怎么接最省"。

---

## 0. 结论速览（先看这 12 条）

1. **这是一个"本地 HTTP 服务 + 同源单页前端"的应用**：`music-server.mjs` 同时提供 `/api/*` 与打包后的 `dist/` 静态文件，浏览器侧所有请求都是**同源相对路径**（`src/music-app.ts:507-524` 的 `fetch(url)`），没有 dev 代理、没有跨域配置。→ 网易云数据/音频**必须经过这个本地服务**，浏览器直连 music.163.com 会被 CORS 拦。
2. **桌面版 = WinForms 启动器 `DesktopProgram.cs` + WebView2 + 内嵌 payload**：EXE 内嵌 `RhineMusicPayload.zip`（dist + node.exe + 打包后的 music-server + WebView2 DLL），首次运行解压到 `%LOCALAPPDATA%\Rhine Music\app-v<版本>`，数据目录固定为 `%LOCALAPPDATA%\Rhine Music\music-data-v3`（`DesktopProgram.cs:43-53`）。
3. **桌面模式没有 CSP、没有权限处理器、没有自定义协议**（全文 `DesktopProgram.cs` 无 `Content-Security-Policy` / `PermissionRequested`），页面是 `http://127.0.0.1:<port>/?desktop=1`（`DesktopProgram.cs:398`）；`?desktop=1` 在前端源码中**没有被消费**（grep 无命中）。→ 加网易云不需要改 CSP，但也没有浏览器沙箱之外的额外防护可用。
4. **歌曲播放用 `<audio>`（HTMLAudioElement），不是 WebAudio**：`src/music-player.ts:390-480`，`audio.src = "/api/audio/" + id` 写死在 `src/music-player.ts:479`；**`MusicTrack.audioUrl` 字段服务端有返回（`scripts/music-library.mjs:526`）但前端从未使用**（全仓仅类型声明 `src/music-types.ts:18` 一处）。这是接远程音源最小、最关键的改动点。
5. **WebAudio 只负责 UI 音效与氛围 BGM**（`src/audio.ts:304-625`），与歌曲播放完全解耦。若只想播网易云，不需要把远程音频塞进 WebAudio，也就**不需要音频 CORS**；但如果之后要做频谱/律动可视化，才需要 CORS。
6. **封面走 `<img crossOrigin="anonymous">` → Canvas → 纹理**（`src/cover-atlas.ts:444-488`、`src/viewer-album-cover.ts:78-83`），并要求 256px 瓦片的**CPU 读回**（`src/cover-atlas.ts:302-315`）。→ 网易云封面**必须由本地服务代理成同源 URL**，否则 canvas 污染 / decode 失败，专辑架会退回"无封面卡片"。
7. **`decryption.ts` / `document-decryption.ts` 不是加密**：它们是三维卡片"折光解封"动画与详情页"涂黑条揭开"的**纯视觉控制器**（`src/decryption.ts:120-185`、`src/document-decryption.ts:6-121`）。项目**没有**对曲库 JSON/数据库做加密或签名。
8. **数据层是"扫描出来的 JSON 索引"**：`music-data-v3/library-index.json`（原子写、保存内部绝对路径）、`config.json`（根目录、在线资料开关、MusicBrainz 联系方式）、`genre-rules.json`（流派归并规则）、`playlists.json`（歌单，按 rootPath+relativePath 引用）、`artwork/`（内嵌封面缓存）。**播放队列不落盘**，设置存 localStorage。
9. **专辑归并只按"专辑名归一化"**（NFKC+小写，保留标点，`scripts/music-library.mjs:17`、`scripts/music-library.mjs:166-235`）；歌手只是展示分组键（`src/music-order.ts:15`），没有独立 artist 实体；流派通过别名表 + `albumOverrides` 解析（`scripts/music-library.mjs:80-90`）。
10. **已有"服务端代理远端"的先例**：`/api/foobar/*`（`scripts/music-server.mjs:217-229`）与 MusicBrainz/Wikipedia 查询（`scripts/music-library.mjs:622-676`）。网易云代理可以照这个模式扩展，不破坏现有安全模型（loopback + Origin 校验 + 路径白名单）。
11. **推荐路线**：(a) 服务端 `/api/netease/*` 代理（鉴权/加密/CORS/流式音频的唯一可行落点）为**主干**；前端只做"数据源抽象"最小改动（`audioUrl` + `source` 字段 + 歌词分支 + 服务器合并进 `/api/library`）；展示层复用现有专辑架（方案 b），只把"登录/收藏/歌单/搜索"放进现有 `#music-panel-root` 面板体系（方案 c 的轻量版）。详见 §5。
12. **当前机器不能直接跑构建**：`node -v` = **v20.11.0**，而 `vite@7.3.6` 的 engines 是 `^20.19.0 || >=22.12.0`（且其代码使用 Node 20.12+ 才有的 `crypto.hash`），`package.json:34-36` 要求 Node >=22.12，`scripts/launch-music.mjs:13-16` 与 `scripts/build-windows.ps1:28-31` 也会硬性拒绝低版本。**需先装 Node 22.12+/24**。

---

## 1. 启动链路

### 1.1 三种启动方式总览

| 方式 | 入口 | 谁提供页面 | 谁提供 `/api/*` | 数据目录 | 适用场景 |
| --- | --- | --- | --- | --- | --- |
| A. 前端开发模式 | `npm run dev`（`package.json:9`） | Vite dev server（127.0.0.1，默认 5173，占用则 +1） | **没有**（同源 fetch 会 404 → 前端退回演示封面） | 不涉及 | 只改 UI/3D/动画 |
| B. 源码一键启动（浏览器） | `node scripts/launch-music.mjs`（`scripts/launch-music.mjs:240-261`） | 本机 music-server 托管已构建的 `dist/` | 同一个 music-server | `app/../music-data-v3`（可用 `MUSIC_DATA_DIR` 覆盖） | 要真实曲库/歌词/歌单 |
| C. 独立音乐服务 | `npm run music`（`package.json:18`） | music-server 托管 `dist/` | music-server | 同上 | 手工调试 API、打包前验证 |
| D. 桌面 EXE | `Rhine-Music-Desktop-<ver>.exe` → `DesktopProgram.Main`（`DesktopProgram.cs:55-70`） | 内嵌 payload 里的 music-server | 同一个 music-server（子进程 node.exe） | `%LOCALAPPDATA%\Rhine Music\music-data-v3` | 最终交付形态 |

`src/main.ts:1-6` 的前端路由：`?original=1` 走老档案模式 `src/archive-main.ts`，否则走 `src/music-app.ts`。

### 1.2 A：dev 模式（Vite）——关键事实与陷阱

- `npm run dev` 是 `vite --host 127.0.0.1`（`package.json:9`）；`predev` 会先跑 `scripts/export-records.mjs` 校验 `content/archives.json` 并重生成 `public/archives/*.txt`（`package.json:8`、`scripts/export-records.mjs:5-15`）。
- **没有 `vite.config.*`**（全仓 glob 无命中），因此 **dev server 不做 `/api` 代理**。前端 `request()` 用相对 URL（`src/music-app.ts:507-524`），在 dev 下请求会命中 Vite（404 或 HTML 回退），`response.json()` 失败 → `apiAvailable = false`，界面退回 `src/demo-library.ts` 的 3 张演示封面（`src/music-app.ts:525-562` 的 catch 分支、`src/demo-library.ts:2-47`）。
- 也就是说：**dev 模式看不到真实曲库**。要"热更新 + 真数据"，要么加 `vite.config.ts` 的 `server.proxy['/api']`（指向 music-server 的 5175 端口），要么 `npm run build && npm run music` 走构建产物。注意 `scripts/launch-music.mjs:121-138` 的构建指纹已把 `vite.config.*` 纳入哈希（`scripts/launch-music.mjs:123-124`），说明上游预期未来会加这个文件。
- 若加代理还要处理 `scripts/music-server.mjs:125` 的 **Origin 同源校验**：服务端只接受 `Origin === http://<Host头>` 的请求；Vite 代理默认透传浏览器的 `Origin: http://127.0.0.1:5173`，而 Host 会被改写成 5175 → 403。代理需 `changeOrigin: true` 并**去掉/改写 Origin**（或在服务端把 dev 端口加入允许列表，仅开发期）。
- 端口冲突：Vite 默认 5173，而 `npm run music` 的默认端口也是 5173（`scripts/music-server.mjs:246`），两者不要同时用默认端口。launch-music 的端口选择见 `scripts/launch-music.mjs:72-81`（优先 5175–5184，5173 只作为"已被本工程占用"的识别，不用于新起）。

### 1.3 B：`scripts/launch-music.mjs`（源码一键启动，浏览器形态）

流程（`scripts/launch-music.mjs:240-261`）：

1. `projectDir = realpath(app)`，`dataDir = MUSIC_DATA_DIR ?? app/../music-data-v3`（`scripts/launch-music.mjs:241-242`）。
2. 探测 5175–5184（`probeMusicService`，比对 `/api/health` 的 `service/projectDir/pid`，`scripts/launch-music.mjs:56-70`）；已有本工程实例则直接复用开浏览器。
3. 否则取数据目录启动锁 `<dataDir>/launcher.lock`（`scripts/launch-music.mjs:167-194`），复核端口，`prepare()`：
   - 校验 Node >=22.12（`scripts/launch-music.mjs:13-16`、`141`）；
   - 依赖锁一致性检查，必要时 `npm ci`（`scripts/launch-music.mjs:95-119`、`145-148`）；
   - 源码指纹（src/public/content/index.html/package*.json/tsconfig/vite.config/export 相关脚本）与 `dist/.music-build.json` 比对，不一致就 `npm run build`（`scripts/launch-music.mjs:121-165`）。
4. `startServer`：`spawn(process.execPath, scripts/music-server.mjs --port N)`，`detached`，`env.MUSIC_DATA_DIR=dataDir`，stdout/stderr 追加到 `<dataDir>/player-service.log`（`scripts/launch-music.mjs:196-223`）。
5. 打开系统默认浏览器（`scripts/launch-music.mjs:225-238`），终端可关，服务继续后台跑。

> 打包后的桌面版**不经过** `launch-music.mjs`；它由 `DesktopProgram.StartMusicService` 直接拉起 `music-server.mjs`（`DesktopProgram.cs:296-356`）。

### 1.4 C：桌面模式（`DesktopProgram.cs` 全链路）

**启动器主体（`internal static class Program`，`DesktopProgram.cs:26`）**

| 步骤 | 行为 | 代码 |
| --- | --- | --- |
| 0 | 单文件 EXE；程序集元数据版本 0.6.0.57 | `DesktopProgram.cs:18-24` |
| 1 | `Main`：注册 `AssemblyResolve`（从 `AppRoot` 加载 WebView2 DLL）、DPI 感知、异常弹 MessageBox | `DesktopProgram.cs:55-78, 422-433` |
| 2 | 根目录：`PRODUCT_ROOT = %LOCALAPPDATA%\Rhine Music`（可用环境变量 `RHINE_HOME` 覆盖）；`APP_ROOT = <root>\app-v<AppVersion>`；`DATA_ROOT = <root>\music-data-v3` | `DesktopProgram.cs:43-53` |
| 3 | 单实例互斥量 `Local\RhineMusicDesktop-v0.6.0`，拿不到就提示"正在启动" | `DesktopProgram.cs:83-98` |
| 4 | **解压 payload**：检查 `.payload-ready` + `node.exe` + `scripts/music-server.mjs` + `dist/index.html` + 两个 WebView2 DLL；缺任一项就从嵌入资源 `RhineMusicPayload.zip` 全量解压，带 zip-slip 防护，最后写标记文件 | `DesktopProgram.cs:149-205` |
| 5 | `SetDllDirectoryW(APP_ROOT)`（WebView2Loader 查找） | `DesktopProgram.cs:104, 514-516` |
| 6 | **端口探测**：`IsPortFree`（TcpListener 绑定）→ 若被占则 `GET /api/health`（Connect/Read 均 800ms 超时），要求 `service == "rhine-local-music"`、`projectDir == APP_ROOT`、`pid > 0` 才算 `Own`，否则 `Busy` | `DesktopProgram.cs:106-124, 214-294` |
| 7 | 若已有 Own 实例 → 直接开窗口复用；否则取第一个 Free 端口（顺序 **5175→5184，最后 5173**） | `DesktopProgram.cs:106, 113-136` |
| 8 | 起服务：`CreateProcessW(node.exe scripts/music-server.mjs --port N)`，`cwd=APP_ROOT`，`MUSIC_DATA_DIR=DATA_ROOT`，stdout/stderr 重定向到 `<DATA_ROOT>\player-service.log`（用 `CreateFileW` 句柄继承），窗口隐藏 | `DesktopProgram.cs:296-356` |
| 9 | 轮询 health 最多 30s（120×250ms），失败时错误框里附日志尾部 | `DesktopProgram.cs:128-140, 435-446` |
| 10 | `OpenDesktop(port)`：地址 `http://127.0.0.1:<port>/?desktop=1`（`RHINE_PROFILE=1` 时追加 `&profile=1&scene=archive`，可选 `&stress=N`） | `DesktopProgram.cs:390-420` |
| 11 | 窗口关闭时 kill 掉自己拉起的服务 PID（复用他人实例则不 kill） | `DesktopProgram.cs:411-419` |

**窗口与 WebView2（`class DesktopWindow`，`DesktopProgram.cs:530-1079`）**

- 默认 1440×900 最大化、最小 960×640、背景 `#eae5e1`（`DesktopProgram.cs:560-575`）。
- `CoreWebView2Environment.CreateAsync(null, <DATA_ROOT>/webview-profile, options)`：**用户数据目录放在数据目录下**（意味着 localStorage、字体缓存、以及未来若放浏览器侧的 cookie 都跟着数据目录走）（`DesktopProgram.cs:408-409, 586-587`）。
- 设置：`AreDefaultContextMenusEnabled=false`、`AreDevToolsEnabled=false`（`DesktopProgram.cs:588-589`）；仅 profiling 时注入 `AdditionalBrowserArguments`（`DesktopProgram.cs:582-586`）。
- **没有设置 `AreBrowserAcceleratorKeysEnabled`、没有 `PermissionRequested`、没有 `WebResourceRequested` 拦截、没有 CSP**；页面就是普通 loopback HTTP 源。
- 新窗口：同源 → 当前视图导航；`http(s)` 外链 → 系统默认浏览器；其他协议丢弃（`DesktopProgram.cs:645-657`）。→ **OAuth/网页登录跳转会被甩到外部浏览器且无法回跳**，网易云登录必须做在页面内（二维码/密码/短信）或复用本机客户端 cookie。
- F11 无边框全屏（`DesktopProgram.cs:566-572, 1058-1077`），Per-Monitor V2 DPI（`DesktopProgram.cs:59, 422-433`）。
- `RHINE_PROFILE_CAPTURE=1` 时有一套自动化截图/性能抓取（导航截图、封面图集、歌词面板、专辑切换等，`DesktopProgram.cs:669-1026`），依赖页面暴露的 `window.rhineMusic`（`src/music-app.ts:2245-2276`）。这是**我们改造后做回归验证的现成抓手**。

### 1.5 dev vs 桌面：差异对照

| 维度 | dev（A） | 源码启动（B/C） | 桌面（D） |
| --- | --- | --- | --- |
| 页面来源 | Vite 内存/按需编译 `src/` | `dist/`（必须先 build） | payload 内 `dist/` |
| `/api` 是否可用 | ❌（无代理） | ✅ 同源 | ✅ 同源 |
| 端口 | 5173（可漂移） | 5175–5184，浏览器 launcher 会避让 5173 | 5175–5184 → 5173 |
| 数据目录 | 不涉及 | `<repo>/rhine-music/music-data-v3` | `%LOCALAPPDATA%\Rhine Music\music-data-v3` |
| Node 来源 | 系统 Node | 系统 Node | payload 内 `node.exe`（构建机的 Node） |
| 页面 URL 参数 | 自由（`?profile=1&scene=archive&stress=N` 等，见 `src/music-app.ts:608-609, 2223`） | 同左 | 固定加 `?desktop=1`（前端未消费） |
| DevTools | 有 | 有 | **关闭**（`DesktopProgram.cs:589`） |
| 外链 | 浏览器标签打开 | 同左 | 甩给系统浏览器（`DesktopProgram.cs:645-657`） |
| 权限/CSP | 无 | 无 | 无 |

### 1.6 端口 / 环境变量 / 进程清单

**端口**：5173（Vite 默认 & music-server `PORT` 默认，`scripts/music-server.mjs:246`）；5175–5184（launch-music / DesktopProgram 首选，`scripts/launch-music.mjs:72-73`、`DesktopProgram.cs:106`）；5189（mobile review 专用，`scripts/serve-mobile-review.mjs:10`）；5186（README 截图脚本默认，`scripts/capture-readme.mjs:15`）。

**环境变量**（全部只影响"怎么起"，不影响页面契约）：

| 变量 | 作用 | 出处 |
| --- | --- | --- |
| `MUSIC_DATA_DIR` | 数据目录覆盖（服务端、launcher 会传） | `scripts/music-server.mjs:109`、`scripts/launch-music.mjs:242`、`DesktopProgram.cs:337` |
| `MUSIC_ROOTS` | 首次无配置时的默认曲库根（path.delimiter 分隔） | `scripts/music-server.mjs:111` |
| `PORT` | 服务端口 | `scripts/music-server.mjs:246` |
| `RHINE_HOME` | 桌面产品根目录覆盖（测试隔离用） | `DesktopProgram.cs:47-53` |
| `RHINE_PROFILE` / `RHINE_PROFILE_CAPTURE` / `RHINE_PROFILE_*` | 性能/截图 profiling | `DesktopProgram.cs:396-407, 540-560, 707-775` |
| `RHINE_WEBVIEW2_DIAGNOSTIC_ARGUMENTS` | 仅 profile 时透传 Chromium 参数 | `DesktopProgram.cs:583-586` |
| `RHINE_FULLSCREEN` | 启动即全屏 | `DesktopProgram.cs:578` |
| `RHINE_WEBVIEW2_DIR` | 构建时 WebView2 SDK 目录 | `scripts/build-windows.ps1:18` |
| `MUSICBRAINZ_CONTACT` | 在线资料查询的 User-Agent 联系方式 | `scripts/music-library.mjs:238, 260` |

---

## 2. 数据层

### 2.1 `music-data-v3` 目录结构（以代码写入点为准）

```
%LOCALAPPDATA%\Rhine Music\
├─ app-v0.6.0-dev.57\           # payload 解压目录（DesktopProgram.cs:44）
│  ├─ dist\  node.exe  scripts\music-server.mjs
│  ├─ Microsoft.Web.WebView2.Core.dll / ...WinForms.dll / WebView2Loader.dll
│  ├─ LICENSE  NOTICE.md  NODE-LICENSE.txt  WebView2-*
│  └─ .payload-ready            # 版本标记（DesktopProgram.cs:151,204）
└─ music-data-v3\               # DataRoot（DesktopProgram.cs:45）
   ├─ config.json               # 根目录 / 在线资料开关 / MusicBrainz 联系 / foobar 地址（music-library.mjs:246,259,349）
   ├─ library-index.json        # 曲库索引（含内部字段，music-library.mjs:262,306-312）
   ├─ genre-rules.json  (+ .backup)  # 流派规则（music-library.mjs:282,300-301,321）
   ├─ playlists.json            # 歌单（playlists.mjs:57,75）
   ├─ artwork\<sha24>.<jpg|png|webp>  # 内嵌封面缓存（music-library.mjs:503-506）
   ├─ player-service.log        # 服务 stdout/stderr（DesktopProgram.cs:300 / launch-music.mjs:197）
   ├─ launcher.lock             # 启动锁（launch-music.mjs:168）
   └─ webview-profile\          # WebView2 用户数据目录（DesktopProgram.cs:409）
```

补充：

- 封面分两类：**文件夹封面**不复制，直接从音乐目录读（`readAlbum` 里 `fileCover` 存的是原路径，`scripts/music-library.mjs:474-477`）；**内嵌封面**抽出到 `artwork/<hash>`（限 30MB，优先 front，`scripts/music-library.mjs:496-509`）。
- `config.json` 首次以 `{version:1, roots:[], onlineEnabled:false, foobarBaseUrl:null}` 初始化（`scripts/music-library.mjs:246, 302`）。
- 数据目录路径在 **4 处硬编码**：`DesktopProgram.cs:45`、`scripts/music-server.mjs:109`、`scripts/launch-music.mjs:242`、`version.json:6`（`dataSchema` 只进发布清单，`scripts/build-windows.ps1:178`，没有任何运行时校验）。**改造时若不动目录名可以完全不碰这 4 处。**

### 2.2 `library-index.json` 结构

顶层：`{ version:1, albumIdentityVersion:1, albums:[], roots:[{path,status,error?}], scannedAt }`（`scripts/music-library.mjs:247, 455`）。

单张 album（合并后，`combineAlbums` 产出，`scripts/music-library.mjs:217-233`）：

- 对外：`id`（`album-<sha24("title:"+归一化名)>` 或 `single-<sha24(trackId)>`，`scripts/music-library.mjs:151-152, 200`）、`title/artist/year/discCount/folder/folders`、`tracks[]`、`producers[]`、`online{status,releaseId,releaseGroupId,checkedAt,sourceUrl,...}`、`introduction{status,checkedAt,...}`、`description/descriptionSource`、`rawGenres`、`_localGenres/_onlineGenres`、`offline`。
- 内部（落盘也保留）：`_root/_roots`、`_folderPath`、`_cover{path,mime,version,embedded}`、`_coverRoot`、`_sourceEntryId`、`_sourceEntries`、`_enrichmentSafe`。
- 单曲 track（`readAlbum`，`scripts/music-library.mjs:517-541`）：公开字段 + `_path`（**绝对路径**）、`_fingerprint`（size:mtime，用于增量扫描）、`_common`（标签原始信息）、`_embeddedCover`、`_singleFile/_albumFallback/_coverResolved`。
- 注意：**索引里存绝对路径**（`_path`、`_root`），移动/改盘符后需要重新扫描；`snapshot()` 只输出"根目录仍在 config.roots 里"的专辑与曲目（`scripts/music-library.mjs:358-365`），所以换根目录会"隐藏"旧数据但不会删除文件。
- 索引版本不匹配会直接抛错并保留原文件（`scripts/music-library.mjs:263`）；`albumIdentityVersion<1` 时会做一次身份迁移（补 `_roots`/`offline`、重新 `combineAlbums`、迁移流派 override，`scripts/music-library.mjs:264-301`）。

### 2.3 扫描与"专辑/作者/流派归一化"

- 扫描入口：`MusicLibraryStore.scan()`（`scripts/music-library.mjs:387-469`），服务启动后自动跑一次（`scripts/music-server.mjs:240`），也可 `POST /api/library/scan`（`scripts/music-server.mjs:135-141`）。扫描先完整枚举再替换，权限失败只会把根标为 `offline` 并保留旧索引（`scripts/music-library.mjs:405-431`），不会"把歌删了"。
- 目录规则（`walkAlbums`，`scripts/music-library.mjs:121-149`）：**根目录下的音频文件 = 单曲卡片（single）**；**子目录 = 专辑（一个目录一张）**；封面优先 `cover/folder/front.*`；忽略 `.` 开头目录。
- 支持格式：`AUDIO_EXTENSIONS`（flac/wav/m4a/mp4/alac/dsf/dff/mp3/aac/aiff/aif/ogg/opus，`scripts/music-library.mjs:7`）；**浏览器可播**子集 `BROWSER_EXTENSIONS`（去掉 dsf/dff/alac/aiff/aif，`scripts/music-library.mjs:8`），不可播的会在 `MusicPlayer.unsupported` 里给出提示（`src/music-player.ts:559-569`）。
- 专辑归并（`combineAlbums`，`scripts/music-library.mjs:166-235`）：key = `normalizeAlbumName(专辑名)` = trim + NFKC + 小写（**保留标点与内部空格**，`scripts/music-library.mjs:14-17`）；无 album 标签的单曲用 `single:<trackId>` 单独成组；同名专辑跨目录/跨歌手合并成一张，曲目按 disc/track/相对路径排序（`192`）；多歌手合并显示"多位艺人"（`194-196`）；`_enrichmentSafe` 只有在"专辑歌手不超过一个、曲目歌手不超过一个、releaseId 不超过一个"时才允许在线资料合并（`198`）。
- **歌手没有归一化实体**：只在展示层用 `musicArtistKey`（NFKC + 小写 + 去多余空白）做分组列（`src/music-order.ts:10-15`）。
- 流派：`DEFAULT_RULES` 内置 9 类 + 别名（`scripts/music-library.mjs:30-44`）；`resolveGenre` 先查 `albumOverrides`，再按"名称/id/别名"归一化匹配（去空白与标点），匹配不上则生成 `source-<hash>` 动态流派（`scripts/music-library.mjs:80-90`）。规则可热更新：`GET/POST /api/genre-rules`（`scripts/music-server.mjs:142-146`，POST 前会备份 `.backup`，`scripts/music-library.mjs:318-326`）。

### 2.4 封面缓存与传输

- 服务端：`GET /api/artwork/<albumId>?v=<coverVersion>`（`scripts/music-server.mjs:208-214`），`artworkFile` 按索引找封面，内嵌图允许根 = 数据目录，文件夹图允许根 = 音乐目录（`scripts/music-library.mjs:614-620`）；`serveFile` 用 realpath + 前缀校验防穿越，支持 Range/`Last-Modified`（`scripts/music-server.mjs:79-106`）。
- 客户端：`CoverAtlas` 用 `new Image(); image.crossOrigin="anonymous"; image.src=url; await image.decode()`（`src/cover-atlas.ts:444-488`）；解码后缩到 ≤1024 存进 LRU（上限 48，`src/cover-atlas.ts:456-479`）。详情页大图走 `ViewerAlbumCover`，同样 `crossOrigin="anonymous"`（`src/viewer-album-cover.ts:78-83`）。
- **关键约束**：为了把封面画进 canvas 并做 `getImageData` 瓦片上传（`src/cover-atlas.ts:302-315`），图片必须同源或带 CORS 头；否则 decode 失败/画布污染 → 显示"LOCAL COLLECTION / NO COVER"占位卡（`src/cover-atlas.ts:82-111`）。**网易云 CDN 封面必须经本地服务代理**。

### 2.5 歌单（playlists.json）

- 存储：`<dataDir>/playlists.json`，`{version:1, playlists:[{id(uuid), name, createdAt, updatedAt, tracks[]}]}`（`scripts/playlists.mjs:57, 20-52`），上限 100 个歌单 / 每个 20000 曲（`scripts/playlists.mjs:21,24`）。
- 曲目引用**不是** trackId，而是 `{rootPath, relativePath}` 的哈希 `id` + 显示快照（`scripts/playlists.mjs:11, 26-43`）：这样重新扫描/换 trackId 后歌单仍能对上文件；`list()` 时用当前索引解析可用性，不可用标记 `available:false` 并保留原显示信息（`scripts/playlists.mjs:79-104`）。
- **对网易云的影响**：`validate()` 要求 `rootPath` 是**绝对路径**且 `relativePath` 不能越界（`scripts/playlists.mjs:27-30`）。在线曲目**不能**直接塞进这个歌单结构，需要扩展 `PlaylistStore`（加 `source`/`remoteId` 分支）或单独存"网易云歌单缓存"（推荐后者，见 §5）。

### 2.6 播放队列与设置

- **播放队列 = 内存态**：`MusicPlayer.queue`（`src/music-player.ts:120-184`），重启即清空，不落盘。队列面板只是渲染 `playerState.queue`（`src/music-app.ts:1401-1432`）。
- 设置 = `localStorage['rhine-music-preferences']`（主题/排序/画质/音量/动效/音效，`src/music-app.ts:81-122`），WebView2 下存进 `webview-profile` 的 Local Storage（§1.4）。**不在 `music-data-v3` 里。
- "在线资料/介绍"缓存也不单独落盘：直接写在 `library-index.json` 每张专辑的 `online/introduction` 字段（`scripts/music-library.mjs:723-735, 803-809`）。

### 2.7 前端数据模块

| 文件 | 作用 | 关键位置 |
| --- | --- | --- |
| `src/music-types.ts` | **前后端 JSON 契约**（MusicTrack/Album/Genre/Playlist/Library/GenreRules） | `2-137`；`MusicTrack.audioUrl` 在 `18`，`MusicAlbum.coverUrl` 在 `74` |
| `src/data.ts` | **视图模型适配层**：把 `MusicAlbum` 映射成三维场景消费的 `ArchiveRecord`（`records[]`），并维护"列 → 索引"布局 | `21-26`（导出可变 `records/archiveColumns`）、`29-72 setMusicAlbums`、`74-85` 定位函数 |
| `src/music-order.ts` | 排序（流派/歌手/专辑名，中文 pinyin collator）与歌手分组键 | `5-15`、`18-31` |
| `src/demo-library.ts` | 无曲库时的 3 张演示封面（无曲目） | `2-47` |
| `src/asset-url.ts` | `BASE_URL` 前缀拼接（静态资源/GLB/音频） | `1-2` |

`setMusicAlbums` 是**整个改造的"总开关"**：它把 `MusicAlbum[]` 摊平成 `ArchiveRecord[]`，并按 `sortMode` 生成列（流派 / 歌手 / 每 12 张一组，`src/data.ts:45-71`）。**只要喂进来的 `MusicAlbum` 合法，三维专辑架就能显示"网易云歌单/收藏"**——这是方案 (b) 成立的技术基础。

### 2.8 `decryption.ts` / `document-decryption.ts`：不是加密/签名

- `src/decryption.ts`：还原原片里"档案卡折光解封"的时间曲线（`DECRYPTION_START=34.12`、`DECRYPTION_END=39.56`，`src/decryption.ts:1-4`），用单调三次 Hermite 采样（`15-43`），驱动材质/扫描线；`DecryptionController` 在 `120-185`。**纯视觉。**
- `src/document-decryption.ts`：详情页文字上方盖"涂黑条"再依次揭开（`6-121`），由 `setTab`/`renderDetail` 调用（`src/music-app.ts:909, 956-959`）。**纯视觉。**
- 全仓 **没有** 对曲库/歌单/索引做加解密、签名或完整性校验；只有 `createHash('sha256')` 用于生成 id/版本号（`scripts/music-library.mjs:11`、`scripts/playlists.mjs:11`）。
- 唯一"加密"含量在构建/发布流程：发布清单里记录 SHA-256 与版本同步校验（`scripts/build-windows.ps1:88-100, 170-190`）。

### 2.9 `scripts/` 里导出/检查/构建脚本做了什么

**内容导出/校验（档案模式，与音乐库无关）**

- `scripts/export-records.mjs`：先 `loadContent()` 全量校验 `content/archives.json`，再写 `public/archives/RHINE-LAB-X-00N.txt`（`5-15`）。`predev`/`prebuild` 自动跑（`package.json:8,10`）。
- `scripts/archive-content.mjs`：字段/编号/分类数量校验（必须 5 类 × 8 份 = 40 条，`17-81`）与 TXT 渲染（`94-96`）。
- `scripts/check-content.mjs`、`check-archive.mjs`：内容规则与档案阵列的断言测试（Node `--test`）。

**音乐库/服务集成测试**

- `scripts/check-music-library.mjs`（390 行）：起真实 `createMusicServer` + 临时目录/假音频，覆盖扫描/增量/歌单/歌词/Range/Origin/安全边界（`1-10` 起）。
- `scripts/check-music-launcher.mjs`：launcher 的端口探测/构建指纹/依赖检查/启动锁（mock，`1-10`）；`check-music-player.mjs` 用受控 `Audio` 替身测播放状态机（`1-8`）；`check-lyrics.mjs` 测 LRC 解析与二分定位（`1-4`）。
- `check-music-{scene,camera,model,lighting,motion,presentation}.mjs`：几何/相机/材质/动效的纯 Node 断言（部分用 `typescript` 现场转译 TS 再 import，如 `check-music-presentation.mjs:6-12`）。
- `check-{assembly,internal-optics,shell,decryption,loop,motion,appearance,quality,viewport,responsive,pwa}.mjs`：三维资产/视觉/布局/离线的回归断言；`check-responsive.mjs`、`capture-readme.mjs` 需要 Playwright（可选依赖，不在 `package.json` 里）。
- 汇总命令：`npm run check:music`（`package.json:19`）。**注意它混用了 `--experimental-strip-types`（Node ≥22.6）。**

**构建/发布**

- `scripts/version.mjs`：唯一版本源 `version.json`；`--dry-run`/`--sync`/`--allocate-dev`/`--finalize`（`13-20`）；把版本号同步进 `package.json`/`package-lock.json`/`src/build-version.ts`/`DesktopProgram.cs`（4 个字段）/`app.manifest`/`README.md`/`CHANGELOG.md`（`90-158`）；扫描已有产物避免版本复用（`27-46`）；`--finalize` 要求 `performance-acceptance.json` 通过 PresentMon 60FPS 验收（`171-191`）。
- `scripts/build-windows.ps1`：环境校验（Node≥22.12、WebView2 三件套、csc.exe、esbuild、debug/ms 依赖）→ 版本分配 → 元数据一致性校验 → `npm run build` → 组装 `payload/`（dist/node.exe/WebView2 DLL/node_modules/debug+ms/许可证）→ **esbuild 把 `scripts/music-server.mjs` 打成单文件 `scripts/music-server.mjs`（`--bundle --platform=node --format=esm --target=node22 --external:debug`，`139`）** → zip → `csc /resource:payload.zip,RhineMusicPayload.zip` 编译 `DesktopProgram.cs` → 校验 PE 版本/离线缓存版本 → 原子发布到 `outputs/`（`1-244`）。
- `scripts/build-pwa.mjs`：生成 `dist/sw.js` + `dist/pwa-build.json`（版本 + 文件内容哈希作缓存键，`1-22`）；桌面版会强制注销 service worker（`src/music-app.ts:2194-2197`）。
- `scripts/build-icons.mjs`（需要 `sharp`）、`render-audio.mjs`（用 ffmpeg 合成 BGM 三轨 ogg，`1-8`）、`analyze-reference-audio.mjs`/`extract-typing-audio.mjs`（从本地参考视频量测/提取打字音，`1-6`）——都是**素材生成**脚本，不进运行时。

### 2.10 已有的"服务端访问外网"先例（对网易云很重要）

- MusicBrainz：`musicBrainz()/onlineJson()`（`scripts/music-library.mjs:622-639`），带 `User-Agent`、1.1s 限速、15s 超时、`redirect:'error'`；未配置联系方式直接报错（`/api/library/enrich` 返回 400，`scripts/music-server.mjs:155-161`）。
- Wikipedia（专辑介绍）：`album-introductions.mjs` 用 OpenCC 简繁转换 + 多别名匹配，服务端抓取（`scripts/music-library.mjs:641-676`）。
- foobar2000/Beefweb 反向代理：`/api/foobar/*`（`scripts/music-server.mjs:217-229`），只允许 loopback 上游、5s 超时、路径白名单。
- 结论：**"服务端出站 + 返回同源 JSON"是本项目既有模式**，网易云代理在架构上不新、不改安全模型。

---

## 3. 播放层

### 3.1 两条完全独立的音频通道

| 通道 | 实现 | 用途 | 是否受歌曲播放影响 |
| --- | --- | --- | --- |
| `TerminalAudio` | **WebAudio `AudioContext`**，程序化合成 UI 音效 + 3 轨循环 BGM（`public/audio/{atmosphere,motif,pulse}.ogg`） | 点击/翻页/开机音效、场景氛围 | 仅被"duck"（`src/audio.ts:560-567`），不会暂停 |
| `MusicPlayer` | **HTMLAudioElement（`new Audio()`）** | 曲库歌曲播放 | 是 |

- `TerminalAudio` 需要用户手势解锁（`src/audio.ts:332-347`），按场景调 stem 音量（`src/audio.ts:517-536`），页面隐藏时 `suspend()`（`353-364`）。
- `MusicPlayer` 刻意**不**监听 visibilitychange（注释见 `src/music-player.ts:93`），后台继续播。
- `MusicPlayer` 还持有氛围 BGM 的第二个 `Audio`（`/audio/atmosphere.ogg`，`src/music-player.ts:86-90`），歌曲播放时自动淡出（`reconcileBgm`，`621-661`）。

### 3.2 音源 URL 如何构造

1. 服务端 `readAlbum` 给每首曲目写 `audioUrl: "/api/audio/" + trackId`（`scripts/music-library.mjs:526`），`trackId = "track-" + sha24(绝对路径)`（`512`）。
2. 前端 `MusicPlayer.createSong` **忽略 `audioUrl`**，自行拼 `audio.src = "/api/audio/" + encodeURIComponent(track.id)`（`src/music-player.ts:479`）。
3. 服务端 `GET /api/audio/<track-id>`（正则 `[a-zA-Z0-9-]+`，`scripts/music-server.mjs:208`）→ `trackFile()` 找绝对路径与允许根（`scripts/music-library.mjs:609-612`）→ `serveFile` 流式返回，支持 **Range**（seek 依赖它，`58-106`）、MIME 映射（`9, 112-118`）、`Cache-Control: private, no-cache`。

> **最小接入点**：把 `src/music-player.ts:479` 改成 `audio.src = track.audioUrl ?? "/api/audio/" + id`，并让网易云曲目带一个绝对/同源 `audioUrl`，播放器其余状态机（fade/seek/ended 自动下一首）全部不用动。

### 3.3 能否直接播远程 http(s) 流？CORS/Referer 要求？

- **用 `<audio>` 直接播远程 URL：可行且不需要 CORS**（媒体元素是 opaque 资源）。约束与风险：
  - **不需要 CORS**，但**需要远端不校验 Referer**：本服务对所有响应设 `Referrer-Policy: same-origin`（`scripts/music-server.mjs:120`），所以从页面发往 CDN 的请求**不带 Referer**。网易云 CDN 通常接受无 Referer，但这是外部事实，需要 task-2 实测。
  - **URL 时效**：播放地址带 token、会过期；每次播放前应由服务端现取。
  - **UA/Cookie**：某些地址依赖登录态/客户端 UA，浏览器直连带不上；代理可控。
  - **WebAudio 分析**：现有播放器不用 WebAudio，所以不需要；**若将来要接 `createMediaElementSource`/频谱，则远程 URL 必须带 CORS（`crossOrigin='anonymous'` + 远端 ACAO），否则音频图静音/被污染。**
  - **混合内容**：页面是 `http://127.0.0.1`，`http`/`https` 远端都不触发 mixed-content 拦截。
- **经本地服务代理（推荐）**：`/api/netease/audio/<songId>` → 服务端取流 → 原样转发 Range/Content-Type/Content-Length。这样：同源、可带 cookie/UA、可隐藏真实 URL、可统一错误处理；代价是要实现**流式 Range 转发**（现有 `serveFile` 只处理本地文件，`/api/foobar` 只处理 JSON）。

### 3.4 进度 / 歌词 / 队列如何驱动

- **进度**：`timeupdate` 事件写 `state.currentTime`（`src/music-player.ts:411-415`）；`playbackTime` getter 允许逐帧读 `audio.currentTime` 而不发状态（`100-111`）；`seek` 用 `pendingSeek` + `applySeek`（`306-323, 483-498`）。
- **队列**：state 里 `queue/currentIndex`；`play()` 可整体替换队列（跨专辑点歌）、`enqueue/removeQueuedTrack/moveQueuedTrack` 增删移（`120-184`）；`ended` 自动播下一首（`453-474`）；`previous()` 在 >3s 时先回到开头（`293-304`）。
- **歌词**：进入播放（`player.subscribe`，`src/music-app.ts:1090-1096`）或打开歌词面板（`1440`）时 `GET /api/lyrics/<track-id>`（`src/music-app.ts:1456`）；服务端按"同名 .lrc"查找（stem 归一化 NFKC+小写，限制 1MiB，`scripts/music-server.mjs:18-37`）；前端 `parseLrc` 解析 `[mm:ss.xx]`/`[offset:]`（`src/lyrics.ts:16-49`），`activeLyricIndex` 二分（`52-62`）；播放中用 `requestAnimationFrame` 时钟（`syncLyricClock`，`src/music-app.ts:1589-1603`）驱动底部 dock 与完整歌词面板，点击歌词行 `player.seek(time)`（`1821-1824`）。
- **状态机**：`transport: idle|loading|playing|paused|error`（`src/music-player.ts:3-21`），所有 UI（按钮 aria、行高亮、标题滚动）都订阅 `player.subscribe`（`src/music-app.ts:1090-1113`）。
- **错误**：`unsupported()` 先拒 DSD/非浏览器格式（`src/music-player.ts:559-569`），播放失败映射成中文提示（`571-590`）。**接远程源时要保证 `browserPlayable=true` 且 `format` 是 MP3/FLAC/AAC 之类，否则会被 `unsupported()` 直接拒。**

---

## 4. 渲染层

### 4.1 入口与 DOM 骨架

`index.html` 只有两个空容器（`index.html:21`）：`<main id="viewport"><div id="stage"></div></main>`；`src/music-app.ts:225-272` 一次性 `stage.innerHTML = ...` 生成全部 UI。结构（缩减）：

```
#stage.music-app[data-mode][data-theme][data-layout][data-presentation][data-camera-phase][data-lyrics-visible]
├─ #three-scene            ← Three.js canvas 挂载点
├─ header.music-header
│   ├─ a.music-brand（RHINE LAB / MUSIC ARCHIVE）
│   ├─ nav.music-topnav：音乐库/搜索/歌单/队列/主题切换/设置
│   └─ .minimal-transport：#transport-track、#transport-lyric-status、
│                           #transport-lyrics-open、#play-pause、#stop-playback
├─ aside#music-lyric-dock  ← 底部双行歌词（#music-lyric-current / #music-lyric-next）
├─ #library-status（扫描/服务状态条）
├─ section#music-browse    ← 专辑架浏览态：.album-callout（#selection-title/#selection-artist/
│                            #selection-meta/.open-album）、.music-navigation（#album-ticks、
│                            #genre-name、#selection-number）
├─ section#music-detail[hidden]  ← 详情态：.music-back、.card-caption、#album-detail-content
├─ #music-empty[hidden]    ← 空库引导（选择目录 / 看演示）
├─ .music-bottomline（曲库计数 / rAF 诊断）
├─ #music-panel-root       ← 所有面板（library/search/settings/playlists/queue/lyrics）共用
├─ #music-toast
└─ #music-loading
```

关键 UI 更新点：`updateSelection`（`src/music-app.ts:733-782`）、`renderDetail`（`914-961`）、`trackList`（`962-977`，每行 `.track-row[data-track]` + 加队列/歌单按钮）、`albumAbout`（`978-983`）、标题排版 `setupMusicTitleLayout`（`src/music-title.ts:54-...`，逐字滚动 reels）、导航标尺 `setupMusicRuler`（`src/music-ruler.ts`，或按 `?nav=previous` 退回 `music-ticks.ts`，`src/music-app.ts:276-278`）。

### 4.2 Three.js 场景（`src/scene.ts`）

- **渲染器**：`WebGLRenderer({antialias:false, powerPreference:"high-performance"})`（`scene.ts:180-186`），ACES tone mapping、PCFSoft 阴影（`197-200`）。
- **后处理链**：`RenderPass → SSAOPass → ScaledBokehPass(景深) → SMAAPass(可选) → OutputPass`（`scene.ts:247-267`）。
- **相机**：超长焦 `PerspectiveCamera(34°, 16/9, near 5, far 300)`，实际 `fov` 被压到 6.15°，位置 `(-62.26, 35.98, 43.28)`（`scene.ts:76, 243-246`）。
- **模型**：`GLTFLoader.loadAsync(assetUrl)`，音乐库模式加载 `assets/music-cd.glb?v=<hash>`（`src/scene.ts:271-278`、`src/music-cd-asset.ts:2`）；按 GLB 子网格名做材质覆写（`Frosted_Polymer/Internal_Ceramic/...`，`scene.ts:293-424`），每个可实例化表面生成 `InstancedMesh`（`426-452`）；另有只投影的 `shadowOnlyInstances`（layer 1，`433-452`）。音乐库用 `MUSIC_MODEL` 归一化几何（`src/music-model.ts:6-21`），封面是 `MUSIC_COVER`（2.98×2.98 的正面印刷面）。
- **无限循环专辑架**：单元格池 = `LOOP_COLUMNS × MUSIC_LOOP_ROWS`（音乐模式 `MUSIC_LOOP_ROWS`，`scene.ts:284-292`）；`cells/positions` 由 `archive-loop.ts` 的 `poolCell/visibleCell/selectionCell/fileAtCell` 维护（`src/scene.ts:23-37` 导入），逻辑槽位与显示池分离（`scene.ts:490-491`）。
- **每帧更新**（`update()`，`scene.ts:1204` 起；核心循环 `1791-1867`）：对池内每个 cell 算位移/坡面 → 视锥剔除 → 写 `instanceMatrix` → 若 `musicLibrary` 且有 `covers`，把 `records[fileAtCell(cell)]` 绑到封面的槽位（`1831-1838`）→ `covers.commitMatrices()`（`1862`）。
- **数据来源**：`scene.ts:14` 直接 `import { records, archiveColumns, columnFiles, fileAtCell, fileLocation, musicLibrary, slotStride } from "./data"` —— 即**场景读的是 `data.ts` 的模块级可变视图模型**，`setMusicAlbums()` 改它，`scene.refreshLibrary()` 重排相机/选中（`scene.ts:497-532`）。`isMusicLibraryScene` 在**构造时**取 `musicLibrary` 快照（`scene.ts:70`），所以 `music-app.start()` 是先 `loadLibrary()` 再 `new ArchiveScene()`（`src/music-app.ts:2191-2201`）。
- **详情/开合/镜头**：`MusicPresentation` 状态机（`archive|opening|detail|switch-hiding|switching|hiding|returning|selecting`，`src/music-presentation.ts:10-12`）驱动 UI 与 3D 的同步；`MusicCameraMotion/MusicPlacementMotion` 负责镜头与"抽出 CD 盒"的位移（`src/music-camera.ts:6-...`）；`music-app.ts:2110-2190` 的 `frame()` 是唯一 rAF 循环，负责 `scene.update()`/`presentation.update()`/`documentDecryption.update()` 与 1.5s 一次的诊断文本。
- **主题/灯光**：`archive-lighting.ts` + `music-lighting.ts`（选中专辑的聚光 + 内部散射近似，`src/music-lighting.ts:6-24`）+ `theme-transition.ts`（day/dusk/night 平滑过渡）。

### 4.3 封面纹理图集（`src/cover-atlas.ts`）——改造时最容易被忽略的一层

- 图集**分页**：每页 `pageColumns × pageRows` 个 256px 瓦片（受 `gl.capabilities.maxTextureSize` 限制，`cover-atlas.ts:152-159`），每页一个 `THREE.DataTexture`（RGBA8）+ 一个 `InstancedMesh`（`215-254`）。
- **UV 复用**：几何带 `coverTile` 实例属性（`vec4 = xy 偏移 + zw 缩放`），在 `onBeforeCompile` 里注入 `vMapUv = vMapUv * coverTile.zw + coverTile.xy`（`203-214`）；UV 收半个像素防串色（`317-328`）。
- **上传路径**：`drawImage` 到 256px `tileCanvas` → `getImageData` 读回 → `renderer.copyTextureToTexture(tileSource → page.texture)` 只更新一个瓦片（`334-346`）；`selected`（选中大图）是 1024px `CanvasTexture`，直接 `needsUpdate=true`（`438-442`）。
- **懒加载**：只有**相机可见**的槽位才 `setSlot()` 绘制/上传（`575-597`，不可见直接 return），图片按 URL 去重、共享 in-flight Promise、LRU 48（`444-488`）；选中专辑若已在图集中则直接复用瓦片，不复制纹理（`599-642`）。
- 对网易云的意义：只要 `album.coverUrl` 是**同源可读** URL，其余全部自动工作；封面数量多也不会一次性上传（按可见性 + 选中项）。

### 4.4 3D 详情查看器（旧档案模式 & CD 盒）

`src/model-viewer.ts`（687 行）是基于 `OrbitControls` 的独立查看器（`ModelViewer`，`model-viewer.ts:38`），按 `PARTS` 分层展示透明盖板/折射环/光学核心等（`17-30`），音乐模式下用于选中专辑的 3D 细看与封面贴图（`src/viewer-album-cover.ts`）。它自带一条 `quality-renderer` 管线，与场景独立。

---

## 5. 接入点：新增"网易云在线源"的最小改动方案

### 5.1 目标能力 → 现有接口/数据结构的映射

| 网易云能力 | 现有可复用机制 | 需要新增 |
| --- | --- | --- |
| 登录（扫码/手机/Cookie 复用） | 无（桌面外链会被甩到系统浏览器，见 §1.4） | 服务端登录态 + 二维码/状态接口；cookie 落盘 `<dataDir>/netease/` |
| 我的收藏（喜欢的音乐/收藏专辑） | `MusicAlbum`（单张专辑 = 一张卡） | `/api/netease/favorites`、映射器 |
| 歌单列表 + 详情 | `MusicPlaylist` 结构 / 专辑架 | `/api/netease/playlists`、`/api/netease/playlist/:id` |
| 搜索 | 现有"搜索"面板（`renderSearchPanel`）只搜本地 `albums` | 搜索接口 + 结果混排（或独立面板） |
| 播放地址（level/音质） | `MusicPlayer` 的 `<audio>` + `audioUrl` | 服务端取 URL / 代理流 `/api/netease/audio/:id` |
| 歌词 | `parseLrc` + 现有歌词 UI | 服务端转发歌词文本（`/api/netease/lyrics/:id`，返回 `{found,text}` 与本地同构即可） |
| 封面 | `CoverAtlas` + `<img crossOrigin>` | **必须**服务端代理 `/api/netease/cover/:id`（同源） |
| 歌手/专辑元数据 | `MusicAlbum.artist/title/year` | 直接填 |

### 5.2 三种方案对比

#### 方案 (a)：本地 music-server 增 `/api/netease/*` 代理 + 前端加"数据源抽象"

- **做法**：所有网易云请求（含 weapi/eapi 加密、cookie、二维码登录、取播放地址、取歌词、代理音频流、代理封面）都在 Node 侧完成；前端新增 `src/netease.ts` 客户端 + 在 `applyLibrary` 处把在线专辑合并进现有 `MusicAlbum[]`。
- **要改的文件**：
  - 新增 `scripts/netease.mjs`（服务/加密/cookie/缓存，纯 ESM，可被 esbuild 打进 payload）；
  - `scripts/music-server.mjs`：`import`（`5-6`）+ `createMusicServer` 选项（`108-117`）+ 路由（在 `230` 的 `/api/` 404 之前，参考 `217-229` 的 foobar 段）+ 流式音频转发（复用 `parseRange`，`58-77`）；
  - 新增 `src/netease.ts`（前端 API 客户端 + 类型）；
  - `src/music-types.ts`（`2-21`、`51-88`）：加 `source?: "local"|"netease"`、`remoteId?: string`，`audioUrl?`；
  - `src/music-player.ts:479`：改用 `track.audioUrl ?? ...`；
  - `src/music-app.ts`：`1456` 歌词分支、`596-635` 合并在线专辑、`61/1156-1183/1757-1761` 加"网易云"面板；
  - （可选）`scripts/netease-cache.mjs` 封面/元数据缓存到 `<dataDir>/artwork/` 与 `<dataDir>/netease/`。
- **风险**：weapi/eapi 加密与登录态维护成本（这是最大不确定项，task-2 负责验证）；流式 Range 转发要写对（背压/abort/超时）；cookie 明文落盘需 0600；打包时新依赖必须能被 esbuild bundle（不能有原生模块）。
- **优点**：一次解决 CORS/Referer/加密/URL 时效/登录态；与现有安全模型一致；前端改动小且可增量。

#### 方案 (b)：直接把在线数据映射成"专辑/曲目"喂给现有归档 UI

- **做法**：不新开页面，`/api/library`（或新的同步接口）返回的 `albums` 里混入 `source:"netease"` 的专辑；`setMusicAlbums` 一行不动；3D 专辑架、详情页、播放、歌词 UI 全部复用。
- **要改的文件**：`src/music-app.ts:596-635`（合并来源）、`src/music-types.ts`（source 字段）、`src/music-player.ts:479`（audioUrl）、`src/music-app.ts:1456`（歌词分支）。**服务端**仍需方案 (a) 的代理（否则封面/音频/加密都过不去），所以 (b) 是 (a) 的展示层选择，不是替代品。
- **风险**：在线专辑与本地专辑混排后：① `library.genres` 必须有对应流派项（否则 `genreName` 直接显示 id，`src/music-app.ts:311-313`）；② `applyLibrary` 检测到视觉 key 变化会 `presentation.reset()` + `scene.refreshLibrary()`（重排池位、重建封面图集绑定与相机，`src/music-app.ts:636-677`、`src/scene.ts:497-532`），在线曲库很大时（几百张）首次进入会明显卡；只有「本地模式 ↔ 音乐库模式」切换时才会真正 `dispose` 并重建场景（`src/music-app.ts:645-665`）；③ 离线/在线同一张专辑是否合并去重需要规则；④ 在线曲目不能进本地 `playlists.json`（§2.5），只能进内存队列。
- **优点**：UI 零新页面、改动最小、体验统一（"我的收藏就是这座档案馆"）；缺点：本地/在线语义混淆，且必须做数量控制。

#### 方案 (c)：新开独立页面/面板

- **做法**：`Panel` 联合类型（`src/music-app.ts:61`）+ `openPanel`（`1148-1188`）加 `"netease"` 项，`#music-panel-root` 内渲染登录/收藏/歌单/搜索；播放复用 `MusicPlayer`。
- **要改的文件**：`src/music-app.ts`（`Panel`、`titles`、`openPanel` dispatch、`renderNeteasePanel`、点击路由 `1757-1761`）+ 新增 `src/netease.ts` + 服务端（同 (a)）。
- **风险**：面板体系里没有"长列表 3D/虚拟滚动"基础设施（现有列表都是整段 innerHTML），几百首歌单会卡；视觉上脱离"档案馆"主线；需要新 CSS（`src/music.css` 48KB、面板样式已很重）。
- **优点**：与现有本地曲库完全隔离，不污染 `records`/`libraryIndex`；适合先做登录/搜索/试听 MVP；缺点：长期会变成"两套播放器 UI"。

#### 结论

- **(a) 是地基，必须做**；(b)/(c) 是 UI 承载方式，可并行、可先用 (c) 做"登录+搜索+试听"验证，再把"收藏/歌单"用 (b) 灌进专辑架。
- **推荐：以 (a) 为主干 + (b) 作为收藏/歌单的展示层 + (c) 只做"网易云账户"轻面板（登录态/收藏列表/搜索/试听入口）**。理由：
  1. 现有 `setMusicAlbums`/`ArchiveScene`/`CoverAtlas` 已经把"专辑=一张卡"抽象得很干净，(b) 的边际成本最低；
  2. 面板体系（`openPanel`）天然适合"设置/登录/搜索"这类非线性界面，(c) 只做面板不做第二套播放器；
  3. 所有脏活（加密、cookie、CORS、URL 时效、流式转发）集中在 (a) 的服务端，前端只多一个 `source/audioUrl` 契约；
  4. 失败可控：若网易云接口不可用，`/api/netease/*` 返回错误，本地曲库与现有 UI 完全不受影响（`apiAvailable` 语义可复用）。

### 5.3 推荐实施的改动清单（按文件，可直接当 PR 拆分）

**P0 阶段：服务端可用的网易云数据面（无 UI）**

| 文件 | 改动 | 备注/参考行 |
| --- | --- | --- |
| `scripts/netease.mjs`（新增） | weapi/eapi 加密、cookie 持久化（`<dataDir>/netease/session.json`，0600）、登录密钥/二维码、`favorites/playlists/search/songUrl/lyric/cover` 方法 | 纯 ESM；只用 Node 内置 `crypto`/`https`/`fetch`；**不要**引入原生模块 |
| `scripts/music-server.mjs` | ① import（`5-6`）② `createMusicServer` 加 `netease` 实例（`108-117`）③ 在 `230` 前加 `/api/netease/*` 路由 ④ 流式转发音频（可拆成 `streamUpstream()` 辅助函数） | 复用 `LOOPBACK`/Origin 校验（`123-127`）、`parseRange`（`58-77`）、`json()`（`39-42`） |
| `scripts/netease-cache.mjs`（可选） | 封面下载到 `<dataDir>/artwork/netease-<hash>.jpg`；搜索/歌单元数据 TTL 缓存 JSON | 参考内嵌封面写法 `music-library.mjs:503-506` |
| `package.json` | 如引入加密库/QR 生成库，放 `dependencies`（会被 esbuild 打进 payload） | 若非必要，**优先手写 AES/RSA/二维码**（`crypto` 内置，二维码可服务端生成 PNG 或前端用 CSS/SVG） |

**P1 阶段：播放/歌词/封面打通（仍不新页面）**

| 文件 | 改动 | 参考行 |
| --- | --- | --- |
| `src/music-types.ts` | `MusicTrack` 加 `source?/remoteId?`，`audioUrl` 变可选；`MusicAlbum` 加 `source?/remoteId?`；`MusicLibrary` 加 `onlineAlbums?: MusicAlbum[]` | `2-21, 51-88, 109-137` |
| `src/music-player.ts` | `479` 改为 `const src = track.audioUrl ?? "/api/audio/" + id; audio.src = src`；`unsupported()` 对 `source!=="local"` 跳过 DSD/相对路径判断 | `479, 559-569` |
| `src/music-app.ts` | `loadLyrics` 按 source 选端点（`1456`）；`applyLibrary` 合并 `library.onlineAlbums`（`623`）；`playAlbum` 无需改（`1706-1711`） |  |
| `src/netease.ts`（新增） | 前端 API client：`status/loginQr/pollLogin/favorites/playlists/search/songUrl`；把远端数据转成 `MusicAlbum/MusicTrack` | 只 import 类型，避免把 three 带进新模块 |

**P2 阶段：面板（登录/收藏/搜索/试听）**

| 文件 | 改动 | 参考行 |
| --- | --- | --- |
| `src/music-app.ts` | `Panel` 加 `"netease"`；`titles` 加一项；`openPanel` dispatch；`renderNeteasePanel()`；导航按钮（`226-238` 的 header 里加一个"网易云"图标）；点击路由 `1757-1761` |  |
| `src/music.css` | 面板内新样式（轻量，复用现有 `.panel-*`/`#music-panel-root`） |  |
| `scripts/music-server.mjs` | 面板需要的新端点（扫码状态轮询、搜索、收藏） |  |

**P3 阶段：把收藏/歌单灌进专辑架（方案 b 落地）**

| 文件 | 改动 | 参考行 |
| --- | --- | --- |
| `src/netease.ts` | `playlistToAlbum()/collectedAlbumToAlbum()` 映射：`id="netease-..."`、`genreId='netease'`、`coverUrl=/api/netease/cover/...`、`tracks[].audioUrl=/api/netease/audio/...`、`browserPlayable=true`、`format="MP3"`、`duration=song.dt/1000` |  |
| `src/music-app.ts` | 合并进 `albums`；按需给 `genres` 补 `{id:'netease', name:'网易云'}`；**限制在线专辑数量**（例如只灌 20~50 张收藏），避免 `refreshLibrary`/封面图集重建带来的首屏卡顿 | `623-625, 636-655` |
| `src/data.ts` | 无需改（`setMusicAlbums` 已是通用映射） | `29-72` |

### 5.4 明确不建议的做法

- **不要在浏览器里直接 `fetch('https://music.163.com/...')`**：无 ACAO，必被 CORS 拦；且 weapi 需要 cookie+AES+RSA，暴露在前端等于把加密逻辑送给 DevTools（桌面版 DevTools 虽关，但服务端更干净）。
- **不要把网易云封面 URL 直接塞给 `album.coverUrl`**：`Image.crossOrigin='anonymous'` + `getImageData` 会失败/污染（§2.4、§4.3）。
- **不要复用本地 `playlists.json` 存网易云歌单**：校验要求绝对 `rootPath`（§2.5），改了会破坏现有歌单的兼容性。用独立 `<dataDir>/netease/playlists-cache.json`。
- **不要把在线数据写进 `library-index.json`**：它的身份/迁移逻辑（`albumIdentityVersion`，`scripts/music-library.mjs:264-301`）只服务本地文件；扫描会按"上层目录覆盖"重写它。在线数据用独立缓存，`snapshot()` 时再拼装（或前端合并）。
- **不要打开"外链登录"**：桌面版的 `NewWindowRequested` 会把 http(s) 甩给系统浏览器且无法回跳（§1.4）。

---

## 6. 现存坑（构建/启动/素材/数据）

### 6.1 Node 版本（**当前阻断项**）

- `package.json:34-36`：`"node": ">=22.12.0"`。
- 本机实测 `node -v` = **v20.11.0**，npm 10.2.4；`node_modules` 已存在（含 `vite@7.3.6`、`three@0.183.2`、`esbuild@0.28.2`、`music-metadata@11.15.0`）。
- `vite@7.3.6` 的 `engines` 是 `^20.19.0 || >=22.12.0`，且其 `dist/node/chunks/config.js` 使用 `crypto.hash`（Node 20.12+/21.7+ 才有）→ **Node 20.11 下 `npm run dev`/`npm run build` 无法正常工作**（缺 `crypto.hash`，且 engines 不满足）。
- `node --experimental-strip-types` 需要 Node ≥22.6（`package.json:19` 的 `check:music` 用了）；`scripts/launch-music.mjs:13-16` 也拒绝 20.11。
- 结论：基线/构建前必须把 Node 换成 22.12+（推荐 24 LTS）。**桌面版 payload 里的 `node.exe` 就是构建机的 Node**（`scripts/build-windows.ps1:118`），所以构建机版本也会随发行包带给用户。

### 6.2 WebView2 / 桌面启动

- 目标机需要 **WebView2 Evergreen Runtime**；缺失时 WinForms 会弹"无法启动桌面渲染窗口。请安装 Microsoft Edge WebView2 Runtime"（`DesktopProgram.cs:662-663`）。SDK DLL 已随仓库（`sdk/lib/`：Core/WinForms/Loader + 许可证），但**不是**运行时。
- 首次运行解压到 `app-v<版本>`；若 `.payload-ready` 存在但文件被删，EnsurePayloadExtracted 会因文件检查失败而重新解压（`DesktopProgram.cs:151-160`）。升级版本会生成新 `app-v...` 目录，旧目录不会自动清理。
- 单实例互斥量硬编码为 `Local\RhineMusicDesktop-v0.6.0`（`DesktopProgram.cs:83`），`version.mjs` **不会**随版本改写它（要并行实例需手动改名）。
- 端口被占且 health 不是本工程 → 依次换 5175–5184；全占则报错（`DesktopProgram.cs:106-124`）。
- 健康检查用 `projectDir == AppRoot` 判定"是不是我的服务"（`DesktopProgram.cs:250-251`）。**如果你在开发目录里手工起 `npm run music`（projectDir = `rhine-music/app`），桌面 EXE 会认为它是别人的服务（Busy），另起一个**。调试时这是"明明服务在跑却又起了一个"的常见困惑。

### 6.3 dist / 静态资源 / 素材缺失

- `npm run music` 托管的是 `app/dist`（`scripts/music-server.mjs:110, 232-233`）。**干净检出没有 `dist/`（.gitignore 忽略），不先 `npm run build` 就访问根路径会得到 404 JSON/错误**。
- 三维素材在 `public/assets/`（`music-cd.glb`、`archive-cassette.glb`、`archive-assembly.glb`），缺失时场景加载失败并显示"三维资源未能加载"（`src/music-app.ts:2238-2242`）。
- 字体会阻塞启动：`document.fonts.load("400 20px MiSans")`/`600`（`src/music-app.ts:2205-2209`），依赖 `public/fonts/MiSans-*.woff2`；缺失不会崩，但标题排版测量会退化。
- BGM 三轨 `public/audio/{atmosphere,motif,pulse}.ogg`（`src/audio.ts:29, 442-459`）和 `/audio/atmosphere.ogg`（`src/music-player.ts:86`）缺失只影响氛围声，不阻断歌曲。
- PWA 产物 `dist/sw.js` 只由 `npm run build` 的第三步生成（`package.json:15`）；`scripts/build-windows.ps1:166-169` 会校验 `dist/pwa-build.json` 与版本一致。

### 6.4 "demo 数据加密"是误解

- 没有加密。演示封面是 `public/demo-covers/{square,portrait,landscape}.png` + `src/demo-library.ts:2-47` 的纯前端常量；"演示封面"按钮只在没有曲库时出现（`src/music-app.ts:268, 543`）。`demo` 标志在拿到真实曲库后被置 false（`src/music-app.ts:606`）。
- 真正的"假数据"风险是 **`apiAvailable=false` 静默退回 demo**（§1.2）：联调网易云时如果服务没起，你会以为"数据没接上"，其实是 demo 顶替。

### 6.5 MUSIC_DATA 目录依赖

- 桌面版**不允许**用户改数据目录：写死 `%LOCALAPPDATA%\Rhine Music\music-data-v3`（`DesktopProgram.cs:45`）。测试隔离只能用 `RHINE_HOME`（`DesktopProgram.cs:47-53`）。
- 源码启动/`npm run music` 用的是 `app/../music-data-v3`（`scripts/music-server.mjs:109`），**与桌面版是两套数据**。基线截图/实测时不要混。
- 索引里全是绝对路径（§2.2）：换机器/换盘符/移动音乐目录后，必须重新配置根目录并扫描；旧索引会保留但被过滤。
- 扫描是"启动即跑"（`scripts/music-server.mjs:240`），大曲库会让 `/api/library` 在扫描完成前后返回不同快照；前端轮询在扫描期间 1.4s 一次（`src/music-app.ts:554-560`），扫描完成后还会强制 `location.reload()`（`src/music-app.ts:591-594`）——**做自动化截图/联调时要注意"自动刷新"会打断操作。**

### 6.6 打包/版本/构建脚本的耦合坑

- `build-windows.ps1` 每次都会 `version.mjs --allocate-dev` **递增版本并改写一堆文件**（`180-190`）：`package.json`/`package-lock.json`/`src/build-version.ts`/`DesktopProgram.cs`/`app.manifest`/`README.md`/`CHANGELOG.md`/`version.json`。手动改这些版本字符串会破坏 `metadataChecks`（`88-100`）→ 构建失败。**改动 DesktopProgram.cs 时务必保留 `AssemblyVersion/AssemblyFileVersion/AssemblyInformationalVersion/AppVersion` 四行的正则形态**（`scripts/version.mjs:102-115`）。
- 产物输出到 `<workspace>/outputs`（`build-windows.ps1:10-12`，workspace = `D:\DSH creat world`），且**拒绝覆盖同名版本**（`77-79`）；失败会保留已分配序号（`BUILD-WINDOWS.md:29`）。
- `music-server.mjs` 打包时用 esbuild bundle（`build-windows.ps1:138-142`）：**新增的 `scripts/*.mjs` 必须用静态 `import` 引入**（动态拼接路径的运行时 import 不会被 bundle，payload 里也没有源文件）；只有 `debug` 是 external。`node_modules` 里只带 `debug`/`ms`，**运行时不能依赖其他裸包**。
- 运行时 payload 只有 `scripts/music-server.mjs` 一个 bundle + `dist/` → 任何**新增静态素材**要放 `public/` 让它进 `dist/`。
- `version.json` 的 `dataSchema: "music-data-v3"` 只出现在发布清单（`build-windows.ps1:178`），**没有任何运行时校验**；改目录名需要同步 §2.1 的 4 处硬编码 + README。
- 构建需要本机 **.NET Framework 4.x 的 `csc.exe`**（`build-windows.ps1:39-40`）、WebView2 SDK 三件套（`33-38`）、`esbuild` 与 `debug`/`ms` 依赖（`41-47`）。默认 `RuntimeTemplateDir` 指向 `%LOCALAPPDATA%\Rhine Music\app-v0.5.0-desktop`（`14-16`），不存在就需 `-RuntimeTemplateDir`。
- 首次构建前建议 `node scripts/version.mjs --dry-run` 预览版本（`BUILD-WINDOWS.md:17`）。

### 6.7 其它行为陷阱

- **`musicLibrary` 是模块级全局且"只进不退"**：`setMusicAlbums` 无条件 `musicLibrary = true`（`src/data.ts:30`），即使传空数组；`ArchiveScene` 在构造时固化 `isMusicLibraryScene`（`src/scene.ts:70`）。→ 若做"本地/网易云数据源切换"，不要试图靠切回 `demo/archive` 模式实现，直接在 `records` 层替换数据。
- `?original=1` 仍保留旧档案 UI（`src/main.ts:1-6`），但旧 UI 与音乐库数据不共享，别把它当"网易云接入的现成第二页面"。
- 服务端安全边界（改动时不要绕过）：loopback Host 校验（`music-server.mjs:123`）、Origin 校验（`125`）、路径穿越防护（`13-16, 79-106`）、请求体 128KB 上限（`44-56`）、歌词 1MiB 上限（`11`）、`requestTimeout=30s`（`239`）、所有响应 `X-Content-Type-Options: nosniff` + `Referrer-Policy: same-origin`（`119-120`）。
- 前端每 12s 轮询 `/api/library`（`src/music-app.ts:554-560`），扫描/在线补全期间 1.4s；如果给 `/api/library` 加"顺带刷新网易云"的副作用，会变成每 12s 一次上游请求，需单独做 TTL。
- 桌面 profile 截图链依赖 `window.rhineMusic` 的字段（`library/selectedAlbum/player/presentation/coverDiagnostics`，`src/music-app.ts:2245-2276`）；改数据结构时这些调试接口要同步，否则 `RHINE_PROFILE_CAPTURE` 的自动化断言会挂（`DesktopProgram.cs:695-790`）。

---

## 7. 附录

### 附录 A1：关键文件索引

| 文件 | 行数 | 职责 |
| --- | --- | --- |
| `DesktopProgram.cs` | 1079 | WinForms 启动器 + payload 解压 + 服务拉起 + WebView2 窗口 + 性能截图 |
| `scripts/music-server.mjs` | 257 | 本地 HTTP 服务：API + dist 静态 + Range/安全 |
| `scripts/music-library.mjs` | 825 | 曲库索引、扫描、归并、流派、封面、在线资料 |
| `scripts/playlists.mjs` | 181 | 歌单存取与解析 |
| `scripts/launch-music.mjs` | 265 | 源码一键启动（端口/构建/锁/后台服务） |
| `scripts/build-windows.ps1` | 244 | 单文件 EXE 打包 |
| `scripts/version.mjs` | 224 | 版本唯一源与元数据同步 |
| `src/music-app.ts` | 2276 | 音乐模式总控（DOM/面板/歌词/数据/UI 状态） |
| `src/scene.ts` | 2110 | Three.js 档案/专辑架场景 |
| `src/cover-atlas.ts` | 862 | 封面图集/纹理上传 |
| `src/music-player.ts` | 712 | 歌曲播放状态机（HTMLAudio） |
| `src/audio.ts` | 625 | WebAudio 音效/BGM |
| `src/data.ts` | 85 | 视图模型适配（Album → ArchiveRecord/列） |
| `src/music-types.ts` | 137 | 前后端 JSON 契约 |
| `src/decryption.ts` | 185 | 三维解封动画（非加密） |
| `src/document-decryption.ts` | 121 | 详情页涂黑条揭开动画（非加密） |
| `src/lyrics.ts` | 62 | LRC 解析与定位 |
| `src/music-model.ts` | 129 | CD 盒尺寸/材质/封面印刷材质 |
| `src/model-viewer.ts` | 687 | OrbitControls 3D 细看查看器 |

### 附录 A2：`scripts/` 全量分类

- **内容（档案）**：`archive-content.mjs、export-records.mjs、check-content.mjs、check-archive.mjs`
- **音乐数据/服务**：`music-library.mjs、playlists.mjs、music-server.mjs、album-introductions.mjs、check-music-library.mjs、check-album-introductions.mjs`
- **启动/版本/构建**：`launch-music.mjs、version.mjs、build-lock.ps1、build-windows.ps1、build-native-candidate.ps1、build-pwa.mjs、pwa-worker.js、build-icons.mjs、check-music-launcher.mjs、check-version.mjs、check-pwa.mjs`
- **前端单测/几何断言**：`check-lyrics.mjs、check-music-player.mjs、check-music-presentation.mjs、check-music-scene.mjs、check-music-camera.mjs、check-music-model.mjs、check-music-lighting.mjs、check-music-motion.mjs、check-quality.mjs、check-viewport.mjs、check-loop.mjs、check-motion.mjs、check-appearance.mjs、check-shell.mjs、check-internal-optics.mjs、check-assembly.mjs、check-decryption.mjs`
- **浏览器/截图/性能**：`check-responsive.mjs、capture-readme.mjs、serve-mobile-review.mjs`（需要 Playwright/Chrome/FFmpeg，非默认依赖）
- **音频素材**：`render-audio.mjs、analyze-reference-audio.mjs、extract-typing-audio.mjs、sanitize_blend_browser_metadata.py`

### 附录 A3：前端 API 调用清单（改造时对照）

| 端点 | 调用点 |
| --- | --- |
| `GET /api/library` | `src/music-app.ts:536` |
| `GET/POST /api/config` | `src/music-app.ts:1203, 1905` |
| `GET/POST /api/genre-rules` | `src/music-app.ts:1621, 1921` |
| `POST /api/library/scan` | `src/music-app.ts:1642` |
| `POST /api/library/enrich` | `src/music-app.ts:1659` |
| `POST /api/library/introductions` | `src/music-app.ts:1679` |
| `GET/POST /api/playlists` | `src/music-app.ts:1279, 1314` |
| `POST/PUT/DELETE /api/playlists/:id...` | `src/music-app.ts:1331, 1344, 1356, 1374, 1383` |
| `GET /api/lyrics/:trackId` | `src/music-app.ts:1456` |
| `GET /api/audio/:trackId` | `src/music-player.ts:479` |
| 封面 `<img src>` | `src/music-app.ts:343-345, 1243`；`src/cover-atlas.ts:450-452`；`src/viewer-album-cover.ts:78-83` |

> 本文是静态勘察结论；运行时行为（尤其网易云接口连通性/CORS/音频地址时效）需结合 task-2 的 `docs/netease-integration.md` 与 Lead 的基线实测二次确认。
