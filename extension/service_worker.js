'use strict';

const ASR_ENDPOINT = 'http://127.0.0.1:8765/transcribe';
const DEFAULT_LANGUAGE = 'zh';
const DEFAULT_FORMAT = 'md';
const RECORDING_FILE_NAME = 'tab-audio.webm';

let state = {
  status: 'idle',
  error: '',
  startedAt: null,
  tabId: null,
  title: '',
  sourceUrl: '',
  format: DEFAULT_FORMAT,
  language: DEFAULT_LANGUAGE
};

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message, sender)
    .then((response) => sendResponse(response))
    .catch((error) => {
      setError(error.message || '操作失败。');
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function handleMessage(message) {
  if (!message || !message.type) {
    throw new Error('未知消息。');
  }

  if (message.type === 'GET_STATUS') {
    return { ok: true, state };
  }

  if (message.type === 'START_RECORDING') {
    return startRecording(message);
  }

  if (message.type === 'STOP_RECORDING') {
    return stopRecording();
  }

  if (message.type === 'OFFSCREEN_RECORDING_STARTED') {
    state = {
      ...state,
      status: 'recording',
      error: '',
      startedAt: message.startedAt || Date.now()
    };
    return { ok: true };
  }

  if (message.type === 'OFFSCREEN_RECORDING_STOPPED') {
    await handleRecordedData(message);
    return { ok: true };
  }

  if (message.type === 'OFFSCREEN_RECORDING_ERROR') {
    setError(message.error || '录音失败。');
    return { ok: true };
  }

  throw new Error(`未支持的消息：${message.type}`);
}

async function startRecording(message) {
  if (state.status === 'recording' || state.status === 'starting' || state.status === 'stopping' || state.status === 'transcribing') {
    throw new Error('已有录音任务正在进行。');
  }

  const activeTab = await getActiveTab();
  if (!activeTab || !activeTab.id) {
    throw new Error('无法读取当前活动标签页。');
  }

  state = {
    status: 'starting',
    error: '',
    startedAt: null,
    tabId: activeTab.id,
    title: activeTab.title || 'Bilibili 本地 ASR',
    sourceUrl: activeTab.url || '',
    format: normalizeFormat(message.format),
    language: message.language || DEFAULT_LANGUAGE
  };

  await ensureOffscreenDocument();
  const streamId = await getMediaStreamId(activeTab.id);
  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_START_RECORDING',
    streamId,
    title: state.title,
    sourceUrl: state.sourceUrl,
    format: state.format,
    language: state.language
  });

  return { ok: true, state };
}

async function stopRecording() {
  if (state.status !== 'recording') {
    throw new Error('当前没有正在录制的任务。');
  }

  state = {
    ...state,
    status: 'stopping'
  };

  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_STOP_RECORDING' });
  return { ok: true, state };
}

async function handleRecordedData(message) {
  state = {
    ...state,
    status: 'transcribing',
    error: ''
  };

  try {
    const result = await uploadToLocalAsr(message.dataUrl, message.mimeType || 'audio/webm');
    await downloadTranscription(result);
    state = {
      ...state,
      status: 'completed',
      startedAt: null
    };
  } catch (error) {
    setError(error.message || '本地 ASR 转写失败。');
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

function setError(error) {
  state = {
    ...state,
    status: 'error',
    error: error || '操作失败。',
    startedAt: null
  };
}
