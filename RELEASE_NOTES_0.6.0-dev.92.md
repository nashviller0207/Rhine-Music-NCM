# 发行说明 · 0.6.0-dev.92（社区定制版）

本版本基于 [Bong712/Rhine-Music-Windows](https://github.com/Bong712/Rhine-Music-Windows) 继续开发，在原有三维音乐档案界面与本地播放的基础上，接入网易云音乐账号能力。非网易官方产品。

## 新增

- **网易云连接状态提示**：右下角新增一个不显眼的小状态条，显示「已连接 / 未登录 / 未连接」；鼠标悬停可看账号昵称、歌单数量和具体失败原因，点击可重新检测。
- **「设置 → 开发与资源」署名更新**：技术支持 **Bong712**，Windows 版开发 / 网易云定制 **Nashviller0207**，并列出本定制版新增的能力。

## 调整与优化

- 搜索进入在线单曲架改为「新架子在可视范围外生成后短距离滑入原列」，不再做长距离横移，减少卡顿。
- 封面图集改为分帧绘制，避免换架时单帧长时间冻结。
- README / NOTICE 补充本定制版的开发署名与工作范围；MIT 与上游署名保持不变。

## 上游与署名

- 三维档案界面与动效基础：[@路北路陈（LBEILC）/ RhineLabUI](https://github.com/LBEILC/RhineLabUI)（MIT）
- UI 概念参考：[Ronald没有魔杖 · Bilibili BV1XBaK6pECN](https://www.bilibili.com/video/BV1XBaK6pECN/?spm_id_from=333.1387.homepage.video_card.click&vd_source=da40ab32db7ab4df771e94bfea6163b3)
- 音乐与界面源项目：[RonaldDeng/Rhine-Music-Demo](https://github.com/RonaldDeng/Rhine-Music-Demo)（MIT）
- Windows 移植与打包（技术支持）：[Bong712/Rhine-Music-Windows](https://github.com/Bong712/Rhine-Music-Windows)（MIT）
- 本定制版开发：[@Nashviller0207](https://github.com/Nashviller0207)

本定制版新增：网易云账号歌单与「我喜欢的音乐」接入、在线搜索与单曲架、专辑详情内嵌同步歌词、单曲封面切换、专辑卡翻面与架子滑入动画、网易云连接状态提示等。
