# P0 服务端证据：网易云在线源代理（scripts/netease.mjs + music-server 接入）

- 验证时间：2026-10-30 22:25–22:27（Asia/Shanghai）
- 环境：Windows / Node v24.21.0（`C:\Users\85772\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe`）
- 服务：`scripts/music-server.mjs --port 5176`（仅 127.0.0.1）
- 数据目录：`D:\DSH creat world\rhine-music\music-data-v3`（运行时数据，已在 .gitignore）
- 登录态来源：本机网易云客户端 CEF profile（`source=local-client-cef`，webapp91），cookie 仅在 Node 内存中解密，未落盘/未打印
- 说明：文档中昵称与 uid 已脱敏；接口在 127.0.0.1 上返回真实值供界面使用
- 相关文档：`docs/architecture.md` §5（接入点）、`docs/netease-integration.md`（接口调研）

## 1. 变更文件

| 文件 | 类型 | 说明 |
| --- | --- | --- |
| `app/scripts/netease.mjs` | 新增（28.9 KB） | 单文件 ESM，仅静态 import Node 内置模块；`node:sqlite` 动态 import。导出 `createNeteaseClient({ dataDir })`，含 status / library / openAudio / lyric / cover / refresh |
| `app/scripts/music-server.mjs` | 修改（+约 6 KB） | 创建 netease client（try/catch 包裹）、`/api/netease/*` 六条路由、`/api/library` 合并在线专辑、`/api/audio/netease-song-*` 与 `/api/lyrics/netease-song-*` 透明委托、`streamUpstream()` 流式转发（含 abort 处理） |
| `docs/p0-server-evidence.md` | 新增 | 本文 |

未修改 `src/`、未改 `probes/`、未执行 `build-windows`。两文件语法检查：`node --check scripts/netease.mjs` 与 `node --check scripts/music-server.mjs` 均 exit 0。

## 2. 契约实现对照

| 契约要求 | 实现 | 实测 |
| --- | --- | --- |
| `status() → {enabled, loggedIn, nickname, userId, playlistCount, source, fetchedAt, error?}` | 内存缓存（cookie 10 min / 失败 60 s） | §4.1 |
| `library() → {albums, genres, meta:{playlists, likedTracks, fetchedAt}}`，磁盘缓存 TTL 10 min，失败返回空 + error | `<dataDir>/netease/library.json`；失败降级 | §4.2、§6 |
| `openAudio(songId, rangeHeader) → {status, headers, body}`，带 cookie 取地址，401/过期刷新重试一次 | `/api/song/enhance/player/url?br=320000` + CDN Range 透传 | §4.4、§4.5 |
| `lyric(songId) → {found, text}`，合并 lrc + tlyric | `/api/song/lyric?lv=1&kv=1&tv=1`，同时间戳插入翻译行 | §4.7 |
| `cover(url) → {status, headers, body}`，仅 `*.music.126.net` | host 白名单 + 重定向后二次校验 | §4.6、§4.9 |
| `refresh() → 清缓存并重建` | 清 cookie/账号/歌单/曲库/URL 缓存后强制重建 | §4.8 |
| 映射规则（album/track 全字段） | `netease-playlist-<pid>` / `netease-song-<songId>`；artist=`ar` 以 “/” 连接（兼容旧版 `artists`），duration=`dt/1000`（兼容 `duration`） | §4.2 |
| 数量控制 | 默认 24 歌单（“我喜欢的音乐”优先）、每歌单 1000 首；`RHINE_NETEASE_MAX_PLAYLISTS` / `RHINE_NETEASE_MAX_TRACKS` 覆盖 | §5 |
| 安全 | cookie/带签名 URL 不落日志；LOOPBACK + Origin 校验保留；封面白名单；`response.on('close')` 销毁上游流 | §4.9 |

## 3. 启动

```powershell
# 工作目录 D:\DSH creat world\rhine-music\app
& $node scripts/music-server.mjs --port 5176
```

