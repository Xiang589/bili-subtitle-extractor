'use strict';

const ASR_ENDPOINT = 'http://127.0.0.1:8765/transcribe';
const DEFAULT_LANGUAGE = 'zh';
const DEFAULT_FORMAT = 'md';
const RECORDING_FILE_NAME = 'tab-audio.webm';
const ACTIVE_STREAM_ERROR = '当前标签页已有未释放的录音流。请点击重置状态，或刷新扩展/重新打开标签页后重试。';
const STATES = new Set(['idle', 'starting', 'recording', 'stopping', 'uploading', 'done', 'error']);
const STARTABLE_STATES = new Set(['idle', 'done', 'error']);

let recorderState = 'idle';
let state = createState('idle');

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch(async (error) => {
      await failRecorder(error.message || '操作失败。');
      sendResponse({ ok: false, error: state.error, state: getStateSnapshot() });
    });
  return true;
});

async function handleMessage(message) {
  if (!message || !message.type) {
    throw new Error('未知消息。');
  }

  if (message.type === 'getState' || message.type === 'GET_STATUS') {
    return { ok: true, state: getStateSnapshot() };
  }

  if (message.type === 'startRecording' || message.type === 'START_RECORDING') {
    return startRecording(message);
  }

  if (message.type === 'stopRecording' || message.type === 'STOP_RECORDING') {
    return stopRecording();
  }

  if (message.type === 'resetRecording') {
    return resetRecording();
  }

  if (message.type === 'offscreenRecordingStopped') {
    await handleRecordedData(message.recording || message);
    return { ok: true, state: getStateSnapshot() };
  }

  if (message.type === 'offscreenRecordingError') {
    await failRecorder(message.error || '录音失败。');
    return { ok: true, state: getStateSnapshot() };
  }

  throw new Error(`未支持的消息：${message.type}`);
}

async function startRecording(message) {
  if (!STARTABLE_STATES.has(recorderState)) {
    return {
      ok: false,
      error: '已有录音任务正在进行，请先停止或重置状态。',
      state: getStateSnapshot()
    };
  }

  if (recorderState === 'error') {
    await cleanupOffscreen();
  }

  const activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) {
    return failResponse('无法读取当前活动标签页。');
  }

  setRecorderState('starting', {
    error: '',
    startedAt: null,
    tabId: activeTab.id,
    title: activeTab.title || 'Bilibili 本地 ASR',
    sourceUrl: activeTab.url || '',
    format: normalizeFormat(message.format),
    language: message.language || DEFAULT_LANGUAGE
  });

  try {
    await ensureOffscreenDocument();
    const streamId = await getMediaStreamId(activeTab.id);
    const response = await chrome.runtime.sendMessage({
      type: 'offscreenStartRecording',
      streamId
    });

    if (!response || !response.ok) {
      throw new Error((response && response.error) || '启动录音失败。');
    }

    setRecorderState('recording', {
      error: '',
      startedAt: response.startedAt || Date.now()
    });
    return { ok: true, state: getStateSnapshot() };
  } catch (error) {
    await cleanupOffscreen();
    return failResponse(toFriendlyCaptureError(error));
  }
}

async function stopRecording() {
  if (recorderState !== 'recording') {
    return {
      ok: false,
      error: '当前没有正在录制的任务。',
      state: getStateSnapshot()
    };
  }

  setRecorderState('stopping', { error: '' });

  try {
    const response = await chrome.runtime.sendMessage({ type: 'offscreenStopRecording' });
    if (!response || !response.ok || !response.recording) {
      throw new Error((response && response.error) || '停止录音失败。');
    }

    await handleRecordedData(response.recording);
    return { ok: true, state: getStateSnapshot() };
  } catch (error) {
    await cleanupOffscreen();
    return failResponse(toFriendlyCaptureError(error));
  }
}

async function resetRecording() {
  await cleanupOffscreen();
  state = createState('idle', {
    format: state.format || DEFAULT_FORMAT,
    language: state.language || DEFAULT_LANGUAGE
  });
  recorderState = 'idle';
  return { ok: true, state: getStateSnapshot() };
}

async function handleRecordedData(recording) {
  setRecorderState('uploading', { error: '', startedAt: null });

  try {
    const normalizedRecording = normalizeRecording(recording);
    if (!normalizedRecording) {
      throw new Error('录音数据为空。');
    }
    const result = await uploadToLocalAsr(normalizedRecording.dataUrl, normalizedRecording.mimeType || 'audio/webm');
    await downloadTranscription(result);
    setRecorderState('done', { startedAt: null, error: '' });
  } catch (error) {
    await cleanupOffscreen();
    await failRecorder(error.message || '本地 ASR 转写失败。');
  }
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length ? tabs[0] : null;
}

async function ensureOffscreenDocument() {
  if (await chrome.offscreen.hasDocument()) {
    return;
  }

  await chrome.offscreen.createDocument({
    url: 'offscreen.html',
    reasons: ['USER_MEDIA'],
    justification: '录制当前活动标签页的音频，并在 popup 关闭后继续保持录制。'
  });
}

