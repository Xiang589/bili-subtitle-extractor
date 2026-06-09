'use strict';

let mediaRecorder = null;
let capturedStream = null;
let audioContext = null;
let sourceNode = null;
let chunks = [];
let startedAt = null;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      notifyError(error);
      sendResponse({ ok: false, error: error.message || String(error) });
    });
  return true;
});

async function handleMessage(message) {
  if (!message || !message.type) {
    throw new Error('未知消息。');
  }

  if (message.type === 'OFFSCREEN_START_RECORDING') {
    await startRecording(message.streamId);
    return { ok: true };
  }

  if (message.type === 'OFFSCREEN_STOP_RECORDING') {
    stopRecording();
    return { ok: true };
  }

  return { ok: true };
}

async function startRecording(streamId) {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    throw new Error('录音已经在进行。');
  }

  if (!streamId) {
    throw new Error('缺少当前标签页音频流 ID。');
  }

  chunks = [];
  startedAt = Date.now();
  capturedStream = await navigator.mediaDevices.getUserMedia({
    audio: {
      mandatory: {
        chromeMediaSource: 'tab',
        chromeMediaSourceId: streamId
      }
    },
    video: false
  });

  connectAudioBackToOutput(capturedStream);

  const mimeType = chooseMimeType();
  const recorderOptions = mimeType ? { mimeType } : {};
  mediaRecorder = new MediaRecorder(capturedStream, recorderOptions);

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  mediaRecorder.onerror = (event) => {
    notifyError(event.error || new Error('MediaRecorder 录音失败。'));
    cleanupMedia();
  };

  mediaRecorder.onstop = () => {
    finishRecording(mimeType || mediaRecorder.mimeType || 'audio/webm').catch((error) => notifyError(error));
  };

  mediaRecorder.start(1000);
  await chrome.runtime.sendMessage({ type: 'OFFSCREEN_RECORDING_STARTED', startedAt });
}

function stopRecording() {
  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    return;
  }

  mediaRecorder.stop();
}

async function finishRecording(mimeType) {
  const durationMs = startedAt ? Date.now() - startedAt : 0;
  const blob = new Blob(chunks, { type: mimeType || 'audio/webm' });
  cleanupMedia();

  if (!blob.size) {
    throw new Error('录音结果为空。');
  }

  const dataUrl = await blobToDataUrl(blob);
  await chrome.runtime.sendMessage({
    type: 'OFFSCREEN_RECORDING_STOPPED',
    dataUrl,
    mimeType: blob.type || mimeType || 'audio/webm',
    durationMs
  });
}

function connectAudioBackToOutput(stream) {
  audioContext = new AudioContext();
  sourceNode = audioContext.createMediaStreamSource(stream);
  sourceNode.connect(audioContext.destination);
}

function chooseMimeType() {
  if (typeof MediaRecorder === 'undefined' || typeof MediaRecorder.isTypeSupported !== 'function') {
    return '';
  }

  const preferred = 'audio/webm;codecs=opus';
  if (MediaRecorder.isTypeSupported(preferred)) {
    return preferred;
  }

  if (MediaRecorder.isTypeSupported('audio/webm')) {
    return 'audio/webm';
  }

  return '';
}

function blobToDataUrl(blob) {
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => resolve(reader.result);
    reader.onerror = () => reject(reader.error || new Error('读取录音数据失败。'));
    reader.readAsDataURL(blob);
  });
}

function cleanupMedia() {
  if (capturedStream) {
    capturedStream.getTracks().forEach((track) => track.stop());
    capturedStream = null;
  }

  if (sourceNode) {
    sourceNode.disconnect();
    sourceNode = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  mediaRecorder = null;
  chunks = [];
  startedAt = null;
}

function notifyError(error) {
  cleanupMedia();
  chrome.runtime.sendMessage({
    type: 'OFFSCREEN_RECORDING_ERROR',
    error: error && error.message ? error.message : String(error)
  });
}