启动输出（无任何 cookie / 账号信息）：

```
Rhine Local Music  http://127.0.0.1:5176/
音乐索引：D:\DSH creat world\rhine-music\music-data-v3
音乐目录：尚未配置，在界面添加目录
```

## 4. curl 实测（真实状态码）

所有 curl 均在 127.0.0.1:5176 上执行；`$base='http://127.0.0.1:5176'`。

### 4.1 GET /api/netease/status → 200

```powershell
curl.exe -sS -o status.json -w "%{http_code}" "$base/api/netease/status"
```

返回（昵称/uid 已脱敏）：

```json
{"enabled":true,"loggedIn":true,"nickname":"四**钛","userId":"1608****80","playlistCount":65,"source":"local-client-cef","fetchedAt":"2026-10-30T14:26:06.798Z"}
```

- HTTP 200；`loggedIn=true`；`playlistCount=65`（26 自建 + 39 收藏）；`source=local-client-cef`
- 无 cookie 字段返回；首次调用约 1.05 s（DPAPI 解密 + 账号接口），之后内存缓存

### 4.2 GET /api/netease/library → 200

```powershell
curl.exe -sS -o netease-library.json -w "%{http_code} %{time_total}s %{size_download}B" "$base/api/netease/library"
```

实测：`200 0.006977s 393847B`（缓存已热；冷启动构建约 1.0–2.1 s）

摘要：

| 字段 | 值 |
| --- | --- |
| albums | 24（上限 24，第 1 张为“我喜欢的音乐”） |
| genres | `[{id:"netease",name:"网易云音乐"}]` |
| 第 1 张标题 | 四十一钛喜欢的音乐（trackCount 866，payload tracks 865：1 首无版权未返回） |
| meta.playlists / likedTracks | 24 / 866 |
| meta.totalPlaylists | 65 |
| meta.likedAlbumId | `netease-playlist-2433541315` |
| error | 无 |

首张专辑首曲映射样例（真实结构）：

```json
{"id":"netease-song-1857045907","albumId":"netease-playlist-2433541315","title":"Psycho",
 "artist":"Maisie Peters","trackNumber":1,"duration":184.64,"format":"mp3","codec":"mp3",
 "bitrate":320000,"browserPlayable":true,"audioUrl":"/api/netease/audio/1857045907","relativePath":"","offline":false}
```

专辑样例：`id=netease-playlist-2433541315`、`artist="网易云音乐"`、`genreId="netease"`、`rawGenres=["网易云音乐"]`、`folder="网易云音乐/四十一钛喜欢的音乐"`、`coverUrl=/api/netease/cover?url=http%3A%2F%2Fp1.music.126.net%2F...%3Fparam%3D600y600`、`producers=[]`、`offline=false`。

### 4.3 GET /api/library → 200（本地 + 在线合并）

```powershell
curl.exe -sS -o library.json -w "%{http_code} %{time_total}s %{size_download}B" "$base/api/library"
```

实测：`200 0.007459s 394172B`

| 字段 | 值 |
| --- | --- |
| albums | 24（本机未配置本地音乐目录，本地专辑 0 + 网易云 24） |
| neteaseAlbums（id 前缀 `netease-playlist-`） | 24 |
| genres | `netease/网易云音乐/albumCount=24` |
| 第 1 张标题 | 四十一钛喜欢的音乐 |
| 额外字段 `netease` | `{enabled:true,loggedIn:true,playlistCount:65,albums:24,libraryError:null}`（前端可忽略） |
| 原有字段 | `version/roots/scan/onlineEnabled/enrich/introductions` 均保留（本机 roots=[]） |

### 4.4 GET /api/netease/audio/:songId（Range 转发）→ 206

```powershell
curl.exe -sS -D audio.headers -o audio.bin -r 0-1023 -w "%{http_code} %{size_download}B %{content_type}" "$base/api/netease/audio/1857045907"
```

