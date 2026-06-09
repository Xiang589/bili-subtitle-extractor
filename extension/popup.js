'use strict';

const HEALTH_URL = 'http://127.0.0.1:8765/health';

const elements = {};
let serviceOnline = false;
let currentState = null;
let timerHandle = null;

function byId(id) {
  return document.getElementById(id);
}

function sendMessage(message) {
  return chrome.runtime.sendMessage(message);
}

function formatElapsed(milliseconds) {
  const totalSeconds = Math.max(0, Math.floor(milliseconds / 1000));
  const minutes = Math.floor(totalSeconds / 60);
  const seconds = totalSeconds % 60;
  return `${String(minutes).padStart(2, '0')}:${String(seconds).padStart(2, '0')}`;
}

function setMessage(message, isError) {
  elements.message.textContent = message || '';
  elements.message.className = isError ? 'status-error' : '';
}

async function getActiveTab() {
  const tabs = await chrome.tabs.query({ active: true, currentWindow: true });
  return tabs && tabs.length ? tabs[0] : null;
}

async function refreshServiceStatus() {
  try {
    const response = await fetch(HEALTH_URL, { cache: 'no-store' });
    const json = await response.json();
    serviceOnline = Boolean(response.ok && json && json.ok);
    elements.serviceStatus.textContent = serviceOnline ? '已启动' : '不可用';
    elements.serviceStatus.className = serviceOnline ? 'value status-ok' : 'value status-error';
  } catch (error) {
    serviceOnline = false;
    elements.serviceStatus.textContent = '未启动';
    elements.serviceStatus.className = 'value status-error';
  }
}

async function refreshTabInfo() {
  const tab = await getActiveTab();
  elements.tabTitle.textContent = tab && tab.title ? tab.title : '未知';
}

async function refreshRecordingStatus() {
  const response = await sendMessage({ type: 'GET_STATUS' });
  currentState = response && response.state ? response.state : null;
  const status = currentState ? currentState.status : 'idle';
  const labels = {
    idle: '空闲',
    starting: '准备中',
    recording: '录制中',
    stopping: '停止中',
    transcribing: '转写中',
    completed: '已完成',
    error: '错误'
  };

  elements.recordStatus.textContent = labels[status] || status;
  elements.recordStatus.className = status === 'error' ? 'value status-error' : 'value';

  const isRecording = status === 'recording' || status === 'starting' || status === 'stopping' || status === 'transcribing';
  elements.startButton.disabled = isRecording || !serviceOnline;
  elements.stopButton.disabled = status !== 'recording';

  if (!serviceOnline) {
    setMessage('请先启动本地 ASR 服务。', true);
  } else if (status === 'error' && currentState.error) {
    setMessage(currentState.error, true);
  } else if (status === 'completed') {
    setMessage('转写完成，已触发下载。', false);
  } else {
    setMessage('', false);
  }

  updateTimer();
}

function updateTimer() {
  if (currentState && currentState.status === 'recording' && currentState.startedAt) {
    elements.timer.textContent = formatElapsed(Date.now() - currentState.startedAt);
    return;
  }
  elements.timer.textContent = '00:00';
}

async function loadStoredFormat() {
  const saved = await chrome.storage.local.get({ exportFormat: 'md' });
  elements.formatSelect.value = saved.exportFormat || 'md';
}

async function startRecording() {
  if (!serviceOnline) {
    setMessage('请先启动本地 ASR 服务。', true);
    return;
  }

  const format = elements.formatSelect.value || 'md';
  await chrome.storage.local.set({ exportFormat: format });
  const response = await sendMessage({ type: 'START_RECORDING', format, language: 'zh' });
  if (!response || !response.ok) {
    setMessage((response && response.error) || '启动录音失败。', true);
  }
  await refreshRecordingStatus();
}

async function stopRecording() {
  const response = await sendMessage({ type: 'STOP_RECORDING' });
  if (!response || !response.ok) {
    setMessage((response && response.error) || '停止录音失败。', true);
  }
  await refreshRecordingStatus();
}

async function refreshAll() {
  await Promise.all([refreshServiceStatus(), refreshTabInfo()]);
  await refreshRecordingStatus();
}

async function init() {
  elements.serviceStatus = byId('serviceStatus');
  elements.tabTitle = byId('tabTitle');
  elements.recordStatus = byId('recordStatus');
  elements.timer = byId('timer');
  elements.startButton = byId('startButton');
  elements.stopButton = byId('stopButton');
  elements.formatSelect = byId('formatSelect');
  elements.message = byId('message');

  await loadStoredFormat();
  elements.startButton.addEventListener('click', startRecording);
  elements.stopButton.addEventListener('click', stopRecording);
  elements.formatSelect.addEventListener('change', () => chrome.storage.local.set({ exportFormat: elements.formatSelect.value }));

  await refreshAll();
  timerHandle = window.setInterval(() => {
    updateTimer();
    refreshRecordingStatus().catch((error) => setMessage(error.message, true));
  }, 1000);
}

window.addEventListener('unload', () => {
  if (timerHandle) {
    window.clearInterval(timerHandle);
  }
});

document.addEventListener('DOMContentLoaded', () => {
  init().catch((error) => setMessage(error.message, true));
});
