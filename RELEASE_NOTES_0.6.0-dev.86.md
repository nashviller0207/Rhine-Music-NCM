# 发行说明 · 0.6.0-dev.86（社区定制版）

本版本基于 [Bong712/Rhine-Music-Windows](https://github.com/Bong712/Rhine-Music-Windows) 继续开发，新增网易云音乐相关能力与专辑详情动画。

## 新增 / 调整

- **专辑卡翻面**：详情页只保留一张专辑卡。点击专辑里的单曲后，专辑卡旋转 180° 翻到反面展示该单曲封面；切换单曲再翻 180° 换上新封面；右键返回时再翻一次展示专辑封面，然后放回专辑架。
- 打开专辑详情时始终先显示专辑封面（正面）；只有点击单曲才会翻面。
- 单曲切换不再移动镜头或更换架子，全部在同一张专辑卡上完成。
- 网易云音乐账号接入、在线搜索、在线单曲架、内嵌同步歌词、默认封面等既有功能。
- 移除启动进场动画；搜索按 Enter 才进入单曲架。
- 修复专辑详情曲目列表不显示歌名/歌手的问题。

## 上游与署名

- 三维档案界面与动效基础：[@路北路陈（LBEILC）/ RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）
- UI 概念参考：[Ronald没有魔杖 · Bilibili BV1XBaK6pECN](https://www.bilibili.com/video/BV1XBaK6pECN/?spm_id_from=333.1387.homepage.video_card.click&vd_source=da40ab32db7ab4df771e94bfea6163b3)
- 音乐与界面源项目：[RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo)（MIT）
- Windows 移植与打包：[Bong712/Rhine-Music-Windows](https://github.com/Bong712/Rhine-Music-Windows)（MIT）
