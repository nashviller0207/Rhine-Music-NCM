// Rhine Music P0 · 网易云在线源服务端代理（单文件 ESM）
// 职责：
//   - 复用本机网易云客户端登录态（CEF Cookies + DPAPI，仅内存解密，绝不落盘/打印 cookie）
//   - 把用户歌单映射为本地 MusicAlbum / MusicTrack 契约
//   - 代理播放流（Range 透传）、歌词（lrc + tlyric 合并）、封面（*.music.126.net 白名单）
// 约束：只静态 import Node 内置模块（node:sqlite 动态 import，避免低版本 Node 直接崩）；
//       不引入任何裸依赖/原生模块，便于 esbuild 内联进桌面单文件。
// 安全：任何错误信息都不包含 cookie 值、也不包含带签名的 CDN 播放地址。

import { createDecipheriv } from 'node:crypto'
import { spawn } from 'node:child_process'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import path from 'node:path'
import { Readable } from 'node:stream'

const API_ORIGIN = 'https://music.163.com'
const API_REFERER = 'https://music.163.com/'
const UA_BROWSER =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36'
const UA_CLIENT =
  'Mozilla/5.0 (Windows NT 10.0; WOW64) AppleWebKit/537.36 (KHTML, like Gecko) Safari/537.36 Chrome/91.0.4472.164 NeteaseMusicDesktop/3.1.41.205529'
const COVER_HOST_SUFFIX = '.music.126.net'
const NETEASE_GENRE = Object.freeze({ id: 'netease', name: '网易云音乐' })

const DEFAULT_MAX_PLAYLISTS = 24
const DEFAULT_MAX_TRACKS = 1000

const LIBRARY_TTL = 10 * 60 * 1000
const ACCOUNT_TTL = 10 * 60 * 1000
const COOKIE_TTL = 10 * 60 * 1000
const SONG_URL_TTL = 5 * 60 * 1000
const FAILURE_TTL = 60 * 1000
const REQUEST_TIMEOUT = 15000
const CDN_TIMEOUT = 25000
const PLAYLIST_CONCURRENCY = 4

function sleep(ms) {
  return new Promise((resolve) => setTimeout(resolve, ms))
}

function errorText(error) {
  return String((error && error.message) || error || '未知错误').slice(0, 300)
}

function networkReason(error) {
  const cause = error && error.cause
  return String((cause && (cause.code || cause.message)) || (error && error.name) || '网络错误').slice(0, 120)
}

function positiveInt(value, fallback) {
  const parsed = Number(value)
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback
}

async function mapLimit(items, limit, mapper) {
  const results = new Array(items.length)
  let cursor = 0
  const workerCount = Math.max(1, Math.min(limit, items.length))
  const workers = []
  for (let index = 0; index < workerCount; index += 1) {
    workers.push(
      (async () => {
        while (true) {
          const current = cursor
          cursor += 1
          if (current >= items.length) return
          results[current] = await mapper(items[current], current)
        }
      })()
    )
  }
  await Promise.all(workers)
  return results
}

function isAllowedCoverHost(hostname) {
  return typeof hostname === 'string' && hostname.toLowerCase().endsWith(COVER_HOST_SUFFIX)
}

function parseCoverUrl(raw) {
  let url
  try {
    url = new URL(String(raw))
  } catch {
    throw Object.assign(new Error('封面地址无效'), { status: 400 })
  }
  if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password || url.port !== '') {
    throw Object.assign(new Error('封面地址不允许携带凭据或非标准端口'), { status: 400 })
  }
  if (!isAllowedCoverHost(url.hostname)) throw Object.assign(new Error('封面地址不在 *.music.126.net 白名单内'), { status: 400 })
  return url
}

function pickUpstreamHeaders(response) {
  const headers = {}
  for (const name of ['content-type', 'content-length', 'content-range', 'accept-ranges']) {
    const value = response.headers.get(name)
    if (value) headers[name] = value
  }
  return headers
}

// ---------------------------------------------------------------------------
// 本机客户端登录态：CEF Cookies(SQLite) + DPAPI 解出 AES key，全程只在内存中
// ---------------------------------------------------------------------------

