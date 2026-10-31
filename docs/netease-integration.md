# 网易云音乐 · 个人账号接入调研（Rhine Music）

> 调研日期：2026-10-30 ｜ 环境：Windows 11、Node v24.21.0、本机网易云客户端 3.1.41.205529（D:\CloudMusic）
> 范围：个人自用（本机单用户）、只读播放；不对外分发、不绕过付费/会员权益。
> 本文所有结论都来自 `probes/netease` 下的实测脚本；证据 JSON 在 `probes/netease/results/`（已脱敏）。

**一句话结论**：MVP 不需要逆向，也不需要自建复杂加密层——用「Web 扫码登录（或复用本机客户端登录态）拿到 cookie」，然后直接调**明文 `https://music.163.com/api/*` 接口**（登录 cookie 带上即可），再用本地 `music-server` 反向代理 CDN 流播放即可。weapi/eapi 只作为备用通道（本仓库已实现并自测通过）。

---

## 0. 推荐路线（TL;DR）

| 优先级 | 鉴权方式 | 结论 | 理由 |
| --- | --- | --- | --- |
| **P0 主路径** | Web 扫码登录（`weapi`/web 的二维码接口，实际是明文端点） | ✅ 端点可达，实测 `unikey` 申请 + `801` 轮询正常 | 官方 Web 登录协议，跨机器可用，不依赖客户端内部结构；失败可回退 |
| **P1 加速路径** | 复用本机网易云客户端登录态（CEF cookie + DPAPI 解密） | ✅ **已实测可完整复用**（账号、歌单、四档播放地址全部打通） | 用户本机已登录时零交互一键导入；依赖客户端 CEF 内部格式，客户端升级可能失效（有兜底即可） |
| **P2 兜底** | 手动粘贴 `MUSIC_U` / 完整 cookie | ✅ 读接口只需 `MUSIC_U` | 开发调试、极端环境兜底；体验差 |

播放链路：后端代理（`music-server`）持有 cookie 并换取 CDN 直链 → 前端 `<audio>` 只请求本地地址 → 本地服务透传 `Range`。**不要**把 CDN 直链直接给前端（CORS、Referer 防盗链、URL 带签名且会过期，且会暴露账号取流行为）。

---

## 1. 已实测结论（证据）

测试时间 2026-10-30 21:56–22:19（Asia/Shanghai），Node v24.21.0，串行低频请求。

### 1.1 匿名通道（不登录）

| # | 用例 | 请求 | 结果 |
| --- | --- | --- | --- |
| A1 | 搜索 | `POST /api/search/get/web`（form：`s=晴天&type=1&offset=0&limit=1`） | HTTP 200 / code 200；`result.songs[0]`，返回 `resultKeys=[songs, songCount]`；耗时 ~330ms |
| A2 | 歌曲详情 v3 | `POST /api/v3/song/detail`（form：`c=[{"id":2652820720}]`） | HTTP 200 / code 200；`songs[0]` 含 `name/al/dt/fee/h/m/l/sq/hr/copyright` 等；`fee=8` |
| A3 | 歌曲详情 legacy | `GET /api/song/detail?ids=[...]` | HTTP 200 / code 200；旧结构 `songs[]` |
| A4 | 歌单详情 | `GET /api/playlist/detail?id=3778678&n=1000&s=0` | HTTP 200 / code 200；**新结构 `{result:{...}, code}`**（旧版为 `playlist`）；热歌榜 `trackCount=200`、`tracks=200` |
| A5 | 播放地址（匿名） | `GET /api/song/enhance/player/url?ids=[id]&br=320000` | HTTP 200 / code 200，`data[0].url` **有值**（该曲 `fee=8` 免费/低音质免费），`br=320000/mp3/level=exhigh` |
| A6 | 歌词 | `GET /api/song/lyric?id=...&lv=-1&kv=-1&tv=-1` | HTTP 200 / code 200；`lrc.lyric` 970 字 |
| A7 | 封面 CDN | `GET <picUrl>?param=300y300` + `Range: bytes=0-1023` | HTTP **206**，`content-range: bytes 0-1023/14141`，`content-type: image/jpg`，`accept-ranges: bytes` |
| A8 | 扫码 unikey | `POST /api/login/qrcode/unikey`（form：`type=1`） | HTTP 200 / code 200；`unikey` 长度 36 |
| A9 | 扫码轮询 | `GET /api/login/qrcode/client/login?key=<unikey>&type=1` | HTTP 200 / code **801**（等待扫码） |

> ⚠️ A5 说明：**部分曲目匿名也能取到地址**（免费/试听曲目）。这只是接口现状，不能作为"绕过付费"的手段；产品上必须始终按当前登录账号权益取地址，取不到就提示不可播放。

### 1.2 加密通道（weapi / eapi，不登录）

