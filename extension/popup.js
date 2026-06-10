'use strict';

const HEALTH_URL = 'http://127.0.0.1:8765/health';
const STARTABLE_STATES = new Set(['idle', 'done', 'error']);
const BUSY_STATES = new Set(['starting', 'stopping', 'uploading']);

const elements = {};
let serviceOnline = false;
let currentState = { status: 'idle' };
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
  const response = await sendMessage({ type: 'getState' });
  if (response && response.state) {
    renderState(response.state);
  }
}

function renderState(nextState) {
  currentState = nextState || { status: 'idle' };
  const status = currentState.status || 'idle';
  const labels = {
    idle: '未录制',
    starting: '正在启动录音…',
    recording: '录制中',
    stopping: '正在停止录音…',
    uploading: '正在生成字幕…',
    done: '完成',
    error: '错误'
  };

  elements.recordStatus.textContent = labels[status] || status;
  elements.recordStatus.className = status === 'error' ? 'value status-error' : 'value';

  const canStart = STARTABLE_STATES.has(status) && serviceOnline;
  elements.startButton.disabled = !canStart;
  elements.stopButton.disabled = status !== 'recording';
  elements.resetButton.disabled = false;

  if (!serviceOnline) {
    setMessage('请先启动本地 ASR 服务。', true);
  } else if (status === 'error' && currentState.error) {
    setMessage(currentState.error, true);
  } else if (status === 'done') {
    setMessage('字幕生成完成，已触发下载。', false);
  } else if (BUSY_STATES.has(status)) {
    setMessage(labels[status], false);
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
  const shouldResetBeforeStart = currentState.status === 'error';
  renderState({ ...currentState, status: 'starting', error: '' });

  if (shouldResetBeforeStart) {
    await sendMessage({ type: 'resetRecording' });
  }

  const response = await sendMessage({ type: 'startRecording', format, language: 'zh' });
  if (!response || !response.ok) {
    renderState((response && response.state) || { status: 'error', error: (response && response.error) || '启动录音失败。' });
    return;
  }

  renderState(response.state);
}

async function stopRecording() {
  renderState({ ...currentState, status: 'stopping', error: '' });
  const response = await sendMessage({ type: 'stopRecording' });
  if (!response || !response.ok) {
    renderState((response && response.state) || { status: 'error', error: (response && response.error) || '停止录音失败。' });
    return;
  }

  renderState(response.state);
}

async function resetRecording() {
  const response = await sendMessage({ type: 'resetRecording' });
  renderState((response && response.state) || { status: 'idle' });
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
  elements.resetButton = byId('resetButton');
  elements.formatSelect = byId('formatSelect');
  elements.message = byId('message');

  await loadStoredFormat();
  elements.startButton.addEventListener('click', () => startRecording().catch((error) => renderState({ status: 'error', error: error.message })));
  elements.stopButton.addEventListener('click', () => stopRecording().catch((error) => renderState({ status: 'error', error: error.message })));
  elements.resetButton.addEventListener('click', () => resetRecording().catch((error) => renderState({ status: 'error', error: error.message })));
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