实测：`206 1024B audio/mpeg; charset=UTF-8`

```http
HTTP/1.1 206 Partial Content
Content-Type: audio/mpeg; charset=UTF-8
Cache-Control: private, no-cache
Accept-Ranges: bytes
Content-Length: 1024
Content-Range: bytes 0-1023/7388205
```

不带 Range 的 HEAD 请求（`curl.exe -sS -I`）→ `200 OK`，`Content-Length: 7388205`（200 原样透传；客户端断开时 `response.on('close')` 会销毁上游流）。

### 4.5 GET /api/audio/netease-song-<songId>（透明委托）→ 206

```powershell
curl.exe -sS -D audio-transparent.headers -o audio-transparent.bin -r 2048-4095 "$base/api/audio/netease-song-1857045907"
```

实测：`206 2048B audio/mpeg; charset=UTF-8`

```http
HTTP/1.1 206 Partial Content
Content-Type: audio/mpeg; charset=UTF-8
Accept-Ranges: bytes
Content-Length: 2048
Content-Range: bytes 2048-4095/7388205
```

### 4.6 GET /api/netease/cover?url=... → 200

```powershell
$cover = $base + (Get-Content -Raw netease-library.json | ConvertFrom-Json).albums[0].coverUrl
curl.exe -sS -D cover.headers -o cover.bin -w "%{http_code} %{size_download}B %{content_type}" $cover
```

实测：`200 189331B image/jpg`

```http
HTTP/1.1 200 OK
Content-Type: image/jpg
Cache-Control: private, max-age=3600
Accept-Ranges: bytes
Content-Length: 189331
```

（上游 p1.music.126.net 返回 `image/jpg`，同源代理后可直接用于 `<img crossOrigin>` / CoverAtlas，不再有跨域污染。）

### 4.7 GET /api/netease/lyrics/:songId → 200（lrc + tlyric 合并）

```powershell
curl.exe -sS -o lyrics.json -w "%{http_code} %{size_download}B" "$base/api/netease/lyrics/1857045907"
curl.exe -sS -o lyrics-transparent.json -w "%{http_code}" "$base/api/lyrics/netease-song-1857045907"
```

实测：`200 5946B`；`{found:true, text.length:4591, lines:140}`（原始 lrc 3265 字符 + tlyric 1461 字符）；透明委托路由返回完全一致（200，text 长度 4591）。

合并格式样例（原文行后紧跟同时间戳翻译行，`parseLrc` 按时间+顺序稳定排列）：

```text
[00:00.000] 作曲 : Maisie Peters/Ed Sheeran/Steve Mac
[00:01.000] 制作人 : Steve Mac
[00:06.518]You kept me as your favourite secret
[00:06.518]你把我当作秘密情人
[00:10.593]And I thought we just took it slow
[00:10.593]以为你想慢慢处
```

不存在的歌曲 id：`GET /api/netease/lyrics/999999999999` → 200 `{"found":false,"text":""}`；未知本地 id `GET /api/lyrics/track-000...0` → 200 `{"found":false,"text":""}`（保持原行为）。

### 4.8 POST /api/netease/refresh → 200

```powershell
curl.exe -sS -X POST -o refresh.json -w "%{http_code} %{time_total}s" "$base/api/netease/refresh"
```

实测：`200 1.919100s`；`{ok:true, meta.playlists:24, status.loggedIn:true, error:null}`（清 cookie/账号/歌单/曲库/URL 缓存后强制重建，写入新缓存文件）。

### 4.9 安全与错误路径