| # | 用例 | 请求 | 结果 |
| --- | --- | --- | --- |
| B1 | weapi 账号态（匿名） | `POST /weapi/nuser/account/get`（form：`params&encSecKey`） | HTTP 200 / code 200 → `{code:200, account:null, profile:null}`，说明 weapi 加密实现正确 |
| B2 | weapi 搜索（匿名） | `POST /weapi/search/get`（加密 `{s,type,limit,offset,total}`） | HTTP 200 / code 200，`result.songs` 1 条 |
| B3 | eapi 播放地址（匿名） | `POST https://interface.music.163.com/eapi/song/enhance/player/url/v1` | HTTP 200；**响应体是加密二进制**，AES-128-ECB 解密后 code 200；`data[0].code=200` |

**关于"weapi 404"（重要，已查明）**：首版探测脚本对 `/api/nuser/account/get` 拼接成 `/weapi/api/nuser/account/get`（多了一层 `api`），服务端返回 `code:404`。修正为 `/weapi/nuser/account/get`（**去掉 `/api` 前缀**）后立即 code 200。**结论：404 是路径错误，不是加密错误、也不是风控**；如果将来遇到 `code:-460` 才是加密/签名被拒。

### 1.3 登录态（复用本机客户端 cookie，`cookieSource=local-client-cef`）

| # | 用例 | 结果 |
| --- | --- | --- |
| C0 | 客户端 cookie 提取 | ✅ `%LOCALAPPDATA%\Netease\CloudMusic\webapp91` 下 CEF `Cookies`（SQLite）解出 40 条 `.music.163.com` cookie，含 `MUSIC_U`(994 字符)、`MUSIC_R_U`(162)、`__csrf`(32)、`NMTID`、`deviceId` 等 |
| C1 | 账号信息 | `GET /api/nuser/account/get` + cookie → HTTP 200 / code 200；`loggedIn=true`，`profile.vipType=110`（VIP 账号），account/profile 字段齐全 |
| C2 | 我的歌单 | `GET /api/user/playlist?uid=<uid>&limit=1000&offset=0` + cookie → code 200；共 **65** 个歌单（自建 26、收藏 39）；含 `specialType=5` 的"我喜欢的音乐" |
| C3 | 我喜欢的音乐 | `GET /api/playlist/detail?id=<likedId>&n=1000&s=0` + cookie → code 200；`result.trackCount=865`、`tracks=865`（列表里 `trackCount=866`，差 1 首疑似失效曲目）；**新版 `result` 结构没有 `trackIds`，用 `tracks[]`** |
| C4 | 播放地址四档（明文） | `GET /api/song/enhance/player/url?ids=[id]&br=<档位>` + cookie：见下表，**四档全部取到 url**，VIP 权益生效 |
| C5 | CDN Range | 对 C4 的 320k URL 发 `Range: bytes=0-2047` → HTTP **206**，`content-range: bytes 0-2047/7388205`，`content-type: audio/mpeg` |
| C6 | eapi 播放地址 v1 | `POST interface.music.163.com/eapi/song/enhance/player/url/v1` + cookie（`level=exhigh`）→ 响应加密、解密后 code 200，`data[0].url` 有值、`br=320000`、`level=exhigh` |
| C7 | 歌词 | `GET /api/song/lyric` + cookie → code 200；`lrcLen=3265`，含翻译歌词 |
| C8 | 登录态校验 | `GET /api/nuser/account/get` + cookie → code 200 且 `account≠null` 即有效（比解码 cookie 过期时间可靠，见 2.2.4） |

C4 实测音质档位：

| 请求 `br` | 返回 `level` | 实际码率/格式 | 大小（示例曲） | 结论 |
| --- | --- | --- | --- | --- |
| `128000` | `standard` | mp3 128kbps | 2,955,309 B | ✅ 可取 |
| `192000` | `higher` | mp3 192kbps | 4,432,941 B | ✅ 可取 |
| `320000` | `exhigh` | mp3 320kbps | 7,388,205 B | ✅ 可取（VIP） |
| `999000` | `lossless` | flac（实测 `br=1076765`） | 24,851,739 B | ✅ 可取（VIP） |
| eapi `level=hires` | `hires` | Hi-Res | — | 未实测 |

证据文件：

- `probes/netease/results/anon-20261030-215837.json`（A1–A9）
- `probes/netease/results/weapi-20261030-221924.json`（B1–B3，路径修正后）
- `probes/netease/results/account-20261030-215907.json`（C1–C7）

---

## 2. 鉴权方案对比

### 2.1 方案 A：Web 扫码登录（主路径）

协议（与 NeteaseCloudMusicApi 一致，均为明文端点，无需加密）：

| 步骤 | 请求 | 说明 |
| --- | --- | --- |
| 1. 申请 key | `POST https://music.163.com/api/login/qrcode/unikey`，form `type=1` | 返回 `{code:200, unikey:"..."}`（实测长度 36） |
| 2. 生成二维码 | 把 `https://music.163.com/login?codekey=<unikey>` 编码成二维码图片 | 前端可用任意二维码库渲染；该 URL 是网易云官方 H5 登录页 |
| 3. 轮询 | `GET https://music.163.com/api/login/qrcode/client/login?key=<unikey>&type=1`，每 2s 一次 | `code=800` 过期；`801` 等待扫码；`802` 已扫码待确认；`803` 登录成功 |
| 4. 落地 cookie | `803` 响应的 `Set-Cookie` 中带 `MUSIC_U`、`__csrf`、`NMTID`、`MUSIC_A_T` 等 | 后端用 cookie jar 收下，**不得回传前端、不得打印** |
| 5. 校验 | `GET /api/nuser/account/get` + cookie → `code=200 && account≠null` | 同时可拿 `profile.vipType` 做音质档位上限 |

