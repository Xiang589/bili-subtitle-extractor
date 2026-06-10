# v0.2-alpha：本地 ASR 扩展

`v0.2-alpha` 新增一个 Chrome Extension Manifest V3 原型：当当前 Bilibili 视频没有字幕轨时，用户可以主动点击扩展“开始录音”，扩展只录制当前活动标签页的音频，停止后把录音发送到本机 `127.0.0.1:8765` 的 FastAPI ASR 服务，并下载 Markdown / TXT / SRT / JSON 字幕文档。

这不是视频下载器。扩展不下载 Bilibili 视频、不解析 Bilibili 真实音视频流、不录制麦克风、不录制系统其他声音、不录制视频画面，也不绕过登录、会员、付费、地区或权限限制。

## 目录

```text
extension/
  manifest.json
  popup.html
  popup.js
  service_worker.js
  offscreen.html
  offscreen.js
  icons/

local-asr-service/
  app.py
  asr.py
  export.py
  requirements.txt
  README.md
```

## Chrome 扩展加载

1. 打开 `chrome://extensions`
2. 开启开发者模式
3. 点击“加载已解压的扩展程序”
4. 选择仓库里的 `extension/` 目录
5. 打开 Bilibili 视频页
6. 点击扩展图标
7. 确认本地服务状态为“已启动”
8. 选择导出格式
9. 点击“开始录音”
10. 用户播放视频，完成后点击“停止”

录制由用户主动开始和停止。popup 关闭后，offscreen document 会继续持有 `MediaRecorder`，录音不会因为 popup 关闭而中断。

扩展要求 Chrome 116+。默认最大录音时长为 10 分钟，达到上限后会自动停止录制并继续走上传和下载流程。

## 本地服务启动

```bash
cd local-asr-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765
```

健康检查：

```bash
curl http://127.0.0.1:8765/health
```

## Mock 模式测试

mock 模式不加载模型，不下载模型文件，直接返回固定 segments。

```bash
cd local-asr-service
$env:ASR_MOCK=1
uvicorn app:app --host 127.0.0.1 --port 8765
```

也可以：

```bash
python app.py --mock
```

然后加载扩展，打开任意 Bilibili 视频页，录制几秒并停止，预期会下载所选格式的字幕文档。

## 本地转写配置

默认：

```bash
ASR_MODEL=base
ASR_DEVICE=cpu
ASR_COMPUTE_TYPE=int8
```

默认最大上传体积为 200MB，可通过 `ASR_MAX_UPLOAD_MB` 调整：

```bash
$env:ASR_MAX_UPLOAD_MB="300"
```

可设置为：

```bash
$env:ASR_MODEL="small"
$env:ASR_DEVICE="cpu"
$env:ASR_COMPUTE_TYPE="int8"
```

## 导出格式

- Markdown：包含标题、来源、方式、原始链接、语言和带时间段的字幕正文。
- TXT：每行一条纯字幕。
- SRT：标准序号和 `00:00:00,000 --> 00:00:03,500` 时间格式。
- JSON：包含 `source/title/url/language/segments`。

## 临时文件和清理

扩展录音默认只保存在浏览器内存中，停止后上传到本机 ASR 服务。

本地服务会临时写入：

```text
local-asr-service/tmp/uploads/
```

默认请求结束后删除临时录音。设置 `ASR_KEEP_FILES=1` 时会保留录音用于调试。清理方式：

```bash
Remove-Item -Recurse -Force local-asr-service\tmp
```

## 隐私和合规

- 录音和转写都在本地完成。
- 扩展只访问 `http://127.0.0.1:*/*` 和 `http://localhost:*/*` 作为转写服务。
- 不上传到任何云端。
- 不保存 Cookie、token、字幕或音频到远端。
- 不下载 Bilibili 视频。
- 不录麦克风，不录系统其他声音，不录视频画面。
- 仅供个人学习、研究、笔记整理。
- 使用者应遵守 Bilibili 平台规则和版权要求。
