# 界面维护说明

界面参考 [星梦幽灵的小窝](https://xmyl-153.github.io/xingmengyouling-blog/) 的模糊背景、玻璃卡片、资料与音乐双栏、音乐下方歌词条及拼贴内容区域。首页歌词条现已扩展为紧凑的黑金红演出舞台，并参考 [YouRanCoder/LimbusLyricSimulator](https://github.com/YouRanCoder/LimbusLyricSimulator) 的同步、残影和双语呈现行为。

参考范围仅为布局和设计行为，本站使用自己的 HTML/CSS/JavaScript 实现；没有复制 GPL-3.0 桌面项目代码，相关致谢保留在 README。个人资料、文章、相册、说说与歌单仍来自本站内容。

## 首页音乐与歌词舞台

舞台位于音乐卡下方，默认保持紧凑。播放歌曲后直接跟随同一个 MikuMusic 音频时钟，舞台自身不创建第二个播放器。

主句以大号衬线字体呈现，译文较小；同时间戳内容配对显示。象牙白文字、暗金细节和黑色底构成基础，红色用于切句的短促斩痕。逐字入场与旧句淡出服务于歌词节奏，不用动画计时替代真实播放进度。

暂停、恢复、seek 和切歌都应重新以当前音频时间定位。切歌或歌词结果更新时，旧句和旧残影不能覆盖新歌曲。加载中、无时间轴歌词与请求失败显示不同状态；失败提供显式重试。

「动效」开关和系统 reduced motion 偏好会关闭或减弱动态效果，歌词仍完整可读。「沉浸演出」仅展开同一舞台，收起后回到首页，歌曲继续播放。独立实验室页面及导航入口移除。

## 修改位置

| 内容 | 文件 |
| --- | --- |
| 首页布局、舞台位置、个人介绍与入口 | index.html，舞台节点 #home-lyric-stage |
| 同步定位、双语分组、状态、重试和沉浸展开 | js/lyric-stage.js |
| 舞台字体、黑金红视觉、逐字/残影/斩击、手机及 reduced motion | css/lyric-stage.css |
| 当前歌曲、时间轴歌词与真实音频时钟 | js/music.js |
| 全站视觉、深浅主题和手机布局 | css/garden.css |
| 图标、主题卡、首页数据与组件延迟加载 | js/garden.js |
| Miku 值班室、听歌房与日语角色短句 | js/miku-host.js、js/miku-voice.js、css/miku-host.css |
| 文章源稿与模板 | _posts/*.md、tools/build.py 的 POST_TEMPLATE |
| 收藏图片、背景与来源 | assets/gallery/、assets/night-sky.webp、assets/CREDITS.md |

css/style.css 保留播放器、写作台等基础组件样式，garden.css 统一外观；歌词舞台样式独立维护。所有页面和文章模板使用相同资源引用，PJAX 换页时要清理舞台订阅与动画，返回首页后重新接入当前播放状态。

## 图片、性能与验证

- 夜景素材与页脚署名见 assets/CREDITS.md；首页收藏图复用本站已有资源。
- Live2D 按需加载；歌单封面仅按可视行加载，避免批量请求争用音频所在域的连接。播放/暂停只更新现有状态，不重建 107 条歌单节点；歌词演出与歌单共享播放器。
- 舞台只在当前句或播放状态变化时更新结构；帧级时间只更新进度和必要的动画状态。
- 手机上保留清晰的歌词换行和可操作按钮，沉浸模式需支持返回、焦点恢复及视口内布局。
- 本轮已发布提交 d0452892574e90b243b780b73c909dfacf952521，[Actions](https://github.com/CidneyAurum/CidneyAurum.github.io/actions/runs/40176783139) 的 build/deploy 成功，205 项检查通过；正式域名原生歌曲与 38 行 LRC 同步、暂停和沉浸/Escape 已实测，详见 [功能验收](functional-acceptance.md)。
- 独立本机单次播放测试观察到 2.19 秒起播，仅代表该次环境，不作为公网用户的时延保证。

开发预览可运行 python -m http.server 8000。构建文章使用 python tools/build.py，生成的 posts/*.html 不单独维护。