- 实测可达性：步骤 1、3 已跑通（`801`）；步骤 4 的 `803` 需要人工扫码，本次未做端到端落地（**接入时请先实现并人工验证一次**）。
- 有效期/刷新：`MUSIC_U` 通常长期有效（客户端内的同一 token 当前仍可正常调用）。若失效，最稳妥是**重新扫码**；响应里还有 `MUSIC_R_U`（刷新 token），但刷新接口本次未验证，不建议自研刷新逻辑。
- 安全：二维码 `unikey` 是短期一次性 token（5 分钟量级），不要写日志；扫码成功后的 cookie 等同账号密码。

### 2.2 方案 B：复用本机网易云客户端登录态（已实测可行，推荐做"可选一键导入"）

#### 2.2.1 数据来源

| 路径 | 内容 | 用途 |
| --- | --- | --- |
| `%LOCALAPPDATA%\Netease\CloudMusic\webapp*\Cookies` | 客户端内嵌 CEF（Chromium 91 内核）的 SQLite cookie 库 | ✅ **登录 cookie 来源**；`.music.163.com` 下 40 条可解密 |
| `%LOCALAPPDATA%\Netease\CloudMusic\webapp*\LocalPrefs.json` | `os_crypt.encrypted_key` = base64("DPAPI" + DPAPI(AES-256 key)) | ✅ 解 cookie 的 AES key 来源 |
| `%LOCALAPPDATA%\Netease\CloudMusic\dumps\cookie_json`（3,718 B） | 高熵二进制、非 JSON、无明文 cookie 名 | ❌ 未解析出可用格式，**不建议依赖**（客户端自有加密，逆向成本高） |
| `%LOCALAPPDATA%\Netease\CloudMusic\dumps\appParam` | GPU/版本等 JSON | 无关 |

CEF 目录名可能是 `webapp91` 这种"webapp+数字"，实现时应扫描 `webapp*` 并找含 `Cookies` 的那个。

#### 2.2.2 解密算法（已用 Python/Node 双向验证）

```text
AES key = DPAPI_Unprotect( base64decode(LocalPrefs.json#os_crypt.encrypted_key)[5:] )
          -- 前 5 字节是 ASCII "DPAPI"；DPAPI 作用域 CurrentUser（同一 Windows 用户可解）
cookie  = encrypted_value = "v10" + 12B nonce + ciphertext + 16B tag
          明文 = AES-256-GCM(key, nonce, ciphertext, tag)，AAD 为空
```

- 实测：round-trip 自检通过；`MUSIC_U` 解密后为 994 字符可打印 ASCII；`__csrf` 32 字符。
- 读取 `Cookies` 时客户端可能正在运行：SQLite 只读打开即可（Python `immutable=1`、Node `node:sqlite` `readOnly:true` 实测都成功），**不要**写客户端文件。
- 若未来遇到 `v20` 前缀（App-Bound 加密）则此路不通，需要降级到扫码/手动 cookie。

#### 2.2.3 过期与刷新

- CEF 库里 `expires_utc` 字段换算后会出现"1970 年"等异常值（实测 31 条辅助 cookie 显示已过期），但 **`--verify` 实测账号仍然有效**。结论：**不要用 cookie 过期时间做判断**，一律用 `GET /api/nuser/account/get` 实际校验（cookie 有效 → `code=200` 且 `account≠null`）。
- 失效时：提示用户"打开网易云客户端重新登录后点导入"，或直接用扫码登录。
- 不要自行调用刷新接口；客户端自身会刷新 `MUSIC_U`，我们只读取"当下快照"。

#### 2.2.4 边界与安全

- 只在**用户本机、用户主动点击"导入本机客户端登录态"**时执行；只读、不修改客户端、不抓包。
- 解密后的 cookie 只在后端内存中使用，导入成功后立即用 DPAPI 加密落盘（见 2.5）。
- 该能力依赖客户端内部实现，属于"尽力而为"：客户端大版本升级、切换账号、多开等都可能失效 → **必须有扫码/手填兜底**，失败时不要反复重试。

### 2.3 方案 C：手动粘贴 cookie / MUSIC_U（兜底）

- 读接口**只需要 `MUSIC_U`**（实测把客户端全量 cookie 传过去当然也行；最小集是 `MUSIC_U`，建议同时带 `__csrf` 以便后续写操作）。
- 来源：浏览器开发者工具（music.163.com → Application → Cookies）、或用户从客户端工具复制。
- 输入方式（后端接收，不落明文日志）：`POST /api/netease/session/import` body `{cookie:"MUSIC_U=...; __csrf=..."}`；后端校验 `/api/nuser/account/get` 通过后加密保存。
- 体验最差，只作为开发调试与极端兜底；文档里明确"粘贴的是账号凭据，只在本机使用"。

