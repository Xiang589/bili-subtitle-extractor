# 本地 ASR 服务

这是 `bili-subtitle-extractor` v0.2-alpha 的本机转写服务。Chrome 扩展会把当前标签页录制得到的 `webm/opus` 音频发送到 `http://127.0.0.1:8765/transcribe`，服务在本机使用 `faster-whisper` 转写并返回 Markdown / TXT / SRT / JSON 文档内容。

Chrome 扩展要求 Chrome 116+。扩展默认最大录音时长为 10 分钟。

## 启动

```bash
cd local-asr-service
python -m venv .venv
.venv\Scripts\activate
pip install -r requirements.txt
uvicorn app:app --host 127.0.0.1 --port 8765
```

打开健康检查：

```bash
curl http://127.0.0.1:8765/health
```

## Mock 模式

mock 模式不加载 `faster-whisper`，直接返回固定测试字幕，适合先测试 Chrome 扩展录音、上传和下载流程。

```bash
cd local-asr-service
$env:ASR_MOCK=1
uvicorn app:app --host 127.0.0.1 --port 8765
```

也可以直接运行：

```bash
python app.py --mock
```

## 模型配置

默认配置：

```bash
ASR_MODEL=base
ASR_DEVICE=cpu
ASR_COMPUTE_TYPE=int8
```

可按机器性能调整：

```bash
$env:ASR_MODEL="small"
$env:ASR_DEVICE="cpu"
$env:ASR_COMPUTE_TYPE="int8"
uvicorn app:app --host 127.0.0.1 --port 8765
```

首次使用真实模型时，`faster-whisper` 可能需要下载模型文件到本机缓存目录。

## 上传限制

默认最大上传体积为 200MB。可以通过环境变量调整：

```bash
$env:ASR_MAX_UPLOAD_MB="300"
uvicorn app:app --host 127.0.0.1 --port 8765
```

超过限制时，服务会返回 HTTP 413 和友好错误信息。

## 临时文件

服务会把浏览器上传的录音临时写入：

```text
local-asr-service/tmp/uploads/
```

默认请求结束后会删除临时录音。若设置 `ASR_KEEP_FILES=1`，服务会保留录音文件，方便调试；清理方式是删除 `local-asr-service/tmp/` 目录。

## 隐私和边界

- 只接收浏览器扩展上传到本机 `127.0.0.1` 的音频。
- 不访问云端 ASR 服务。
- 不保存 Cookie、token 或浏览器配置。
- 不下载 Bilibili 视频，不解析 Bilibili 真实音视频流。
- 不绕过登录、会员、付费、地区或权限限制。
