// ==UserScript==
// @name         Bilibili 字幕提取器
// @namespace    local.bili.transcript
// @version      0.1.0
// @description  提取当前 Bilibili 视频已有字幕并导出为 Markdown / TXT / SRT / JSON
// @match        https://www.bilibili.com/video/*
// @run-at       document-idle
// @grant        GM_xmlhttpRequest
// @grant        GM_registerMenuCommand
// @grant        unsafeWindow
// @connect      api.bilibili.com
// @connect      *.bilibili.com
// @connect      *.hdslb.com
// ==/UserScript==

(function () {
  'use strict';

  const SOURCE_NAME = 'Bilibili';
  const DEFAULT_FORMAT = 'md';
  const SUPPORTED_FORMATS = new Set(['md', 'txt', 'srt', 'json']);

  function makeUserError(message, detail) {
    const error = new Error(message);
    error.detail = detail;
    return error;
  }

  function reportError(error) {
    const message = error && error.message ? error.message : '字幕提取失败';
    alert(message);
    console.error('[bili-subtitle-extractor]', message, error && error.detail ? error.detail : error);
  }

  function getCurrentUrl() {
    if (typeof window !== 'undefined' && window.location && window.location.href) {
      return window.location.href;
    }
    return '';
  }

  function getBvid(url) {
    const targetUrl = url || getCurrentUrl();
    const match = targetUrl.match(/\/video\/(BV[0-9A-Za-z]{10})/i) || targetUrl.match(/\b(BV[0-9A-Za-z]{10})\b/i);
    return match ? match[1] : '';
  }

  function getPageNumber(url) {
    const targetUrl = url || getCurrentUrl();
    try {
      const parsedUrl = new URL(targetUrl, 'https://www.bilibili.com');
      const page = Number.parseInt(parsedUrl.searchParams.get('p') || '1', 10);
      return Number.isFinite(page) && page > 0 ? page : 1;
    } catch (error) {
      return 1;
    }
  }

  function getUnsafeInitialState() {
    if (typeof unsafeWindow !== 'undefined' && unsafeWindow && unsafeWindow.__INITIAL_STATE__) {
      return unsafeWindow.__INITIAL_STATE__;
    }
    if (typeof window !== 'undefined' && window && window.__INITIAL_STATE__) {
      return window.__INITIAL_STATE__;
    }
    return null;
  }

  function cleanTitle(title, fallback) {
    const rawTitle = String(title || '').replace(/_哔哩哔哩_bilibili.*$/i, '').trim();
    return rawTitle || fallback || 'Bilibili 字幕';
  }

  function normalizePages(pages) {
    if (!Array.isArray(pages)) {
      return [];
    }

    return pages
      .map((page, index) => ({
        cid: Number(page && page.cid),
        page: Number(page && page.page) || index + 1,
        part: String((page && (page.part || page.title)) || `P${index + 1}`)
      }))
      .filter((page) => Number.isFinite(page.cid) && page.cid > 0);
  }

  function normalizeVideoInfo(data, bvid) {
    const pages = normalizePages(data && data.pages);
    const cid = Number(data && data.cid) || (pages[0] && pages[0].cid) || 0;

    return {
      title: cleanTitle(data && data.title, bvid),
      source: SOURCE_NAME,
      bvid: (data && data.bvid) || bvid,
      aid: data && data.aid,
      cid,
      pages,
      raw: data
    };
  }

  function getInitialStateVideoInfo(bvid) {
    const state = getUnsafeInitialState();
    if (!state) {
      return null;
    }

    const data = state.videoData || state.videoInfo || state.viewInfo || null;
    if (!data) {
      return null;
    }

    const info = normalizeVideoInfo(data, bvid);
    if (!info.cid && info.pages.length === 0) {
      return null;
    }

    return info;
  }

  function gmGetText(url, message, options) {
    const requestOptions = options || {};

    return new Promise((resolve, reject) => {
      const onResponse = (response) => {
        const status = Number(response.status) || 0;
        if (requestOptions.loginSensitive && (status === 401 || status === 403)) {
          reject(makeUserError('字幕需要登录，请先在浏览器中登录 Bilibili 后重试。', response));
          return;
        }

        if (status < 200 || status >= 300) {
          reject(makeUserError(message, response));
          return;
        }

        resolve(response.responseText || '');
      };

      if (typeof GM_xmlhttpRequest === 'function') {
        GM_xmlhttpRequest({
          method: 'GET',
          url,
          anonymous: true,
          headers: {
            Accept: 'application/json,text/plain,*/*',
            Referer: getCurrentUrl() || 'https://www.bilibili.com/'
          },
          onload: onResponse,
          onerror: (error) => reject(makeUserError(message, error)),
          ontimeout: (error) => reject(makeUserError(message, error))
        });
        return;
      }

      fetch(url, {
        method: 'GET',
        credentials: 'omit',
        headers: {
          Accept: 'application/json,text/plain,*/*'
        }
      })
        .then((response) => {
          const status = response.status;
          return response.text().then((text) => onResponse({ status, responseText: text, finalUrl: response.url }));
        })
        .catch((error) => reject(makeUserError(message, error)));
    });
  }

  async function gmGetJson(url, message, options) {
    const text = await gmGetText(url, message, options);
    let json;

    try {
      json = JSON.parse(text);
    } catch (error) {
      throw makeUserError(message, { error, text });
    }

    if (options && options.loginSensitive && json && json.code === -101) {
      throw makeUserError('字幕需要登录，请先在浏览器中登录 Bilibili 后重试。', json);
    }

    return json;
  }

  async function getVideoInfo(bvid) {
    const initialInfo = getInitialStateVideoInfo(bvid);
    if (initialInfo) {
      return initialInfo;
    }

    const url = `https://api.bilibili.com/x/web-interface/view?bvid=${encodeURIComponent(bvid)}`;
    const json = await gmGetJson(url, '无法获取视频信息');
    if (!json || json.code !== 0 || !json.data) {
      throw makeUserError('无法获取视频信息', json);
    }

    return normalizeVideoInfo(json.data, bvid);
  }

  function findCidForPage(videoInfo, pageNumber) {
    const pages = Array.isArray(videoInfo.pages) ? videoInfo.pages : [];
    const matchedPage = pages.find((page) => page.page === pageNumber) || pages[pageNumber - 1];

    if (matchedPage && matchedPage.cid) {
      return matchedPage.cid;
    }

    if (pageNumber === 1 && videoInfo.cid) {
      return videoInfo.cid;
    }

    return 0;
  }

  async function getSubtitleTracks(bvid, cid) {
    const url = `https://api.bilibili.com/x/player/wbi/v2?bvid=${encodeURIComponent(bvid)}&cid=${encodeURIComponent(cid)}`;
    const json = await gmGetJson(url, '无法获取字幕轨', { loginSensitive: true });
    if (!json || json.code !== 0) {
      if (json && json.code === -101) {
        throw makeUserError('字幕需要登录，请先在浏览器中登录 Bilibili 后重试。', json);
      }
      throw makeUserError('无法获取字幕轨', json);
    }

    const subtitles = json.data && json.data.subtitle && json.data.subtitle.subtitles;
    return Array.isArray(subtitles) ? subtitles : [];
  }

  function getTrackLabel(track) {
    return String((track && (track.lan_doc || track.language || track.lan)) || '未知字幕');
  }

  function isAiTrack(track) {
    const label = `${track && track.lan_doc ? track.lan_doc : ''} ${track && track.type ? track.type : ''}`.toLowerCase();
    return Boolean(
      track &&
        (track.ai_type ||
          track.ai_status ||
          track.is_ai ||
          track.type === 1 ||
          label.includes('ai') ||
          label.includes('自动') ||
          label.includes('智能'))
    );
  }

  function isSimplifiedChineseTrack(track) {
    const lan = String((track && track.lan) || '').toLowerCase();
    const label = getTrackLabel(track).toLowerCase();
    return lan === 'zh-cn' || lan === 'zh-hans' || label.includes('简体') || label.includes('简中');
  }

  function isChineseTrack(track) {
    const lan = String((track && track.lan) || '').toLowerCase();
    const label = getTrackLabel(track).toLowerCase();
    return isSimplifiedChineseTrack(track) || lan.startsWith('zh') || label.includes('中文') || label.includes('中国');
  }

  function getTrackScore(track, index) {
    const ai = isAiTrack(track);
    const simplifiedChinese = isSimplifiedChineseTrack(track);
    const chinese = isChineseTrack(track);

    if (simplifiedChinese && !ai) {
      return 400 - index;
    }
    if (chinese && !ai) {
      return 300 - index;
    }
    if (chinese && ai) {
      return 200 - index;
    }
    return 100 - index;
  }

  function chooseSubtitleTrack(tracks) {
    if (!Array.isArray(tracks) || tracks.length === 0) {
      throw makeUserError('当前视频没有字幕轨');
    }

    const rankedTracks = tracks
      .map((track, index) => ({ track, index, score: getTrackScore(track, index) }))
      .sort((left, right) => right.score - left.score);
    const recommendedTrack = rankedTracks[0].track;

    if (tracks.length === 1 || typeof prompt !== 'function') {
      return recommendedTrack;
    }

    const recommendedIndex = tracks.indexOf(recommendedTrack);
    const options = tracks
      .map((track, index) => {
        const suffix = index === recommendedIndex ? '（推荐）' : '';
        return `${index + 1}. ${getTrackLabel(track)}${suffix}`;
      })
      .join('\n');
    const answer = prompt(`检测到多个字幕轨，请输入序号选择：\n\n${options}`, String(recommendedIndex + 1));

    if (answer === null || answer.trim() === '') {
      return recommendedTrack;
    }

    const selectedIndex = Number.parseInt(answer, 10) - 1;
    if (Number.isFinite(selectedIndex) && selectedIndex >= 0 && selectedIndex < tracks.length) {
      return tracks[selectedIndex];
    }

    return recommendedTrack;
  }

  function normalizeSubtitleUrl(url) {
    const subtitleUrl = String(url || '').trim();
    if (!subtitleUrl) {
      return '';
    }
    if (subtitleUrl.startsWith('//')) {
      return `https:${subtitleUrl}`;
    }
    return subtitleUrl;
  }

  async function fetchSubtitleJson(subtitleUrl) {
    const normalizedUrl = normalizeSubtitleUrl(subtitleUrl);
    if (!normalizedUrl) {
      throw makeUserError('字幕 URL 为空');
    }

    const json = await gmGetJson(normalizedUrl, '字幕 JSON 请求失败', { loginSensitive: true });
    if (json && json.code === -101) {
      throw makeUserError('字幕需要登录，请先在浏览器中登录 Bilibili 后重试。', json);
    }

    return json;
  }

  function normalizeSubtitleBody(body) {
    if (!Array.isArray(body)) {
      return [];
    }

    return body
      .map((item) => ({
        from: Number(item && item.from) || 0,
        to: Number(item && item.to) || 0,
        content: String((item && item.content) || '').trim()
      }))
      .filter((item) => item.content);
  }

  function formatClockTime(seconds) {
    const totalSeconds = Math.max(0, Math.floor(Number(seconds) || 0));
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const restSeconds = totalSeconds % 60;

    return [hours, minutes, restSeconds].map((part) => String(part).padStart(2, '0')).join(':');
  }

  function formatSrtTime(seconds) {
    const totalMilliseconds = Math.max(0, Math.round((Number(seconds) || 0) * 1000));
    const milliseconds = totalMilliseconds % 1000;
    const totalSeconds = Math.floor(totalMilliseconds / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const restSeconds = totalSeconds % 60;

    return `${String(hours).padStart(2, '0')}:${String(minutes).padStart(2, '0')}:${String(restSeconds).padStart(2, '0')},${String(milliseconds).padStart(3, '0')}`;
  }

  function compactSubtitleText(content) {
    return String(content || '').replace(/\s+/g, ' ').trim();
  }

  function toMarkdown(data) {
    const lines = [
      `# ${data.title}`,
      '',
      `- 来源：${SOURCE_NAME}`,
      `- BV号：${data.bvid}`,
      `- CID：${data.cid}`,
      `- 分P：P${data.page}`,
      `- 原始链接：${data.url}`,
      `- 字幕语言：${getTrackLabel(data.track)}`,
      '',
      '## 字幕正文',
      ''
    ];

    data.body.forEach((item) => {
      lines.push(`- [${formatClockTime(item.from)} - ${formatClockTime(item.to)}] ${compactSubtitleText(item.content)}`);
    });

    return `${lines.join('\n')}\n`;
  }

  function toTxt(data) {
    return `${data.body.map((item) => compactSubtitleText(item.content)).join('\n')}\n`;
  }

  function toSrt(data) {
    const blocks = data.body.map((item, index) => {
      return `${index + 1}\n${formatSrtTime(item.from)} --> ${formatSrtTime(item.to)}\n${compactSubtitleText(item.content)}`;
    });

    return `${blocks.join('\n\n')}\n`;
  }

  function toJson(data) {
    return `${JSON.stringify(
      {
        title: data.title,
        source: SOURCE_NAME,
        url: data.url,
        bvid: data.bvid,
        cid: data.cid,
        page: data.page,
        track: {
          id: data.track && data.track.id,
          lan: data.track && data.track.lan,
          lan_doc: data.track && data.track.lan_doc,
          subtitle_url: normalizeSubtitleUrl(data.track && data.track.subtitle_url)
        },
        body: data.body
      },
      null,
      2
    )}\n`;
  }

  function safeFileName(name) {
    const cleaned = String(name || '')
      .replace(/[\\/:*?"<>|]/g, '_')
      .replace(/\s+/g, ' ')
      .trim()
      .slice(0, 180);

    return cleaned || 'bilibili_subtitle';
  }

  function downloadText(text, fileName, mimeType) {
    const blob = new Blob([text], { type: mimeType || 'text/plain;charset=utf-8' });
    const objectUrl = URL.createObjectURL(blob);
    const link = document.createElement('a');

    link.href = objectUrl;
    link.download = safeFileName(fileName);
    document.body.appendChild(link);
    link.click();
    link.remove();

    window.setTimeout(() => URL.revokeObjectURL(objectUrl), 1000);
  }

  function getExportFormat() {
    const answer = typeof prompt === 'function' ? prompt('请选择导出格式：md / txt / srt / json', DEFAULT_FORMAT) : DEFAULT_FORMAT;
    const format = String(answer || DEFAULT_FORMAT).trim().toLowerCase().replace(/^\./, '');

    if (!SUPPORTED_FORMATS.has(format)) {
      throw makeUserError(`导出格式不支持：${format}`);
    }

    return format;
  }

  function getOutputText(format, data) {
    if (format === 'md') {
      return toMarkdown(data);
    }
    if (format === 'txt') {
      return toTxt(data);
    }
    if (format === 'srt') {
      return toSrt(data);
    }
    if (format === 'json') {
      return toJson(data);
    }

    throw makeUserError(`导出格式不支持：${format}`);
  }

  function getMimeType(format) {
    if (format === 'json') {
      return 'application/json;charset=utf-8';
    }
    if (format === 'md') {
      return 'text/markdown;charset=utf-8';
    }
    return 'text/plain;charset=utf-8';
  }

  function buildVideoUrl(bvid, page) {
    return `https://www.bilibili.com/video/${bvid}${page > 1 ? `?p=${page}` : ''}`;
  }

  async function extractSubtitle() {
    try {
      const bvid = getBvid();
      if (!bvid) {
        throw makeUserError('无法解析 BV 号');
      }

      const page = getPageNumber();
      const videoInfo = await getVideoInfo(bvid);
      if (!videoInfo) {
        throw makeUserError('无法获取视频信息');
      }

      const cid = findCidForPage(videoInfo, page);
      if (!cid) {
        throw makeUserError('无法获取 CID', videoInfo);
      }

      const tracks = await getSubtitleTracks(bvid, cid);
      if (!tracks.length) {
        throw makeUserError('当前视频没有字幕轨');
      }

      const track = chooseSubtitleTrack(tracks);
      const subtitleUrl = normalizeSubtitleUrl(track && track.subtitle_url);
      if (!subtitleUrl) {
        throw makeUserError('字幕 URL 为空', track);
      }

      const subtitleJson = await fetchSubtitleJson(subtitleUrl);
      const body = normalizeSubtitleBody(subtitleJson && subtitleJson.body);
      if (!body.length) {
        throw makeUserError('字幕正文为空', subtitleJson);
      }

      const format = getExportFormat();
      const exportData = {
        title: videoInfo.title,
        source: SOURCE_NAME,
        url: buildVideoUrl(bvid, page),
        bvid,
        cid,
        page,
        track,
        body
      };
      const outputText = getOutputText(format, exportData);
      const fileName = `${videoInfo.title}_${bvid}_P${page}.${format}`;

      downloadText(outputText, fileName, getMimeType(format));
    } catch (error) {
      reportError(error);
    }
  }

  function addFloatingButton() {
    if (document.getElementById('bili-subtitle-extractor-button')) {
      return;
    }

    const button = document.createElement('button');
    button.id = 'bili-subtitle-extractor-button';
    button.type = 'button';
    button.textContent = '提取字幕';
    button.style.position = 'fixed';
    button.style.right = '24px';
    button.style.bottom = '24px';
    button.style.zIndex = '99999';
    button.style.padding = '10px 14px';
    button.style.border = '0';
    button.style.borderRadius = '6px';
    button.style.background = '#00a1d6';
    button.style.color = '#fff';
    button.style.fontSize = '14px';
    button.style.fontWeight = '600';
    button.style.lineHeight = '1';
    button.style.boxShadow = '0 4px 14px rgba(0, 0, 0, 0.18)';
    button.style.cursor = 'pointer';
    button.addEventListener('click', extractSubtitle);
    document.body.appendChild(button);
  }

  if (typeof GM_registerMenuCommand === 'function') {
    GM_registerMenuCommand('提取当前 B 站字幕', extractSubtitle);
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', addFloatingButton, { once: true });
  } else {
    addFloatingButton();
  }
})();
