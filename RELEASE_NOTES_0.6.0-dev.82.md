# 发行说明 · 0.6.0-dev.82（社区定制版）

本版本基于 [Bong712/Rhine-Music-Windows](https://github.com/Bong712/Rhine-Music-Windows) 继续开发，新增网易云音乐相关能力与专辑详情动画。

## 新增

- **退出详情的收放流程**：右键从单曲详情返回专辑架时，当前单曲的唱片会带着自己的封面先滑回架位，随后镜头拉回专辑架，卡片换回专辑封面并回到预览位置。
- **单曲交换动画（镜头换位）**：切换单曲时旧唱片先回架，镜头平移到相邻架位，新唱片从该架位竖直抽出。
- 网易云音乐账号接入、在线搜索、在线单曲架、内嵌同步歌词、默认封面等既有功能。

## 调整

- 播放单曲时封面跟随单曲切换（双碟交换 + 镜头换位）。
- 移除启动进场动画，启动后直接落在专辑架。
- 搜索输入不再自动跳转，需按 Enter 才进入单曲架。
- 修复专辑详情曲目列表不显示歌名/歌手的问题。

## 上游与署名

- 三维档案界面与动效基础：[@路北路陈（LBEILC）/ RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）
- UI 概念参考：[Ronald没有魔杖 · Bilibili BV1XBaK6pECN](https://www.bilibili.com/video/BV1XBaK6pECN/?spm_id_from=333.1387.homepage.video_card.click&vd_source=da40ab32db7ab4df771e94bfea6163b3)
- 音乐与界面源项目：[RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo)（MIT）
- Windows 移植与打包：[Bong712/Rhine-Music-Windows](https://github.com/Bong712/Rhine-Music-Windows)（MIT）
