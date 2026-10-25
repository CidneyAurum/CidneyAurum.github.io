# 界面维护说明

本次界面以 [星梦幽灵的小窝](https://xmyl-153.github.io/xingmengyouling-blog/) 为视觉参考：模糊背景、玻璃卡片、资料与音乐双栏、格言条和拼贴式内容区域。使用本站自己的 HTML/CSS/JavaScript 实现，个人资料、文章、相册、说说和音乐仍来自本站原有内容。

## 本地预览

在仓库根目录运行 `python -m http.server 8000`，访问 `http://localhost:8000/`。站点动态列表使用 fetch，不能用双击 HTML 的方式完整预览。

## 修改位置

| 内容 | 文件 |
| --- | --- |
| 首页布局、个人介绍、栏目入口 | `index.html` |
| 新版全站视觉、深浅主题、手机布局 | `css/garden.css` |
| 图标、主题卡、说说预览、看板娘按需加载 | `js/garden.js` |
| Miku 值班室、导览、听歌房与日语短语音 | `js/miku-host.js`、`js/miku-voice.js`、`css/miku-host.css` |
| 文章源稿 | `_posts/*.md` |
| 新文章的导航、页脚与页面模板 | `tools/build.py` 中的 `POST_TEMPLATE` |
| 收藏图片 | `assets/gallery/` |
| 背景图片及来源 | `assets/night-sky.webp`、`assets/CREDITS.md` |

`css/style.css` 保留原有播放器、模拟器、写作台等功能组件样式，`garden.css` 在其后加载并统一外观。所有页面与文章模板都需要引用同一份新版 CSS/JS，避免无刷新换页后样式不一致。

相册数量、文章数量、亮灯天数及首页说说预览从现有数据计算。首页目前显示最新文章和其他文章列表；后续发文无需手工修改首页。

## 图片与性能

- 夜景为网上现有素材，来源及署名见 `assets/CREDITS.md`，页脚保留可见来源链接。
- `assets/collection.webp` 由本站已有的 `assets/background.png` 转换而来，保留原图；首页文章封面复用头像 WebP。
- 看板娘首次点击猫形按钮时才加载，模型与原有聊天功能保留。
- 歌单封面延迟加载；选择歌曲后才展开全站播放条，换页后继续保留。
- 减少动态效果的系统偏好会关闭过渡；键盘可操作菜单、搜索、歌单及主题卡。

构建文章请运行 `python tools/build.py`。生成的 `posts/*.html` 不应单独维护，下次构建会被模板覆盖。