function getMediaStreamId(tabId) {
  return new Promise((resolve, reject) => {
    chrome.tabCapture.getMediaStreamId({ targetTabId: tabId }, (streamId) => {
      if (chrome.runtime.lastError) {
        reject(new Error(chrome.runtime.lastError.message));
        return;
      }

      if (!streamId) {
        reject(new Error('无法获取当前标签页音频流。'));
        return;
      }

      resolve(streamId);
    });
  });
}

async function cleanupOffscreen() {
  if (!(await chrome.offscreen.hasDocument())) {
    return;
  }

  try {
    await chrome.runtime.sendMessage({ type: 'offscreenCleanup' });
  } catch (error) {
    // The offscreen document may already be closing; cleanup remains best-effort.
  }

  try {
    await chrome.offscreen.closeDocument();
  } catch (error) {
    // Ignore close races so reset can always return a stable idle state.
  }
}

async function uploadToLocalAsr(dataUrl, mimeType) {
  assertLocalAsrEndpoint(ASR_ENDPOINT);

  if (!dataUrl) {
    throw new Error('录音数据为空。');
  }

  const blobResponse = await fetch(dataUrl);
  const audioBlob = await blobResponse.blob();
  const formData = new FormData();

  formData.append('file', audioBlob, RECORDING_FILE_NAME);
  formData.append('source_url', state.sourceUrl || '');
  formData.append('title', state.title || 'Bilibili 本地 ASR');
  formData.append('format', state.format || DEFAULT_FORMAT);
  formData.append('language', state.language || DEFAULT_LANGUAGE);

  let response;
  try {
    response = await fetch(ASR_ENDPOINT, {
      method: 'POST',
      body: formData,
      headers: {
        'X-Recorder-Mime-Type': mimeType || 'audio/webm'
      }
    });
  } catch (error) {
    throw new Error('请先启动本地 ASR 服务。');
  }

  if (!response.ok) {
    if (response.status === 0) {
      throw new Error('请先启动本地 ASR 服务。');
    }
    const message = await readResponseText(response);
    throw new Error(message || `本地 ASR 服务返回 ${response.status}。`);
  }

  return response.json();
}

async function readResponseText(response) {
  try {
    const text = await response.text();
    if (!text) {
      return '';
    }
    const json = JSON.parse(text);
    return json.detail || json.message || text;
  } catch (error) {
    return '';
  }
}

async function downloadTranscription(result) {
  if (!result || !result.content) {
    throw new Error('本地 ASR 服务没有返回可下载内容。');
  }

  const filename = safeFileName(result.filename || `bilibili-local-asr.${state.format || DEFAULT_FORMAT}`);
  const mimeType = getMimeType(result.format || state.format || DEFAULT_FORMAT);
  const downloadUrl = `data:${mimeType};charset=utf-8,${encodeURIComponent(result.content)}`;

  await chrome.downloads.download({
    url: downloadUrl,
    filename,
    saveAs: true
  });
}

function createState(status, overrides) {
  return {
    status,
    error: '',
    startedAt: null,
    tabId: null,
    title: '',
    sourceUrl: '',
    format: DEFAULT_FORMAT,
    language: DEFAULT_LANGUAGE,
    ...(overrides || {})
  };
}

function setRecorderState(status, overrides) {
  if (!STATES.has(status)) {
    throw new Error(`未知录音状态：${status}`);
  }

  recorderState = status;
  state = {
    ...state,
    status,
    ...(overrides || {})
  };
}

function getStateSnapshot() {
  return {
    ...state,
    status: recorderState
  };
}

async function failRecorder(error) {
  setRecorderState('error', {
    error: error || '操作失败。',
    startedAt: null
  });
}

function failResponse(error) {
  setRecorderState('error', {
    error: error || '操作失败。',
    startedAt: null
  });
  return { ok: false, error: state.error, state: getStateSnapshot() };
}

function toFriendlyCaptureError(error) {
  const message = error && error.message ? error.message : String(error || '');
  if (/active stream|Cannot capture a tab with an active stream/i.test(message)) {
    return ACTIVE_STREAM_ERROR;
  }
  return message || '录音失败。';
}

function assertLocalAsrEndpoint(endpoint) {
  const url = new URL(endpoint);
  if (url.hostname !== '127.0.0.1' && url.hostname !== 'localhost') {
    throw new Error('只允许连接本机 ASR 服务。');
  }
}

function normalizeFormat(format) {
  const candidate = String(format || DEFAULT_FORMAT).toLowerCase();
  return ['md', 'txt', 'srt', 'json'].includes(candidate) ? candidate : DEFAULT_FORMAT;
}

function normalizeRecording(recording) {
  if (!recording) {
    return null;
  }
  if (recording.dataUrl) {
    return recording;
  }
  if (recording.recording && recording.recording.dataUrl) {
    return recording.recording;
  }
  return null;
}

function getMimeType(format) {
  if (format === 'json') {
    return 'application/json';
  }
  if (format === 'md') {
    return 'text/markdown';
  }
  return 'text/plain';
}

function safeFileName(name) {
  const cleaned = String(name || '')
    .replace(/[\\/:*?"<>|]/g, '_')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 180);

  return cleaned || 'bilibili-local-asr.md';
}
