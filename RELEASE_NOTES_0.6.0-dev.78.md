# 发行说明 · 0.6.0-dev.78（社区定制版）

本版本基于 [Bong712/Rhine-Music-Windows](https://github.com/Bong712/Rhine-Music-Windows) 继续开发，新增网易云音乐相关能力与专辑详情动画。

## 新增

- **单曲收放动画**：在专辑详情中切换单曲时，当前播放的 3D 卡片先滑回专辑架槽位，在架内换成新单曲封面，再被抽出到详情位置（约 2 秒），像把旧光盘插回去、再抽出一张新的。
- 网易云音乐账号接入：读取本机网易云客户端登录态，把「我喜欢的音乐」与全部歌单映射为三维专辑架卡片，并与本地曲库合并。
- 网易云在线搜索：搜索面板同时展示本地与在线结果，自动补全封面、歌手、专辑和时长。
- 在线单曲架：搜索后按 Enter 将结果铺成单曲架（每首歌一张卡片），支持滚轮选曲、点击/Enter 打开、右键退出。
- 专辑详情内嵌同步歌词：固定标题/歌手，居中大字，隐藏滚动条，底部留白。
- 默认封面：无封面或加载失败时使用内置图片，不再显示“暂无专辑封面”。

## 调整

- 播放单曲时封面跟随单曲切换（现为收放动画）。
- 移除启动进场动画，启动后直接落在专辑架。
- 搜索输入不再自动跳转，需按 Enter 才进入单曲架。
- 修复专辑详情曲目列表因样式表污染导致歌名/歌手不显示的问题。

## 上游与署名

- 三维档案界面与动效基础：[@路北路陈（LBEILC）/ RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）
- UI 概念参考：[Ronald没有魔杖 · Bilibili BV1XBaK6pECN](https://www.bilibili.com/video/BV1XBaK6pECN/?spm_id_from=333.1387.homepage.video_card.click&vd_source=da40ab32db7ab4df771e94bfea6163b3)
- 音乐与界面源项目：[RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo)（MIT）
- Windows 移植与打包：[Bong712/Rhine-Music-Windows](https://github.com/Bong712/Rhine-Music-Windows)（MIT）

完整许可与素材边界见 [NOTICE.md](NOTICE.md)、[THIRD-PARTY-NOTICES.md](THIRD-PARTY-NOTICES.md) 与 [LICENSE](LICENSE)。