function localAppData() {
  if (process.env.LOCALAPPDATA) return process.env.LOCALAPPDATA
  const home = process.env.USERPROFILE || process.env.HOME || ''
  return path.join(home, 'AppData', 'Local')
}

async function findCefProfile(baseDir = path.join(localAppData(), 'Netease', 'CloudMusic')) {
  const entries = await readdir(baseDir, { withFileTypes: true }).catch(() => [])
  for (const entry of entries) {
    if (!entry.isDirectory() || !/^webapp\d*$/i.test(entry.name)) continue
    const directory = path.join(baseDir, entry.name)
    const cookiesPath = path.join(directory, 'Cookies')
    const localPrefsPath = path.join(directory, 'LocalPrefs.json')
    try {
      if ((await stat(cookiesPath)).isFile()) return { directory, cookiesPath, localPrefsPath }
    } catch {
      // 跳过不完整的 profile
    }
  }
  return null
}

const PS_UNPROTECT =
  "$ErrorActionPreference='Stop';" +
  '$in=[Console]::In.ReadToEnd();' +
  '$b=[Convert]::FromBase64String($in.Trim());' +
  "$p=[System.Security.Cryptography.ProtectedData]::Unprotect($b,$null,'CurrentUser');" +
  '[Console]::Out.Write([Convert]::ToBase64String($p))'

function runPowerShell(command, stdinData) {
  return new Promise((resolve, reject) => {
    const attempt = (exe, fallback) => {
      const child = spawn(exe, ['-NoProfile', '-NonInteractive', '-Command', command], {
        stdio: ['pipe', 'pipe', 'pipe'],
        windowsHide: true,
      })
      let out = ''
      child.stdout.on('data', (chunk) => (out += chunk))
      child.on('error', (error) => (fallback ? attempt(fallback, null) : reject(error)))
      child.on('close', (code) => {
        if (code === 0) return resolve(out)
        if (fallback) return attempt(fallback, null)
        reject(new Error('PowerShell 进程退出码 ' + code))
      })
      child.stdin.end(stdinData)
    }
    attempt('powershell.exe', 'pwsh.exe')
  })
}

async function dpapiUnprotect(protectedBuffer) {
  const encoded = Buffer.from(protectedBuffer).toString('base64')
  const output = await runPowerShell(PS_UNPROTECT, encoded)
  return Buffer.from(String(output).trim(), 'base64')
}

function decryptCookieValue(encryptedValue, aesKey) {
  const buffer = Buffer.from(encryptedValue)
  const prefix = buffer.subarray(0, 3).toString('latin1')
  if (prefix === 'v10' || prefix === 'v11') {
    if (buffer.length < 3 + 12 + 16) throw new Error('客户端 Cookie 密文长度异常')
    const nonce = buffer.subarray(3, 15)
    const tag = buffer.subarray(buffer.length - 16)
    const data = buffer.subarray(15, buffer.length - 16)
    const decipher = createDecipheriv('aes-256-gcm', aesKey, nonce)
    decipher.setAuthTag(tag)
    return Buffer.concat([decipher.update(data), decipher.final()])
  }
  if (prefix === 'v20') throw new Error('客户端 Cookie 使用 v20 加密，暂不支持')
  throw new Error('客户端 Cookie 加密前缀未知')
}

