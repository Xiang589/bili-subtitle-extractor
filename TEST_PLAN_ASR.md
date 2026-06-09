# TEST_PLAN_ASR

以下为 `v0.2-alpha` 手动测试计划。测试前请加载 `extension/` 扩展，并准备 `local-asr-service`。

## 1. 本地服务未启动

1. 确保 `127.0.0.1:8765` 没有服务运行。
2. 打开 Bilibili 视频页。
3. 点击扩展图标。
4. 预期：popup 显示本地服务未启动，并提示“请先启动本地 ASR 服务”。
5. 预期：“开始录音”按钮不可用或点击后给出友好提示。

## 2. 服务启动

1. 启动本地服务：

   ```bash
   cd local-asr-service
   $env:ASR_MOCK=1
   uvicorn app:app --host 127.0.0.1 --port 8765
   ```

2. 打开 `http://127.0.0.1:8765/health`。
3. 预期：返回 JSON，且 `ok` 为 `true`。
4. 预期：popup 显示本地服务已启动。

## 3. B 站视频页录制 10 秒

1. 打开一个 Bilibili 视频页。
2. 在 popup 中选择 `md`。
3. 点击“开始录音”。
4. 播放视频约 10 秒。
5. 点击“停止”。
6. 预期：扩展上传录音到 `/transcribe`。
7. 预期：浏览器下载 Markdown 字幕文档。

## 4. popup 关闭后录制不中断

1. 打开 popup 并点击“开始录音”。
2. 关闭 popup。
3. 继续播放视频 10 秒。
4. 再次打开 popup。
5. 预期：仍显示录制中，计时继续增长。
6. 点击“停止”。
7. 预期：仍能上传并下载结果。

## 5. 停止录制后音频轨道释放

1. 开始录制并停止。
2. 打开 Chrome 扩展调试页面查看 offscreen document 控制台。
3. 预期：停止后 tabCapture 的音频轨道被 `stop()` 释放。
4. 预期：可再次开始录制，不会出现已有录音流占用错误。

## 6. SRT 导出

1. 在 popup 中选择 `srt`。
2. 使用 mock 模式录制并停止。
3. 预期：下载的 SRT 文件序号递增。
4. 预期：时间戳格式为 `00:00:00,000 --> 00:00:03,500`。
5. 预期：条目间有空行。

## 7. mock 模式可跑通

1. 设置 `ASR_MOCK=1`。
2. 启动 `uvicorn app:app --host 127.0.0.1 --port 8765`。
3. 录制几秒并停止。
4. 预期：无需下载 faster-whisper 模型即可下载字幕文档。

## 8. 检查没有请求任何非 localhost 的 ASR 服务

1. 打开扩展源码。
2. 搜索 `http://` 和 `https://`。
3. 预期：转写请求只指向 `http://127.0.0.1:8765/transcribe`。
4. 预期：manifest 只允许 `http://127.0.0.1:*/*` 和 `http://localhost:*/*` 作为服务访问范围。

## 9. 确认没有下载 B 站视频

1. 录制期间打开 Chrome DevTools 网络面板。
2. 预期：扩展不请求 Bilibili 音视频流地址。
3. 预期：扩展只使用 `tabCapture` 捕获当前标签页音频。

## 10. 确认不录麦克风

1. 检查 `extension/offscreen.js`。
2. 预期：`getUserMedia` 使用 `chromeMediaSource: 'tab'`。
3. 预期：`video: false`，没有麦克风或系统音频约束。
4. 录制时对麦克风说话，预期不会进入转写结果。