| 请求 | 实测 | 说明 |
| --- | --- | --- |
| `GET /api/netease/cover?url=https%3A%2F%2Fevil.example.com%2Fx.jpg` | 400 `{"error":"封面地址不在 *.music.126.net 白名单内"}` | 封面 host 白名单 |
| `GET /api/netease/status` 带 `Origin: https://evil.example.com` | 403 `{"error":"不接受跨站点访问本地曲库"}` | 原有 Origin 校验保留 |
| `GET /api/netease/audio/999999999999` | 502 `{"error":"该歌曲暂无可播放地址（可能受版权、付费或 VIP 限制）"}` | 无地址可见错误，不泄露 URL |
| `GET /api/audio/track-000...0` | 404 `{"error":"索引中没有此文件"}` | 本地音频原逻辑不变 |
| `GET /` / `/api/health` / `/api/config` / `/api/genre-rules` / `/api/playlists` | 200 | 原有本地服务行为不变 |
| 服务端日志 | 仅启动 3 行，无 cookie、无带签名 URL | cookie 只存在于 Node 内存 |

缓存文件自检：`music-data-v3/netease/library.json` 中检索 `MUSIC_U` 为 false（不含任何 cookie 值）。

## 5. 数量控制与缓存

- 默认：最多 24 个歌单（“我喜欢的音乐”强制包含且排第 1），每歌单最多 1000 首。
- 环境变量覆盖实测（`RHINE_NETEASE_MAX_PLAYLISTS=2`、`RHINE_NETEASE_MAX_TRACKS=3`，独立 dataDir）：`albums=2`，第一张 `tracks=3`，第二张 `tracks=2`（不足 3 首不补），`meta.playlists=2`。
- 曲库缓存：`<dataDir>/netease/library.json`，本次 24 专辑 / 1261 首 / 393898 B，TTL 10 分钟；热缓存 `/api/netease/library` 实测 7 ms，`refresh` 重建 1.9 s。
- 播放地址缓存：进程内 Map，TTL 取 `min(5 min, expi)`（接口 expi≈1200 s）；上游 401/403 或无地址时清 cookie/账号缓存后重试一次。

## 6. 降级验证（cookie 读取失败 / 未登录）

两种降级场景均另起临时实例（端口 5177/5178 + 临时 dataDir），不影响主服务：

### 6.1 本机找不到网易云客户端 profile（模拟客户端未安装/未启动）

用空的 `LOCALAPPDATA` 启动：

| 请求 | 实测 |
| --- | --- |
| `GET /api/health` | 200（服务正常启动） |
| `GET /api/netease/status` | 200 `{enabled:false,loggedIn:false,nickname:null,userId:null,playlistCount:null,source:null,error:"未找到网易云客户端配置（请先安装并登录网易云音乐客户端）"}` |
| `GET /api/netease/library` | 200 `albums=0`，`error` 同上 |
| `GET /api/library` | 200，仅返回本地快照（albums=[]，654 B），额外字段 `netease.libraryError` 有值，不崩溃 |
| `GET /api/netease/audio/1857045907` | 502 `{error:"未找到网易云客户端配置（…）"}` |
| `GET /api/netease/lyrics/1857045907` | 200（歌词接口匿名可用，仍能返回） |

### 6.2 有 cookie 但登录态无效（模拟未登录/登录过期）

`NETEASE_COOKIE='MUSIC_U=…（无效值）'` 启动：

| 请求 | 实测 |
| --- | --- |
| `GET /api/netease/status` | 200 `{enabled:true,loggedIn:false,source:"env",error:"网易云登录态无效（请确认客户端已登录，或检查 NETEASE_COOKIE）"}` |
| `GET /api/library` | 200，仅本地快照，`netease.libraryError` 有值 |
| `GET /api/netease/audio/1857045907` | 502（无可用播放地址） |
| `GET /api/netease/lyrics/1857045907` | 200 `{found:true}`（歌词不需要登录） |

失败结果在进程内缓存 60 s，避免每次请求都重试 PowerShell/DPAPI。

## 7. 已知限制 / 遗留问题