async function readClientCookies() {
  if (process.platform !== 'win32') throw new Error('仅 Windows 支持复用网易云客户端登录态，请使用 NETEASE_COOKIE')
  const profile = await findCefProfile()
  if (!profile) throw new Error('未找到网易云客户端配置（请先安装并登录网易云音乐客户端）')
  let prefs
  try {
    prefs = JSON.parse(await readFile(profile.localPrefsPath, 'utf8'))
  } catch {
    throw new Error('无法读取网易云客户端 LocalPrefs.json')
  }
  const encodedKey = prefs && prefs.os_crypt && prefs.os_crypt.encrypted_key
  if (!encodedKey) throw new Error('网易云客户端缺少 os_crypt 密钥，无法解密登录态')
  const packed = Buffer.from(String(encodedKey), 'base64')
  if (packed.subarray(0, 5).toString('latin1') !== 'DPAPI') throw new Error('网易云客户端登录态不是 DPAPI 格式，暂不支持')
  const aesKey = await dpapiUnprotect(packed.subarray(5))
  if (aesKey.length !== 32) throw new Error('网易云客户端登录态密钥长度异常')
  let DatabaseSync
  try {
    ;({ DatabaseSync } = await import('node:sqlite'))
  } catch {
    throw new Error('当前 Node 不支持 node:sqlite，无法读取客户端 Cookie')
  }
  const cookies = new Map()
  let database
  try {
    database = new DatabaseSync(profile.cookiesPath, { readOnly: true })
  } catch {
    throw new Error('无法打开网易云客户端 Cookie 数据库（可能被客户端独占）')
  }
  try {
    const rows = database
      .prepare("select host_key, name, value, encrypted_value from cookies where host_key like '%music.163.com'")
      .all()
    for (const row of rows) {
      const name = String(row.name)
      if (cookies.has(name)) continue
      let plain = ''
      const encrypted = row.encrypted_value
      if (encrypted && Buffer.from(encrypted).length > 0) {
        try {
          plain = decryptCookieValue(encrypted, aesKey).toString('utf8')
        } catch {
          continue
        }
      } else {
        plain = String(row.value || '')
      }
      if (plain) cookies.set(name, plain)
    }
  } finally {
    database.close()
  }
  if (!cookies.has('MUSIC_U')) throw new Error('网易云客户端未登录（登录态 Cookie 中没有 MUSIC_U）')
  const parts = []
  for (const [name, value] of cookies) parts.push(name + '=' + value)
  return { header: parts.join('; '), source: 'local-client-cef', count: cookies.size }
}

function normalizeCookie(raw) {
  const text = String(raw || '').trim()
  if (!text) throw new Error('NETEASE_COOKIE 内容为空')
  if (text.startsWith('{')) {
    let parsed
    try {
      parsed = JSON.parse(text)
    } catch {
      throw new Error('NETEASE_COOKIE JSON 格式无效')
    }
    if (!parsed || typeof parsed !== 'object') throw new Error('NETEASE_COOKIE JSON 格式无效')
    return Object.entries(parsed)
      .map(([key, value]) => key + '=' + String(value))
      .join('; ')
  }
  const header = text
    .replace(/^cookie\s*:\s*/i, '')
    .replace(/[\r\n]+/g, '; ')
    .trim()
  if (!/(?:^|;\s*)MUSIC_U=/.test(header)) throw new Error('NETEASE_COOKIE 中缺少 MUSIC_U')
  return header
}

async function resolveCookie() {
  const fromEnv = process.env.NETEASE_COOKIE
  if (fromEnv && fromEnv.trim()) return { header: normalizeCookie(fromEnv), source: 'env' }
  const cookieFile = process.env.NETEASE_COOKIE_FILE
  if (cookieFile && cookieFile.trim()) {
    let raw
    try {
      raw = await readFile(cookieFile.trim(), 'utf8')
    } catch {
      throw new Error('无法读取 NETEASE_COOKIE_FILE 指定的文件')
    }
    return { header: normalizeCookie(raw), source: 'cookie-file' }
  }
  return readClientCookies()
}

// ---------------------------------------------------------------------------
// 数据映射：歌单 -> MusicAlbum，歌曲 -> MusicTrack（严格对齐 src/music-types.ts）
// ---------------------------------------------------------------------------

function playlistCoverUrl(playlist, detail) {
  const source = (playlist && playlist.coverImgUrl) || (detail && detail.coverImgUrl) || ''
  if (typeof source !== 'string' || !source) return undefined
  const target = source.includes('?') ? source + '&param=600y600' : source + '?param=600y600'
  return '/api/netease/cover?url=' + encodeURIComponent(target)
}

function songArtists(song) {
  const list = Array.isArray(song.ar) && song.ar.length ? song.ar : Array.isArray(song.artists) ? song.artists : []
  const names = list.map((entry) => String((entry && entry.name) || '').trim()).filter(Boolean)
  return names.length ? names.join('/') : '未知歌手'
}

function songCoverUrl(song) {
  const source = (song && song.al && song.al.picUrl) || (song && song.album && song.album.picUrl) || ''
  if (typeof source !== 'string' || !source) return undefined
  const target = source.includes('?') ? source + '&param=600y600' : source + '?param=600y600'
  return '/api/netease/cover?url=' + encodeURIComponent(target)
}

