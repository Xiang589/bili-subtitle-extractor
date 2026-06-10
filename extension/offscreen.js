'use strict';

const MAX_RECORDING_MS = 10 * 60 * 1000;
const ACTIVE_STREAM_ERROR = '当前标签页已有未释放的录音流。请点击重置状态，或刷新扩展/重新打开标签页后重试。';

let mediaRecorder = null;
let mediaStream = null;
let audioContext = null;
let sourceNode = null;
let chunks = [];
let startedAt = null;
let maxRecordingTimer = null;
let stopPromise = null;
let stopResolve = null;
let stopReject = null;
let recorderMimeType = '';
let finalizing = false;

chrome.runtime.onMessage.addListener((message, sender, sendResponse) => {
  handleMessage(message)
    .then((response) => sendResponse(response))
    .catch((error) => {
      cleanupMedia();
      sendResponse({ ok: false, error: toFriendlyCaptureError(error) });
    });
  return true;
});

async function handleMessage(message) {
  if (!message || !message.type) {
    throw new Error('未知消息。');
  }

  if (message.type === 'offscreenStartRecording') {
    const response = await startRecording(message.streamId);
    return { ok: true, ...response };
  }

  if (message.type === 'offscreenStopRecording') {
    const recording = await stopRecording('manual');
    return { ok: true, recording };
  }

  if (message.type === 'offscreenCleanup') {
    cleanupMedia();
    return { ok: true };
  }

  return { ok: true };
}

async function startRecording(streamId) {
  if (hasActiveRecording()) {
    throw new Error(ACTIVE_STREAM_ERROR);
  }

  if (!streamId) {
    throw new Error('缺少当前标签页音频流 ID。');
  }

  cleanupMedia();
  chunks = [];
  startedAt = Date.now();
  finalizing = false;

  try {
    mediaStream = await navigator.mediaDevices.getUserMedia({
      audio: {
        mandatory: {
          chromeMediaSource: 'tab',
          chromeMediaSourceId: streamId
        }
      },
      video: false
    });
  } catch (error) {
    cleanupMedia();
    throw new Error(toFriendlyCaptureError(error));
  }

  connectAudioBackToOutput(mediaStream);

  recorderMimeType = chooseMimeType();
  const recorderOptions = recorderMimeType ? { mimeType: recorderMimeType } : {};
  mediaRecorder = new MediaRecorder(mediaStream, recorderOptions);

  mediaRecorder.ondataavailable = (event) => {
    if (event.data && event.data.size > 0) {
      chunks.push(event.data);
    }
  };

  mediaRecorder.onerror = (event) => {
    const error = event.error || new Error('MediaRecorder 录音失败。');
    rejectStop(error);
    notifyError(error);
  };

  mediaRecorder.onstop = () => {
    finishRecording().catch((error) => {
      rejectStop(error);
      notifyError(error);
    });
  };

  mediaRecorder.start(1000);
  maxRecordingTimer = window.setTimeout(() => {
    stopRecording('timeout')
      .then((recording) => {
        if (recording) {
          chrome.runtime.sendMessage({ type: 'offscreenRecordingStopped', recording });
        }
      })
      .catch((error) => notifyError(error));
  }, MAX_RECORDING_MS);

  return { startedAt };
}

function stopRecording(reason) {
  if (stopPromise) {
    return stopPromise;
  }

  stopPromise = new Promise((resolve, reject) => {
    stopResolve = resolve;
    stopReject = reject;
  });

  if (!mediaRecorder || mediaRecorder.state === 'inactive') {
    resolveStop(null);
    return stopPromise;
  }

  try {
    mediaRecorder.stop();
  } catch (error) {
    rejectStop(error);
  }

  return stopPromise;
}

async function finishRecording() {
  if (finalizing) {
    return;
  }
  finalizing = true;

  const durationMs = startedAt ? Date.now() - startedAt : 0;
  const mimeType = recorderMimeType || (mediaRecorder && mediaRecorder.mimeType) || 'audio/webm';
  const blob = new Blob(chunks, { type: mimeType });

  cleanupMedia({ stopRecorder: false, clearStopPromise: false });

  if (!blob.size) {
    rejectStop(new Error('录音结果为空。'));
    return;
  }

  const dataUrl = await blobToDataUrl(blob);
  resolveStop({
    dataUrl,
    mimeType: blob.type || mimeType,
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

function cleanupMedia(options) {
  const settings = {
    stopRecorder: true,
    clearStopPromise: true,
    ...(options || {})
  };

  if (maxRecordingTimer) {
    window.clearTimeout(maxRecordingTimer);
    maxRecordingTimer = null;
  }

  const recorder = mediaRecorder;
  mediaRecorder = null;
  if (recorder) {
    recorder.ondataavailable = null;
    recorder.onerror = null;
    recorder.onstop = null;
    if (settings.stopRecorder && recorder.state !== 'inactive') {
      try {
        recorder.stop();
      } catch (error) {
        // Stop is best-effort during cleanup.
      }
    }
  }

  if (mediaStream) {
    mediaStream.getTracks().forEach((track) => track.stop());
    mediaStream = null;
  }

  if (sourceNode) {
    try {
      sourceNode.disconnect();
    } catch (error) {
      // Disconnect is idempotent for our purposes.
    }
    sourceNode = null;
  }

  if (audioContext) {
    audioContext.close().catch(() => {});
    audioContext = null;
  }

  chunks = [];
  startedAt = null;
  recorderMimeType = '';
  finalizing = false;
  if (settings.clearStopPromise) {
    stopPromise = null;
    stopResolve = null;
    stopReject = null;
  }
}

function hasActiveRecording() {
  if (mediaRecorder && mediaRecorder.state !== 'inactive') {
    return true;
  }
  if (!mediaStream) {
    return false;
  }
  return mediaStream.getTracks().some((track) => track.readyState === 'live');
}

function resolveStop(recording) {
  const resolver = stopResolve;
  stopPromise = null;
  stopResolve = null;
  stopReject = null;
  if (resolver) {
    resolver(recording);
  }
}

function rejectStop(error) {
  const rejecter = stopReject;
  stopPromise = null;
  stopResolve = null;
  stopReject = null;
  cleanupMedia({ clearStopPromise: false });
  if (rejecter) {
    rejecter(error);
  }
}

function notifyError(error) {
  cleanupMedia();
  chrome.runtime.sendMessage({
    type: 'offscreenRecordingError',
    error: toFriendlyCaptureError(error)
  });
}

function toFriendlyCaptureError(error) {
  const message = error && error.message ? error.message : String(error || '');
  if (/active stream|Cannot capture a tab with an active stream/i.test(message)) {
    return ACTIVE_STREAM_ERROR;
  }
  return message || '录音失败。';
}
