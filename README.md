# bili-subtitle-extractor

一个本地优先的 Bilibili 字幕工具项目。

- `v0.1.1`：Tampermonkey/油猴脚本，提取当前视频已经存在的字幕轨。
- `v0.2-alpha`：Chrome 扩展原型，录制当前标签页音频并发送到本机 ASR 服务生成字幕文档。

本项目不是视频下载器。它不下载 Bilibili 视频、不解析 Bilibili 真实音视频流、不绕过登录、会员、付费、地区或权限限制，仅供个人学习、研究、笔记整理。

## v0.1.1：油猴字幕提取

`bili-subtitle-extractor.user.js` 是单文件 userscript，无 npm 依赖、无构建系统，可直接安装。

安装脚本直链：

```text
https://raw.githubusercontent.com/Xiang589/bili-subtitle-extractor/master/bili-subtitle-extractor.user.js?v=0.1.1
```

### 功能列表

- 在 Bilibili 视频页右下角显示“提取字幕”按钮。
- 注册 Tampermonkey 菜单命令“提取当前 B 站字幕”。
- 自动识别当前视频 BV 号和分 P。
- 优先读取页面内的 `__INITIAL_STATE__`，必要时调用 Bilibili 视频信息接口获取 aid/cid/分 P 信息。
- 读取当前分 P 的已有字幕轨，并按“中文简体 > 中文 > AI 中文 > 第一个可用轨道”选择字幕。
- 支持导出 Markdown、TXT、SRT、JSON，默认 Markdown。
- 使用浏览器 Blob 在本地下载文件，不上传任何数据。

### 安装方法

1. 安装 Tampermonkey 或其他兼容 userscript 的浏览器扩展。
2. 新建脚本，将 `bili-subtitle-extractor.user.js` 的内容粘贴进去并保存。
3. 也可以打开上方 raw 直链，由 Tampermonkey 直接安装。

### 使用方法

1. 打开 `https://www.bilibili.com/video/*` 格式的视频页。
2. 点击页面右下角“提取字幕”，或在 Tampermonkey 菜单中点击“提取当前 B 站字幕”。
3. 如检测到多个字幕轨，可按提示输入序号选择。
4. 按提示选择导出格式：`md`、`txt`、`srt`、`json`，直接回车默认导出 `md`。
5. 文件会在浏览器中本地下载，文件名格式为 `视频标题_BV号_P1.md`。

## v0.2-alpha：本地 ASR 扩展

当当前 Bilibili 视频没有字幕轨时，可以加载 `extension/` Chrome 扩展。用户主动点击“开始录音”后，扩展只捕获当前活动标签页的音频；用户主动点击“停止”后，扩展把录音发送到本机 `127.0.0.1:8765` 的 ASR 服务，并下载字幕文档。

录音和转写都在本地完成。扩展不录麦克风、不录系统其他声音、不录视频画面，不访问除 `localhost/127.0.0.1` 以外的转写服务。

详细说明见 [README_ASR.md](README_ASR.md) 和 [local-asr-service/README.md](local-asr-service/README.md)。

### Chrome 扩展安装

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 点击“加载已解压的扩展程序”
4. 选择 `extension/` 目录
5. 打开 Bilibili 视频页
6. 点击扩展图标开始录音

### 本地 ASR 服务启动

```bash
cd local-asr-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765
```

mock 模式：

```bash
cd local-asr-service
$env:ASR_MOCK=1
uvicorn app:app --host 127.0.0.1 --port 8765
```

## 导出格式

- Markdown：包含标题、来源、方式、原始链接、语言和带时间段的字幕正文。
- TXT：每行一条纯字幕。
- SRT：标准序号和 `00:00:00,000 --> 00:00:03,500` 时间格式。
- JSON：包含结构化元数据和字幕 segments。

## 常见问题

**会下载视频吗？**

不会。本项目不下载视频、不读取或解析 Bilibili 真实音视频流。`v0.2-alpha` 只录制用户当前正在播放的活动标签页音频。

**会录麦克风吗？**

不会。Chrome 扩展使用 `tabCapture` 和 offscreen document，只捕获当前活动标签页音频。

**会上传到云端吗？**

不会。录音只发送到本机 `127.0.0.1:8765` 或 `localhost` 的 ASR 服务，不访问云端 ASR 服务。

**需要登录、会员、付费或地区权限怎么办？**

本项目不会绕过任何权限限制。油猴脚本默认不发送 Cookie；扩展也不会读取 Cookie 或破解访问限制。

## 隐私说明

- 只处理用户当前主动打开的视频页或当前活动标签页。
- 不批量抓取。
- 不下载视频。
- 不上传 Cookie。
- 不上传字幕、音频或视频到远端。
- 不保存 Cookie、token、密钥或浏览器配置。
- 本地 ASR 服务会临时写入 `local-asr-service/tmp/uploads/`，默认请求结束后删除；设置 `ASR_KEEP_FILES=1` 时会保留，清理方式是删除 `local-asr-service/tmp/`。

## 合规说明

本项目仅供个人学习、研究、笔记整理。使用者应遵守 Bilibili 平台规则和版权要求。

脚本和扩展都不绕过登录、付费、会员、地区或权限限制，也不提供云端服务、批量抓取或视频下载能力。

## Roadmap

- v0.1：提取当前视频已有字幕
- v0.1.1：修复 SPA 旧状态和权限字幕提示
- v0.2-alpha：Chrome 扩展录制当前标签页音频并接入本地 ASR
- v0.2：优化多字幕轨选择和 ASR 原型体验
- v0.3：支持当前视频多 P 字幕逐个导出，仍需用户主动触发
- v0.4：Chrome 扩展版稳定化
- v0.5：本地视觉识别服务，用于字幕 + 视频画面内容提取

## License

MIT License. See [LICENSE](LICENSE).