function songDurationMs(song) {
  const raw = Number(song.dt !== undefined ? song.dt : song.duration)
  return Number.isFinite(raw) && raw > 0 ? raw : 0
}

function toTrack(song, index, albumId) {
  return {
    id: 'netease-song-' + String(song.id),
    albumId,
    title: String(song.name || '未知歌曲'),
    artist: songArtists(song),
    trackNumber: index + 1,
    duration: songDurationMs(song) / 1000,
    format: 'mp3',
    codec: 'mp3',
    bitrate: 320000,
    browserPlayable: true,
    audioUrl: '/api/netease/audio/' + String(song.id),
    coverUrl: songCoverUrl(song),
    relativePath: '',
    offline: false,
  }
}

function normalizePlaylistTracks(detail) {
  if (!detail) return []
  return (Array.isArray(detail.tracks) ? detail.tracks : []).filter((song) => song && Number.isFinite(Number(song.id)))
}

function playlistToAlbum(playlist, detail, maxTracks) {
  const playlistId = String(playlist.id)
  const albumId = 'netease-playlist-' + playlistId
  const title = String(playlist.name || (detail && detail.name) || '歌单 ' + playlistId)
  const tracks = normalizePlaylistTracks(detail)
    .slice(0, maxTracks)
    .map((song, index) => toTrack(song, index, albumId))
  const album = {
    id: albumId,
    title,
    artist: '网易云音乐',
    genreId: 'netease',
    rawGenres: ['网易云音乐'],
    folder: '网易云音乐/' + title,
    tracks,
    producers: [],
    offline: false,
  }
  const cover = playlistCoverUrl(playlist, detail)
  if (cover) album.coverUrl = cover
  return album
}

// 合并 lrc 与 tlyric：原文行后紧跟同时间戳的翻译行（parseLrc 会按时间+顺序稳定排列）
const TIMESTAMP_TAG = /\[(\d{1,3}):([0-5]\d)(?:[.:](\d{1,3}))?\]/g

function timestampTags(line) {
  const tags = []
  TIMESTAMP_TAG.lastIndex = 0
  let match
  while ((match = TIMESTAMP_TAG.exec(line))) tags.push(match[0])
  return tags
}

function mergeLyrics(lrcText, translationText) {
  const translations = new Map()
  if (translationText) {
    for (const line of String(translationText).split(/\r\n?|\n/)) {
      const translated = line.replace(/\[[^\]]*\]/g, '').trim()
      if (!translated) continue
      for (const tag of timestampTags(line)) if (!translations.has(tag)) translations.set(tag, translated)
    }
  }
  const output = []
  for (const line of String(lrcText || '').split(/\r\n?|\n/)) {
    output.push(line)
    for (const tag of timestampTags(line)) {
      const translated = translations.get(tag)
      if (translated) output.push(tag + translated)
    }
  }
  return output.join('\n')
}

// ---------------------------------------------------------------------------
// 客户端
// ---------------------------------------------------------------------------