1. 登录态依赖 Windows 网易云客户端（`%LOCALAPPDATA%\Netease\CloudMusic\webapp*` 的 CEF Cookies + DPAPI），客户端升级到 v20 app-bound 加密或未登录时会降级；已支持 `NETEASE_COOKIE` / `NETEASE_COOKIE_FILE` 兜底（见 §6）。
2. MVP 只走已验证的明文 `/api/*` + 320k mp3；无损 flac 需 eapi v1（探针 `probes/netease/lib/crypto.mjs` 已验证，本阶段未复制进 `netease.mjs`）。
3. `/api/library` 首次调用会同步构建在线曲库（实测 1.0–2.1 s，24 个歌单详情）；之后内存/磁盘缓存 7 ms。建议 P1 改为后台预构建或先返回本地。
4. 24×1000 上限下本次实际 24 专辑 / 1261 首，`/api/library` ≈ 394 KB；若用户歌单更大，响应会升到 MB 级，前端需注意首屏与封面图集重建成本。
5. 同一首歌出现在多个歌单时 track id 相同（契约规定 `netease-song-<id>`），跨专辑可能重复；若前端按 trackId 建全局索引需去重策略（P1）。
6. 封面 CDN 存在 `Content-Type: image/jpg` 但实际字节为 PNG 的情况，服务端按上游原样透传（浏览器按内容解码）；若前端对 MIME 有校验需 P1 关注。
7. 未接入：搜索、收藏专辑、扫码登录、weapi 加密接口、无损音质（P1/P2）。
8. `/api/netease/refresh` 同步重建约 2 s，前端应加 loading/禁用重复点击。

## 8. 复现步骤

```powershell
cd D:\DSH creat world\rhine-music\app
$node = 'C:\Users\85772\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\node\bin\node.exe'
& $node scripts/music-server.mjs --port 5176    # 后台运行
$base = 'http://127.0.0.1:5176'
curl.exe -sS "$base/api/netease/status"
curl.exe -sS "$base/api/netease/library" | node -e "let s='';process.stdin.on('data',d=>s+=d).on('end',()=>{const j=JSON.parse(s);console.log(j.albums.length,j.meta)})"
curl.exe -sS -D - -o NUL -r 0-1023 "$base/api/netease/audio/1857045907"
curl.exe -sS -D - -o NUL "$base/api/netease/cover?url=<library 首张 coverUrl 的 url 参数值>"
curl.exe -sS "$base/api/netease/lyrics/1857045907"
```

原始 curl 落盘证据（临时目录，未纳入交付物）：`D:\DSH creat world\.tmp\p0\evidence\`（status.json / netease-library.json / library.json / audio.headers / audio.bin / cover.headers / lyrics.json / refresh.json / deg-b-*.json / deg-c-*.json 等）。

## 9. 打包兼容性验证（esbuild bundle，未执行 build-windows）

`build-windows.ps1` 第 138–139 行会把 `scripts/music-server.mjs` 用 esbuild 打成 payload 里的单文件（`--bundle --platform=node --format=esm --target=node22 --external:debug`）。本次按同样命令单独验证（未跑完整 build-windows）：

```powershell
& node_modules\.bin\esbuild.cmd scripts/music-server.mjs --bundle --platform=node --format=esm --target=node22 --external:debug --outfile=<tmp>\music-server.bundle.mjs
```

- esbuild exit 0，产物 2,859,148 B（含 music-metadata 等既有依赖）；`node --check` exit 0；`node:sqlite` 以动态 import 形式保留（未被静态打进）。
- 把 `node_modules/debug`、`node_modules/ms` 放到 bundle 旁（与 payload 结构一致）后启动 bundle，实测：`/api/health` 200；`/api/netease/status` loggedIn=true；`/api/netease/library` 24 张；Range 音频 206（`bytes 0-1023/7388205`）；歌词 found=true len=4591；`/api/library` 合并 24 张。
- 结论：新增 `netease.mjs` 可被 esbuild 正确内联，没有新增裸依赖/原生模块，桌面打包链路无需改 `package.json`（`--external:debug` 是既有行为，payload 一直自带 debug/ms）。