### 2.4 鉴权方案优先级建议

1. **首次使用**：默认引导扫码（稳定、跨设备、不依赖客户端）。
2. **检测到本机客户端已登录**：额外显示"一键导入本机网易云登录态（可选）"，用户点了才执行提取；成功后与扫码登录等价。
3. **兜底**：高级设置里允许粘贴 `MUSIC_U`。
4. 三种方式最终都归一为同一个后端 `session`（`Cookie` 头 + 校验结果），前端只看到 `loggedIn/vipType/昵称脱敏`。

### 2.5 凭据安全要求（必须实现）

- **落盘加密**：`session.json` 用 Windows DPAPI（CurrentUser）加密；文件放 `%LOCALAPPDATA%\RhineMusic\`（或现有 `music-data-v3` 目录），ACL 限当前用户；不要放项目目录/可同步目录。
- **不打印**：任何日志/错误上报/UI 都不得出现 cookie、token、带签名的播放 URL；日志用 `redactUrl` 同类工具。
- **不进前端**：cookie 只在 Node 后端；浏览器只拿"已登录/未登录 + 脱敏信息"。
- **不进 Git**：`music-data-v3` 与凭据文件加入 `.gitignore`。
- **退出登录**：删除本地 session 文件 + 清内存缓存即可（无需调网易云接口）。

---

## 3. 数据接口清单（推荐直接用明文 `/api/*` + cookie）

### 3.0 三种通道怎么选

| 通道 | Base | 请求形态 | 何时用 |
| --- | --- | --- | --- |
| **明文 `/api/*`**（推荐） | `https://music.163.com` | GET/POST form；返回多数是 `text/plain;charset=UTF-8` 但内容是 JSON | **MVP 全部读接口都用它**：账号、歌单、我喜欢的音乐、歌曲详情、播放地址、歌词、搜索、扫码 |
| weapi | `https://music.163.com/weapi/*` | form `params=<base64>&encSecKey=<hex>`；AES-128-CBC 两层 + RSA-1024 | 明文接口失效时的备用；自定义歌单/写操作等 |
| eapi | `https://interface.music.163.com/eapi/*` | form `params=<hex>`；AES-128-ECB + MD5 校验串；**响应可能是 AES-128-ECB 加密二进制** | 需要 `level=hires` 等新档位、或新接口只走 eapi |

注意：

- 返回 `Content-Type: text/plain` 时按文本取回再 `JSON.parse`（本仓库 `readJsonSafe` 已处理）。
- weapi 路径映射：模块 `/api/nuser/account/get` → 实际 POST `/weapi/nuser/account/get`（去掉 `/api` 前缀，**不要**拼成 `/weapi/api/...`）。
- eapi 路径映射：模块 `/api/song/enhance/player/url/v1` → POST `https://interface.music.163.com/eapi/song/enhance/player/url/v1`；body 是 `params=<hex>`。
- 写操作（收藏/取消/建歌单）需要 cookie 里的 `__csrf` 作为 `csrf_token` 参数；本次未实现、未实测（MVP 不需要）。

### 3.1 端点速查表

| 用途 | 方法 | 路径 | 关键参数 | cookie | 返回要点 |
| --- | --- | --- | --- | --- | --- |
| 匿名 token（可选） | POST | `/api/register/anonimous` | `username=<base64>` | 否 | 部分公开接口的风控校验；本次未使用 |
| 扫码申请 key | POST | `/api/login/qrcode/unikey` | form `type=1` | 否 | `{code:200, unikey}` |
| 扫码轮询 | GET | `/api/login/qrcode/client/login?key=<key>&type=1` | — | 否 | `800/801/802/803`；803 带 `Set-Cookie` |
| 账号信息 | GET | `/api/nuser/account/get` | — | **是** | `{code:200, account:{id, userName(已脱敏), vipType, createTime}, profile:{userId, nickname, vipType, ...}}` |
| 我的歌单 | GET | `/api/user/playlist` | `uid&limit=1000&offset=0` | **是** | `{more, playlist:[{id,name,specialType,trackCount,creator:{userId},subscribed,...}]}` |
| 我喜欢的音乐 | GET | `/api/playlist/detail` | `id=<specialType=5 的 id>&n=1000&s=0` | **是** | **新结构** `{code, result:{trackCount, tracks:[...], hasMore}}`；`trackIds` 可能为空 |
| 歌单详情 | GET | `/api/playlist/detail` | `id&n=1000&s=0` | 公开歌单否；私人/喜欢的要 | 同上；曲目字段 `{id,name,ar:[{name}],al:{name,picUrl},dt,fee,...}` |
| 歌曲详情 | POST | `/api/v3/song/detail` | form `c=[{"id":123},{"id":456}]` | 否（带 cookie 更稳） | `{code, songs:[{id,name,ar,al:{picUrl},dt,fee,h,m,l,sq,hr,copyright}]}` |
| 歌曲详情（旧） | GET | `/api/song/detail?ids=[...]` | — | 否 | `{code, songs, privileges}`（旧结构） |
| 播放地址（推荐） | GET | `/api/song/enhance/player/url` | `ids=[id]&br=128000|192000|320000|999000` | **是** | `{code, data:[{id,url,br,size,md5,type,level,fee,payed,freeTrialInfo,code}]}`；无权益时 `url=null` |
| 播放地址（eapi v1） | POST | `/eapi/song/enhance/player/url/v1`（interface 域名） | 加密 `{ids, level, encodeType, e_r}` | **是** | 加密响应，解密后同上；`level` 支持 `standard/higher/exhigh/lossless/hires/jyeffect/sky/jymaster` |
| 歌词 | GET | `/api/song/lyric` | `id&lv=-1&kv=-1&tv=-1&rv=-1` | 否（带 cookie 更稳） | `{code, lrc:{lyric}, tlyric:{lyric}, romalrc:{lyric}, klyric}` |
| 封面 | GET | 歌曲/歌单字段里的 `picUrl/coverImgUrl`（`p*.music.126.net`） | `?param=300y300` 缩放 | 否 | 图片；支持 `Range`（实测 206） |
| 搜索 | POST | `/api/search/get/web` 或 `/api/search/get` | form `s&type=1&limit&offset` | 否 | `{result:{songs,songCount,...}}` |
| 用户详情（可选） | GET | `/api/v1/user/detail/<uid>` | — | 否 | 公开资料；本次未单独测 |

### 3.2 字段与分页要点

- **我喜欢的音乐**：先 `/api/user/playlist` 找 `specialType===5`；再用 `/api/playlist/detail?id=<likedId>&n=1000&s=0`。实测 866 首时 `tracks` 有 865 条（`trackIds` 为空），相差 1 首疑似已失效曲目，属于正常。
- **超过 1000 首**：明文 `/api/playlist/detail` 一次最多约 1000 条（`n` 参数 + `s` 偏移，或 `hasMore`），超过时按 `s` 翻页；或改用 weapi `/api/v6/playlist/detail`（含全量 `trackIds`，本次未测）。
- **播放地址**：`data[].code=200` 且 `url` 非空才可播；`fee`/`payed`/`freeTrialInfo` 用于 UI 提示"需会员/仅试听/不可播放"。`url` 带 `expi`（Unix 秒）等签名参数，**只在后端缓存**。
- **歌曲详情**：`dt` 毫秒时长；`h/m/l/sq/hr` 是各档位文件大小；`al.picUrl` 是封面。
- **歌单详情新结构**：2026-10 实测返回 `{result, code}`（旧版 `{playlist, code}`），实现时两者都兼容。

---

## 4. 播放链路与本地流式代理

### 4.1 现有播放层事实（只读勘察）

- 前端播放：`app/src/music-player.ts` 直接 `audio.src = '/api/audio/' + track.id`（HTMLAudioElement 流式播放，天然支持 `Range` 拖动）。
- 本地服务：`app/scripts/music-server.mjs` 已有完整 `Range` 解析（`parseRange`）、`206/416`、`Content-Range/Accept-Ranges/Content-Length`、MIME 映射（含 `.flac` 需补）、`/api/audio/:id` 与 `/api/artwork/:id` 路由、`/api/lyrics/:trackId`。
- 因此在线源最小改动是：在 `music-server.mjs` 增加一组 `/api/netease/*` 路由（见 5.1），前端 `music-player.ts` 按 `track.source` 分支到 `/api/netease/stream/<songId>`。

### 4.2 反向代理设计（解决 CORS / Referer / 防盗链 / URL 过期）

```text
GET /api/netease/stream/:songId?level=exhigh
  1) 参数校验 + 登录态检查
  2) 取播放地址：GET /api/song/enhance/player/url?ids=[songId]&br=<level 映射>（带 cookie）
     - 命中缓存（key = songId + level）直接复用；缓存 TTL = min(expi - now - 60s, 10min)
     - url 为空 → 返回 409 + {error:"该曲目当前账号不可播放", fee, freeTrialInfo}
  3) 向上游 CDN 请求：透传 Range，设置 UA/Referer
  4) 原样回写 206/200 状态码与 Content-Type/Content-Length/Content-Range/Accept-Ranges
  5) 流式 pipe；客户端断开时中断上游（AbortController）
```

关键点：

- **Range 必须透传**：实测 CDN 对 `Range: bytes=0-2047` 返回 `206 + Content-Range`；前端拖动进度条、Safari 分段请求都依赖它。不要自己整段下载再切片。
- **请求头**：带上 `User-Agent: UA_CLIENT`（网易云桌面 UA）和 `Referer: https://music.163.com/` 最稳（实测可行；部分 CDN 有防盗链策略，别省略）。
- **响应头清洗**：CDN 的 `Content-Type` 可能带 `; charset=UTF-8`（如 `audio/mpeg; charset=UTF-8`），代理时原样返回即可，浏览器能识别；`.flac` 对应 `audio/flac`，需要在 `MIME` 表补 `.flac: 'audio/flac'`。
- **URL 过期**：地址含 `expi` 与签名参数；按 `expi` 提前 60s 失效缓存，遇到 CDN `403/404/410` 时**清缓存并重取一次**（最多 2 次，防止风暴）。
- **并发/缓存**：同一 `(songId, level)` 并发请求合并（single-flight）；地址缓存 10 分钟上限；不要缓存音频体（本地曲库已有自己的缓存体系，在线流由浏览器 HTTP 缓存处理）。
- **音质降级**：请求 `lossless`/`hires` 失败时，按 `lossless → exhigh → higher → standard` 依次降级并在响应头标记实际档位（前端可提示）。
- **超时/中断**：上游首包超时 15s；`request.on('close')` 时 abort 上游，避免连接泄漏。

### 4.3 音质策略（按账号权益）

| 场景 | 建议请求档位 |
| --- | --- |
| 默认 | `exhigh`（320k mp3；VIP 账号实测可用；体积/音质平衡） |
| 明确"无损"开关且账号 VIP | `lossless`（flac ~24MB/首，注意内存/带宽） |
| 免费账号 | `standard`（128k）或 `higher`（192k），失败自动降级 |
| `hires/jyeffect/sky/jymaster` | 走 eapi v1（本次未实测），MVP 不做 |

> 权益边界：只使用**当前登录账号**有权播放的地址；`url=null` 就如实显示不可播（试听/会员/版权下架都走这条）。**不集成** UnblockNeteaseMusic 之类的"解锁"方案。

### 4.4 封面代理与 canvas/WebGL 同源

- 网易云封面域 `p1/p2/p3/p4.music.126.net` 支持匿名 + `Range`（实测 206），但前端若用 Three.js 纹理/`canvas` 读取像素会受 CORS/`crossOrigin` 限制。
- 建议统一走本地代理：`GET /api/netease/cover?url=<encodeURIComponent(picUrl)>&size=300`
  - 后端校验 `url` 的 host 必须匹配 `/^p[1-4]\.music\.126\.net$/`（防 SSRF），只允许 `https`；
  - 透传 `?param=<size>y<size>`；响应加 `Cache-Control: private, max-age=3600`；
  - 前端拿到的是**同源 URL**，canvas/WebGL/crossOrigin 问题一并解决。
- 歌单/专辑封面同理。

### 4.5 失败与降级矩阵

| 现象 | 处理 |
| --- | --- |
| `/api/nuser/account/get` 返回 `account=null` | 登录态失效 → 前端提示重新登录（扫码/导入/手填） |
| 播放地址 `url=null` | 该曲当前账号不可播 → UI 禁用并提示（会员/版权）；不要重试 |
| CDN `403/404/410` | 地址过期或防盗链 → 清缓存重取 1 次，仍失败提示 |
| CDN 超时 | 重试 1 次；仍失败按档位降级 |
| 接口 `code=-460` | 加密/签名被拒（只有 weapi/eapi 通道会）→ 核对 `crypto.mjs` 常量与路径 |
| 接口 `code=404` | **先检查 URL 路径**（`/weapi/api/...` 这类多一层前缀）；再考虑接口变更 |
| 接口 `code=301/需要验证` | 触发风控 → 停止重试，提示稍后/重新登录 |

---

## 5. MVP 拆分

### 5.1 P0：服务端模块 `app/scripts/netease.mjs`（纯 Node 内置模块）

建议导出（可直接复用 `probes/netease/lib/*` 的实现，见 `probes/netease/README.md`）：

```js
// 会话
export function createNeteaseClient({ sessionStore, fetchImpl = fetch, now = Date.now } = {})
client.hasSession()                       // 是否有本地 session
client.verifySession()                    // GET /api/nuser/account/get → { ok, vipType, userIdMasked }
client.importFromClient()                 // 可选：读本机 CEF cookie → { ok, cookieCount }（内存，不打印）
client.importCookieString(str)            // 手动粘贴兜底
client.logout()                           // 清 session 与缓存

// 扫码登录
client.createQrLogin()                    // POST /api/login/qrcode/unikey → { key, qrContent, expiresAt }
client.pollQrLogin(key)                   // GET .../client/login → { state:'waiting'|'scanned'|'expired'|'success', session? }

// 数据（读）
client.getAccount()                       // GET /api/nuser/account/get
client.getUserPlaylists(uid)              // GET /api/user/playlist?uid&limit=1000&offset=0
client.getLikedPlaylistId()               // 从 playlists 找 specialType===5
client.getPlaylistDetail(id, { n = 1000, s = 0 })   // 兼容 {result}/{playlist}
client.getSongDetail(ids)                 // POST /api/v3/song/detail  c=[{id}]
client.getSongUrl(songId, level)          // GET /api/song/enhance/player/url?ids&br → 带 expi 缓存
client.getLyric(songId)                   // GET /api/song/lyric → { lrc, tlyric }
client.search(keyword)                    // POST /api/search/get/web

// 内部
client.getCookieHeader()                  // 仅后端可用，禁止打印
```

建议新增 `app/scripts/netease-session.mjs`：session 的 DPAPI 加密读写（`load/save/clear`），文件放 `%LOCALAPPDATA%\RhineMusic\netease-session.bin`。

**`music-server.mjs` 新增路由**（沿用现有 `json()/bodyJson()/LOOPBACK`/同源校验）：

| 路由 | 方法 | 说明 |
| --- | --- | --- |
| `/api/netease/status` | GET | `{loggedIn, vipType?, userIdMasked?}` |
| `/api/netease/login/qr` | POST | `{key, qrContent}`（二维码内容）；不返回 cookie |
| `/api/netease/login/qr/status?key=` | GET | `{state}`；`success` 时后端已落 session |
| `/api/netease/session` | DELETE | 退出登录 |
| `/api/netease/session/import` | POST | `{cookie}` 手动兜底；`{fromClient:true}` 可选导入本机客户端 |
| `/api/netease/playlists` | GET | `{liked:{...}, playlists:[{id,name,count}]}` |
| `/api/netease/playlists/:id` | GET | `{id,name,tracks:[{id,name,artist,album,cover,duration,fee}]}` |
| `/api/netease/stream/:songId?level=` | GET | 音频流（Range 透传，见 4.2） |
| `/api/netease/cover?url=&size=` | GET | 封面图（host 白名单） |
| `/api/netease/lyric/:songId` | GET | `{lrc, tlyric}` |

### 5.2 P1：前端接入（最小改动点）

1. `src/music-types.ts` / `src/data.ts`：加在线曲目模型 `{ source:'netease', id, title, artist, album, coverUrl:'/api/netease/cover?...', durationMs, fee }`，与本地 `track` 统一为 `PlayableTrack`。
2. `src/music-player.ts`：`audio.src` 分支——`source==='netease' ? '/api/netease/stream/'+id+'?level=exhigh' : '/api/audio/'+id`。
3. `src/lyrics.ts`：在线曲目歌词改为 `GET /api/netease/lyric/:songId`（本地仍走 `/api/lyrics/:trackId`）。
4. 歌单列表：在 `src/data.ts` 拉 `/api/netease/playlists`，UI 复用现有 `playlists` 视图；"我喜欢的音乐"置顶。
5. 登录 UI：设置页加"网易云账号"卡片（扫码 / 导入本机客户端 / 粘贴 cookie 三种入口 + 退出登录）。
6. 封面：所有在线封面统一用 `/api/netease/cover` 同源代理（Three.js 纹理与 `crossOrigin` 一并解决）。

### 5.3 P2（本次不做）

- 收藏/取消收藏、新建/编辑歌单（写操作，需要 `__csrf`，未实测）。
- 下载/离线缓存（版权敏感，且要处理 `expi` 与本地加密；建议不做，或只做浏览器 HTTP 缓存）。
- 一起听/评论/推荐流等。
- hires/空间音频等 eapi 新档位。

---

## 6. 可参考实现（2026-10 实测维护状态）

| 项目 | 状态（实测） | 建议 |
| --- | --- | --- |
| `Binaryify/NeteaseCloudMusicApi`（GitHub） | **已归档**（`archived=true`，最后 push 2024-02-28，30k stars）；原仓库内容已不可依赖 | ❌ 不要依赖原仓库 |
| `NeteaseCloudMusicApi`（npm 4.32.0，2026-05-18 发布，maintainer `traveller`） | npm 上仍可安装（非原仓库发布，来源需自行甄别） | ⚠️ 谨慎；仅作参考 |
| `@neteasecloudmusicapienhanced/api`（npm 4.41.1，2026-10-05，MIT） | 活跃维护的 revival 项目（repo: `NeteaseCloudMusicApiEnhanced/api-enhanced`），接口/加密实现与本文一致 | ✅ 推荐作为**参考实现**（读代码、对照接口），不建议作为运行时依赖 |
| `netease-cloud-music-api-alger`（npm 4.32.0，2026-09-29） | 活跃 fork | 可参考 |
| Python `pyncm` | PyPI 查询 404（不存在/已下架） | ❌ 不推荐 |
| Python `NeteaseCloudMusicApi` | PyPI 0.1.2（2023-12） | ❌ 陈旧 |

**自实现要点**（本仓库 `probes/netease/lib/crypto.mjs` 已实现并自测）：

1. weapi：`params = AES-128-CBC(AES-128-CBC(JSON, presetKey, iv), secretKey, iv)`（base64）；`encSecKey = RSA-1024-NO_PADDING(reverse(secretKey))` 的 hex；固定 `presetKey=0CoJUm6Qyw8W8jud`、`iv=0102030405060708`。
2. eapi：`text=JSON.stringify(data+header)`，`digest=md5("nobody"+path+"use"+text+"md5forencrypt")`，`message=path+"-36cd479b6b5-"+text+"-36cd479b6b5-"+digest`，`AES-128-ECB(key=e82ckenh8dichen8)` → hex 大写；**响应可能加密**，用同一 key AES-128-ECB 解密。
3. csrf：写操作把 cookie 里的 `__csrf` 作为 `csrf_token` 放进 data（本次未实测写操作）。
4. cookie：读接口 `MUSIC_U` 即可；请求头 `Cookie: MUSIC_U=...; __csrf=...`。

---

## 7. 风险与合规

### 7.1 个人自用边界

- 仅本机单用户使用；**不对外提供公开 API/服务**、不共享账号或 cookie、不分发本项目修改版用于绕过付费。
- 所有播放均使用**当前登录账号**有权播放的地址；`url=null` 时如实提示不可播放。**不集成解锁/替代音源类方案**（UnblockNeteaseMusic 等），那属于绕过版权限制，明确排除。
- 不批量爬取歌单/评论/用户数据；只拉自己账号的收藏与歌单，低频、按需、可缓存。

### 7.2 账号风控

- 实测：串行 + 0.5–0.8s 间隔的少量请求完全正常；连续探测未触发限流（此前的 "404" 已查明是路径拼接错误，不是风控）。
- 仍建议：请求串行化、加缓存、复用连接、避免短时间大量搜索/翻页；出现 `-460/301` 等异常时停止重试、提示用户；不要用第三方公共 API 实例代理自己账号。
- 用户 UA 建议固定为桌面客户端 UA（`UA_CLIENT`），与取流场景一致。

### 7.3 凭据安全（必须）

- cookie 是账号凭据：**DPAPI 加密落盘**、仅当前 Windows 用户可解；不写日志、不进 Git、不回传浏览器。
- 后端内存中的 cookie 不参与错误上报；播放 URL 只保留 host 用于日志。
- 导入本机客户端登录态是**用户主动触发的可选动作**，默认关闭；脚本仅只读，不修改客户端文件。

### 7.4 接口稳定性

- 网易云接口非官方、会变：本报告是 2026-10-30 的快照；上线前重跑 `probes/netease/probe-anon.mjs` 与 `probe-account.mjs`。
- 已知易变点：歌单详情结构（`result` vs `playlist`）、`trackIds` 是否存在、eapi 响应是否加密、明文接口是否收紧。
- 明文接口若未来全部失效，备用路径是 weapi/eapi（本仓库已实现并自测）。

---

## 8. 未验证项 / 下一步

| 项 | 说明 |
| --- | --- |
| 扫码 `803` 端到端 | 需人工扫码验证 `Set-Cookie` 落地与 `session` 持久化（代码路径已按协议实现） |
| `MUSIC_R_U` 刷新接口 | 未验证；建议不做自动刷新，失效即重新登录 |
| `hires` 及空间音频档位 | 未实测；MVP 不做 |
| 超过 1000 首的歌单/喜欢列表 | 866 首已覆盖；>1000 需 `s` 翻页或 weapi v6（未测） |
| 写操作（收藏/取消收藏/建歌单） | 未实现；需要 `__csrf`，本次未测 |
| 客户端升级兼容 | CEF profile 目录、`v10` 格式、`LocalPrefs` 结构都可能变；需兜底 |
| `node:sqlite` 在旧 Node | Node 22 需 `--experimental-sqlite`；应用要求 `>=22.12`，建议此功能探测失败即降级到扫码/手填 |
| 多账号/多客户端 profile | 未测；实现时按"取最近修改的 webapp* + 校验通过"选一个 |

---

## 附录 A：复跑命令

```powershell
cd "D:\DSH creat world\rhine-music\probes\netease"
node probe-anon.mjs                                  # 匿名端点
node probe-weapi.mjs                                 # weapi/eapi 自检
node extract-client-cookies.mjs --check --verify     # 客户端登录态体检
node probe-account.mjs --from-client                 # 登录态只读冒烟
```

## 附录 B：证据文件

- `probes/netease/results/anon-20261030-215837.json` —— 匿名端点（A1–A9）
- `probes/netease/results/weapi-20261030-221924.json` —— weapi/eapi（B1–B3，路径修正后）
- `probes/netease/results/account-20261030-215907.json` —— 登录态（C1–C7）
- 更早的探测（含失败记录）：`anon-20261030-215558/215632.json`、`weapi-20261030-215633/215851.json`、`account-20261030-215635.json`

## 附录 C：weapi 404 排查记录（避免后人踩坑）

| 现象 | 首版 `probe-weapi.mjs` 对 `/api/nuser/account/get`、`/api/search/get` 均返回 `code:404` |
| --- | --- |
| 误判方向 | 一度怀疑风控限流/加密错误（并加了 3s 重试，仍 404） |
| 根因 | 路径拼接 bug：模块名写成 `api/nuser/account/get` 又前缀 `/weapi/` → 实际请求 `/weapi/api/nuser/account/get`（多一层 `api`） |
| 修正 | `/api/*` → `/weapi/*` 时**去掉 `/api` 前缀**：`/weapi/nuser/account/get` |
| 验证 | 修正后 HTTP 200 / code 200（`weapi-20261030-221924.json`） |
| 经验 | `code:404` 先核对 URL；`code:-460` 才是签名/加密被拒；`code:301` 才可能是风控/需验证 |