export function createNeteaseClient({ dataDir } = {}) {
  const rootDir = path.resolve(
    dataDir || process.env.MUSIC_DATA_DIR || path.join(process.cwd(), '..', 'music-data-v3')
  )
  const cacheDir = path.join(rootDir, 'netease')
  const libraryFile = path.join(cacheDir, 'library.json')
  const maxPlaylists = positiveInt(process.env.RHINE_NETEASE_MAX_PLAYLISTS, DEFAULT_MAX_PLAYLISTS)
  const maxTracks = positiveInt(process.env.RHINE_NETEASE_MAX_TRACKS, DEFAULT_MAX_TRACKS)

  let cookie = null
  let cookieFailure = null
  let account = null
  let accountFailure = null
  let playlists = null
  let playlistsFailure = null
  let libraryCache = null
  let libraryFailure = null
  const songUrlCache = new Map()

  function failureFresh(entry) {
    return !!entry && Date.now() - entry.at < FAILURE_TTL
  }

  async function ensureCookie(force) {
    if (!force && cookie && Date.now() - cookie.readAt < COOKIE_TTL) return cookie
    if (force) cookie = null
    if (!force && failureFresh(cookieFailure)) throw new Error(cookieFailure.error)
    try {
      const resolved = await resolveCookie()
      cookie = { header: resolved.header, source: resolved.source, readAt: Date.now() }
      cookieFailure = null
      return cookie
    } catch (error) {
      cookie = null
      cookieFailure = { error: errorText(error), at: Date.now() }
      throw new Error(cookieFailure.error)
    }
  }

  async function requestJson(pathname, label, auth) {
    const cookieState = auth === false ? null : await ensureCookie(false)
    const headers = {
      'user-agent': UA_BROWSER,
      referer: API_REFERER,
      origin: API_ORIGIN,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
    }
    if (cookieState) headers.cookie = cookieState.header
    let response
    try {
      response = await fetch(API_ORIGIN + pathname, { headers, signal: AbortSignal.timeout(REQUEST_TIMEOUT) })
    } catch (error) {
      throw new Error(label + '网络请求失败（' + networkReason(error) + '）')
    }
    let text
    try {
      text = await response.text()
    } catch (error) {
      throw new Error(label + '响应读取失败（' + networkReason(error) + '）')
    }
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    if (!response.ok) throw new Error(label + '返回 HTTP ' + response.status)
    return { status: response.status, json }
  }

  async function postForm(pathname, label, form) {
    const cookieState = await ensureCookie(false)
    const headers = {
      'user-agent': UA_BROWSER,
      referer: API_REFERER,
      origin: API_ORIGIN,
      accept: 'application/json, text/plain, */*',
      'accept-language': 'zh-CN,zh;q=0.9',
      'content-type': 'application/x-www-form-urlencoded; charset=UTF-8',
    }
    if (cookieState) headers.cookie = cookieState.header
    let response
    try {
      response = await fetch(API_ORIGIN + pathname, {
        method: 'POST',
        headers,
        body: form.toString(),
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
      })
    } catch (error) {
      throw new Error(label + '网络请求失败（' + networkReason(error) + '）')
    }
    let text
    try {
      text = await response.text()
    } catch (error) {
      throw new Error(label + '响应读取失败（' + networkReason(error) + '）')
    }
    let json = null
    try {
      json = JSON.parse(text)
    } catch {
      json = null
    }
    if (!response.ok) throw new Error(label + '返回 HTTP ' + response.status)
    return { status: response.status, json }
  }

  const searchCache = new Map()

  async function search(keywords, limit = 20) {
    const query = String(keywords || '').trim().slice(0, 80)
    if (!query) return { songs: [], query: '' }
    const size = Math.min(30, Math.max(1, Number(limit) || 20))
    const key = query + '|' + size
    const cached = searchCache.get(key)
    if (cached && Date.now() - cached.at < SONG_URL_TTL) return cached.value
    const form = new URLSearchParams({ s: query, type: '1', offset: '0', limit: String(size) })
    const { json } = await postForm('/api/search/get/web', '搜索', form)
    const data = json || {}
    if (data.code !== 200) throw new Error('网易云搜索失败（code ' + (data.code ?? '?') + '）')
    let songs = (((data.result || {}).songs) || [])
      .map((song) => {
        const album = song.album || song.al || {}
        const artists = song.artists || song.ar || []
        return {
          id: String(song.id || ''),
          name: String(song.name || ''),
          artist: artists.map((artist) => artist && artist.name).filter(Boolean).join(' / '),
          album: String(album.name || ''),
          albumId: album.id ? String(album.id) : '',
          cover: String(album.picUrl || ''),
          duration: Number(song.duration ?? song.dt ?? 0) / 1000,
          fee: song.fee ?? null,
        }
      })
      .filter((song) => song.id && song.name)
    if (songs.length && songs.some((song) => !song.cover)) {
      try {
        const detailForm = new URLSearchParams({ c: JSON.stringify(songs.map((song) => ({ id: song.id }))) })
        const detail = await postForm('/api/v3/song/detail', '歌曲详情', detailForm)
        const byId = new Map(((((detail.json || {}).songs) || [])).map((item) => [String(item.id), item]))
        songs = songs.map((song) => {
          const info = byId.get(song.id)
          if (!info) return song
          const album = info.al || {}
          const artists = info.ar || []
          return {
            ...song,
            artist: song.artist || artists.map((artist) => artist.name).filter(Boolean).join(' / '),
            album: song.album || String(album.name || ''),
            cover: song.cover || String(album.picUrl || ''),
            duration: song.duration || Number(info.dt || 0) / 1000,
          }
        })
      } catch {
        // cover enrichment is best-effort; search still works without it
      }
    }
    const value = { songs, query }
    searchCache.set(key, { at: Date.now(), value })
    return value
  }

  async function fetchAccount(force) {
    if (!force && account && Date.now() - account.at < ACCOUNT_TTL) return account
    if (!force && failureFresh(accountFailure)) throw new Error(accountFailure.error)
    try {
      const { json } = await requestJson('/api/nuser/account/get', '账号信息')
      const data = json || {}
      if (data.code !== 200 || !data.account || !data.profile) {
        throw new Error('网易云登录态无效（请确认客户端已登录，或检查 NETEASE_COOKIE）')
      }
      account = {
        id: data.account.id,
        nickname: String(data.profile.nickname || ''),
        vipType: data.profile.vipType,
        fetchedAt: new Date().toISOString(),
        at: Date.now(),
      }
      accountFailure = null
      return account
    } catch (error) {
      account = null
      accountFailure = { error: errorText(error), at: Date.now() }
      throw new Error(accountFailure.error)
    }
  }

  async function fetchPlaylists(force) {
    if (!force && playlists && Date.now() - playlists.at < ACCOUNT_TTL) return playlists.list
    if (!force && failureFresh(playlistsFailure)) throw new Error(playlistsFailure.error)
    const profile = await fetchAccount(force)
    try {
      const { json } = await requestJson(
        '/api/user/playlist?uid=' + encodeURIComponent(String(profile.id)) + '&limit=1000&offset=0',
        '我的歌单'
      )
      const list = json && json.playlist
      if (!Array.isArray(list)) throw new Error('我的歌单返回格式异常')
      playlists = { list, at: Date.now() }
      playlistsFailure = null
      return list
    } catch (error) {
      playlistsFailure = { error: errorText(error), at: Date.now() }
      throw new Error(playlistsFailure.error)
    }
  }

  async function fetchPlaylistDetail(playlistId) {
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const { json } = await requestJson(
          '/api/playlist/detail?id=' + encodeURIComponent(String(playlistId)) + '&n=1000&s=0',
          '歌单详情'
        )
        const detail = json && (json.playlist || json.result)
        if (!detail || !Array.isArray(detail.tracks)) throw new Error('歌单详情返回格式异常')
        return detail
      } catch (error) {
        lastError = error
        if (attempt === 0) await sleep(400)
      }
    }
    throw lastError
  }

  async function buildLibrary() {
    const profile = await fetchAccount(false)
    const list = await fetchPlaylists(false)
    const liked = list.find((playlist) => playlist && playlist.specialType === 5) || null
    const ordered = []
    if (liked) ordered.push(liked)
    for (const playlist of list) {
      if (playlist && (!liked || playlist.id !== liked.id)) ordered.push(playlist)
    }
    const selected = ordered.filter((playlist) => playlist && playlist.id).slice(0, maxPlaylists)
    const albums = (
      await mapLimit(selected, PLAYLIST_CONCURRENCY, async (playlist) => {
        try {
          const detail = await fetchPlaylistDetail(playlist.id)
          return playlistToAlbum(playlist, detail, maxTracks)
        } catch {
          return null
        }
      })
    ).filter(Boolean)
    if (!albums.length) throw new Error('网易云歌单详情全部读取失败')
    const likedAlbum = liked ? albums.find((album) => album.id === 'netease-playlist-' + String(liked.id)) : null
    return {
      albums,
      genres: [{ id: NETEASE_GENRE.id, name: NETEASE_GENRE.name }],
      meta: {
        playlists: albums.length,
        likedTracks: liked ? Number(liked.trackCount || 0) : 0,
        fetchedAt: new Date().toISOString(),
        totalPlaylists: list.length,
        likedAlbumId: likedAlbum ? likedAlbum.id : null,
        userId: profile.id,
        nickname: profile.nickname,
      },
    }
  }

  async function readDiskCache() {
    try {
      const raw = JSON.parse(await readFile(libraryFile, 'utf8'))
      if (!raw || raw.version !== 2 || !Array.isArray(raw.albums) || !raw.fetchedAt) return null
      const fetchedAt = Date.parse(raw.fetchedAt)
      if (!Number.isFinite(fetchedAt) || Date.now() - fetchedAt > LIBRARY_TTL) return null
      return {
        albums: raw.albums,
        genres: Array.isArray(raw.genres) && raw.genres.length ? raw.genres : [{ id: NETEASE_GENRE.id, name: NETEASE_GENRE.name }],
        meta: raw.meta || { playlists: raw.albums.length, likedTracks: 0, fetchedAt: raw.fetchedAt },
        fetchedAt,
        at: Date.now(),
      }
    } catch {
      return null
    }
  }

  async function writeDiskCache(snapshot) {
    try {
      await mkdir(cacheDir, { recursive: true })
      const payload = {
        version: 2,
        fetchedAt: snapshot.meta.fetchedAt,
        albums: snapshot.albums,
        genres: snapshot.genres,
        meta: snapshot.meta,
      }
      await writeFile(libraryFile, JSON.stringify(payload), 'utf8')
    } catch {
      // 缓存写入失败不影响主流程
    }
  }

  function publicLibrary(snapshot) {
    return { albums: snapshot.albums, genres: snapshot.genres, meta: snapshot.meta }
  }

  function emptyLibrary(error) {
    return {
      albums: [],
      genres: [{ id: NETEASE_GENRE.id, name: NETEASE_GENRE.name }],
      meta: { playlists: 0, likedTracks: 0, fetchedAt: null },
      error,
    }
  }

  async function loadLibrary(force) {
    if (!force && libraryCache && Date.now() - libraryCache.at < LIBRARY_TTL) return publicLibrary(libraryCache)
    if (!force && failureFresh(libraryFailure)) return emptyLibrary(libraryFailure.error)
    if (!force) {
      const disk = await readDiskCache()
      if (disk) {
        libraryCache = disk
        return publicLibrary(libraryCache)
      }
    }
    try {
      const built = await buildLibrary()
      libraryCache = { albums: built.albums, genres: built.genres, meta: built.meta, at: Date.now() }
      libraryFailure = null
      await writeDiskCache(libraryCache)
      return publicLibrary(libraryCache)
    } catch (error) {
      libraryCache = null
      libraryFailure = { error: errorText(error), at: Date.now() }
      return emptyLibrary(libraryFailure.error)
    }
  }

  async function status() {
    const result = {
      enabled: false,
      loggedIn: false,
      nickname: null,
      userId: null,
      playlistCount: null,
      source: null,
      fetchedAt: null,
    }
    try {
      const cookieState = await ensureCookie(false)
      result.enabled = true
      result.source = cookieState.source
    } catch (error) {
      result.error = errorText(error)
      return result
    }
    try {
      const profile = await fetchAccount(false)
      result.loggedIn = true
      result.nickname = profile.nickname
      result.userId = profile.id
      result.fetchedAt = profile.fetchedAt
      try {
        const list = await fetchPlaylists(false)
        result.playlistCount = list.length
      } catch (error) {
        result.error = errorText(error)
      }
    } catch (error) {
      result.error = errorText(error)
    }
    return result
  }

  async function getSongUrl(songId, force) {
    const cached = songUrlCache.get(songId)
    if (!force && cached && cached.expiresAt > Date.now()) return cached.url
    const { json } = await requestJson(
      '/api/song/enhance/player/url?ids=' + encodeURIComponent('[' + songId + ']') + '&br=320000',
      '播放地址'
    )
    const item = json && json.data && json.data[0]
    if (!item || item.code !== 200 || !item.url) {
      throw Object.assign(new Error('该歌曲暂无可播放地址（可能受版权、付费或 VIP 限制）'), { status: 502 })
    }
    const url = String(item.url)
    const expireSeconds = Number(item.expi) > 0 ? Number(item.expi) : 1200
    songUrlCache.set(songId, { url, expiresAt: Date.now() + Math.min(SONG_URL_TTL, expireSeconds * 1000) })
    return url
  }

  async function cdnFetch(url, rangeHeader) {
    const headers = { 'user-agent': UA_CLIENT, referer: API_REFERER, accept: '*/*' }
    if (rangeHeader) headers.range = rangeHeader
    let response
    try {
      response = await fetch(url, { headers, signal: AbortSignal.timeout(CDN_TIMEOUT) })
    } catch (error) {
      throw Object.assign(new Error('音频 CDN 请求失败（' + networkReason(error) + '）'), { status: 502 })
    }
    return response
  }

  function invalidateAuth() {
    cookie = null
    cookieFailure = null
    account = null
    accountFailure = null
    songUrlCache.clear()
  }

  async function openAudio(songId, rangeHeader) {
    const id = String(songId || '')
    if (!/^\d{1,20}$/.test(id)) throw Object.assign(new Error('歌曲 ID 无效'), { status: 400 })
    let lastError = null
    for (let attempt = 0; attempt < 2; attempt += 1) {
      try {
        const url = await getSongUrl(id, attempt > 0)
        const response = await cdnFetch(url, rangeHeader)
        if ((response.status === 401 || response.status === 403) && attempt === 0) {
          try {
            if (response.body) await response.body.cancel()
          } catch {
            // 忽略取消错误
          }
          songUrlCache.delete(id)
          invalidateAuth()
          continue
        }
        if (!response.body) throw Object.assign(new Error('音频 CDN 未返回响应体'), { status: 502 })
        return {
          status: response.status,
          headers: pickUpstreamHeaders(response),
          body: Readable.fromWeb(response.body),
        }
      } catch (error) {
        lastError = error
        if (attempt === 0) {
          invalidateAuth()
          await sleep(120)
          continue
        }
      }
    }
    throw lastError && lastError.status ? lastError : Object.assign(new Error(errorText(lastError)), { status: 502 })
  }

  async function lyric(songId) {
    const id = String(songId || '')
    if (!/^\d{1,20}$/.test(id)) return { found: false, text: '' }
    let json = null
    try {
      const response = await requestJson('/api/song/lyric?id=' + id + '&lv=1&kv=1&tv=1', '歌词')
      json = response.json
    } catch {
      return { found: false, text: '' }
    }
    if (!json) return { found: false, text: '' }
    const lrc = json.lrc && typeof json.lrc.lyric === 'string' ? json.lrc.lyric.trim() : ''
    const translated = json.tlyric && typeof json.tlyric.lyric === 'string' ? json.tlyric.lyric.trim() : ''
    if (!lrc && !translated) return { found: false, text: '' }
    const text = lrc && translated ? mergeLyrics(lrc, translated) : lrc || translated
    return { found: !!text, text }
  }

  async function cover(rawUrl) {
    const target = parseCoverUrl(rawUrl)
    let response
    try {
      response = await fetch(target, {
        headers: { 'user-agent': UA_BROWSER, referer: API_REFERER, accept: 'image/*,*/*' },
        signal: AbortSignal.timeout(REQUEST_TIMEOUT),
        redirect: 'follow',
      })
    } catch (error) {
      throw Object.assign(new Error('封面 CDN 请求失败（' + networkReason(error) + '）'), { status: 502 })
    }
    let finalHost = ''
    try {
      finalHost = new URL(response.url).hostname
    } catch {
      finalHost = ''
    }
    if (!isAllowedCoverHost(finalHost)) {
      try {
        if (response.body) await response.body.cancel()
      } catch {
        // ignore
      }
      throw Object.assign(new Error('封面 CDN 重定向到了白名单外的地址'), { status: 502 })
    }
    if (!response.body) throw Object.assign(new Error('封面 CDN 未返回响应体'), { status: 502 })
    return {
      status: response.status,
      headers: pickUpstreamHeaders(response),
      body: Readable.fromWeb(response.body),
    }
  }

  async function refresh() {
    cookie = null
    cookieFailure = null
    account = null
    accountFailure = null
    playlists = null
    playlistsFailure = null
    libraryCache = null
    libraryFailure = null
    songUrlCache.clear()
    const library = await loadLibrary(true)
    const current = await status()
    return { ok: !library.error, error: library.error, meta: library.meta, status: current }
  }

  return { status, library: () => loadLibrary(false), openAudio, lyric, cover, refresh, search }
}
