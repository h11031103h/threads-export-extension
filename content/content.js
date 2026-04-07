(function () {
  'use strict';

  const POST_LINK_SELECTOR = 'a[href*="/post/"]';
  const POST_ROOT_SELECTORS = [
    'article',
    '[data-pressable-container="true"]',
    '[role="article"]',
    '[data-interactive-id]',
  ];

  let collectedPosts = [];
  const collectedIds = new Set();
  let purePostsOnly = false;
  let isPaused = true;
  let isCollecting = false;
  let panelEl = null;
  let countEl = null;
  let downloadBtn = null;
  let startBtn = null;
  let errorEl = null;
  let throttleTimer = null;
  let mutationObserver = null;
  const THROTTLE_MS = 800;

  function isThreadsPage() {
    const u = window.location.href;
    return /threads\.(net|com)/i.test(u);
  }

  function getPostKey(link) {
    try {
      const href = link.getAttribute('href') || link.href || '';
      const path = href.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
      return path || href;
    } catch {
      return '';
    }
  }

  function getPostRoot(link) {
    for (const sel of POST_ROOT_SELECTORS) {
      const root = link.closest(sel);
      if (root && root.contains(link)) return root;
    }
    let el = link;
    for (let i = 0; i < 8 && el; i++) {
      el = el.parentElement;
      if (el && (el.querySelector('time') || el.getAttribute('role') === 'article')) return el;
    }
    return link.closest('div[dir="auto"]')?.parentElement?.parentElement || link.parentElement?.parentElement?.parentElement;
  }

  function isNestedInAnotherPost(root, link) {
    const linkHref = (link.getAttribute('href') || link.href || '').trim();
    if (!linkHref) return false;
    let parent = root.parentElement;
    for (let i = 0; i < 25 && parent; i++) {
      const other = parent.querySelector?.(POST_LINK_SELECTOR);
      if (other && other !== link && parent.contains(link)) {
        const otherHref = (other.getAttribute('href') || other.href || '').trim();
        if (otherHref && otherHref !== linkHref) return true;
      }
      parent = parent.parentElement;
    }
    return false;
  }

  function getPostBodyText(root, excludeAuthorUsername, excludeDisplayName) {
    if (!root) return '';
    const exclude = new Set([
      (excludeAuthorUsername || '').trim().toLowerCase(),
      (excludeDisplayName || '').trim().toLowerCase(),
    ].filter(Boolean));

    const isExcludedText = (t) => {
      const s = (t || '').trim().toLowerCase();
      if (!s) return true;
      if (exclude.has(s)) return true;
      if (/^@[\w.]+$/.test(s)) return true;
      return false;
    };

    const isMetricText = (t) => {
      const s = (t || '').trim();
      // 数値のみ（いいね数、リプライ数等）
      if (/^[\d,.]+[KMBkmb万億]?$/.test(s)) return true;
      // 時間表記
      if (/^\d+[時分秒hmsHMS]/.test(s)) return true;
      if (/^\d+\s*(時間|分|秒|hours?|minutes?|days?|日)/.test(s)) return true;
      return false;
    };

    // 方法1: 投稿リンクの構造を利用して本文コンテナを見つける
    const postLink = root.querySelector('a[href*="/post/"]');
    const authorLink = root.querySelector('a[href*="/@"]');

    if (postLink) {
      // 投稿本文は通常、authorリンクの後、メトリクス（いいね等）の前にある
      // dir="auto" の div/span ブロックを探す
      const textBlocks = root.querySelectorAll('[dir="auto"]');
      const bodyParts = [];

      for (const block of textBlocks) {
        // authorsリンクやメトリクスボタン内のテキストは除外
        if (block.closest('a[href*="/@"]')) continue;
        if (block.closest('[role="button"]')) continue;
        if (block.closest('a[href*="/post/"]') && block.textContent.trim().length < 50) continue;

        const text = (block.textContent || '').trim();
        if (!text) continue;
        if (isExcludedText(text)) continue;
        if (isMetricText(text)) continue;
        if (text.length > 10000) continue;

        // このブロックの子に他の [dir="auto"] がある場合、親としてスキップ（子で取得するため重複回避）
        const childDirAutos = block.querySelectorAll('[dir="auto"]');
        if (childDirAutos.length > 0) {
          // ただし子のテキストが親と同じ場合は親を採用
          let childTexts = '';
          childDirAutos.forEach(c => { childTexts += (c.textContent || '').trim(); });
          if (childTexts.length >= text.length * 0.8) continue;
        }

        // 「純粋ポストのみ」などUIラベルを除外
        if (block.closest('#ts-export-panel')) continue;

        bodyParts.push(text);
      }

      if (bodyParts.length > 0) {
        // 重複排除（親子関係で同じテキストが含まれる場合）
        const unique = [];
        for (const part of bodyParts) {
          let isDuplicate = false;
          for (const existing of unique) {
            if (existing.includes(part) || part.includes(existing)) {
              // 長い方を残す
              if (part.length > existing.length) {
                unique[unique.indexOf(existing)] = part;
              }
              isDuplicate = true;
              break;
            }
          }
          if (!isDuplicate) unique.push(part);
        }
        return unique.join('\n').slice(0, 5000);
      }
    }

    // 方法2: フォールバック - span から本文候補を探す
    const allSpans = root.querySelectorAll('span');
    for (const s of allSpans) {
      const t = (s.textContent || '').trim();
      if (t.length > 10 && t.length < 5000 && !isExcludedText(t) && !s.closest('a[href*="/@"]')) {
        if (!s.querySelector('span') && !isMetricText(t)) return t;
      }
    }

    // 方法3: 最終フォールバック - root全体テキストからauthor名を除外
    const full = (root.textContent || '').trim();
    if (full.length > 5) {
      if (excludeAuthorUsername) {
        const escaped = (excludeAuthorUsername || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const withoutAuthor = full.replace(new RegExp(escaped, 'gi'), '').trim();
        if (withoutAuthor.length > 2) return withoutAuthor.slice(0, 5000);
      }
    }
    return full.slice(0, 5000);
  }

  function getFirstMatch(root, selector, attr) {
    if (!root) return '';
    const el = root.querySelector(selector);
    if (!el) return '';
    if (attr) return (el.getAttribute(attr) || '').trim();
    return (el.textContent || '').trim();
  }

  // インプレッション（表示回数）を background.js 経由で取得
  function fetchImpressionsForPost(postUrl) {
    return new Promise((resolve) => {
      chrome.runtime.sendMessage({ type: 'fetchImpressions', postUrl }, (res) => {
        if (chrome.runtime.lastError) { resolve(''); return; }
        resolve(res && res.impressions ? res.impressions : '');
      });
    });
  }

  let fetchingImpressions = false;

  async function fetchAllImpressions() {
    if (fetchingImpressions) return;
    fetchingImpressions = true;
    try {
      const postsNeedingImpressions = collectedPosts.filter(p => !p.impressions && p.post_url);
      const total = postsNeedingImpressions.length;
      let done = 0;
      for (const post of postsNeedingImpressions) {
        post.impressions = await fetchImpressionsForPost(post.post_url);
        done++;
        if (countEl) countEl.textContent = `インプ取得中: ${done}/${total}`;
      }
      updateCount();
    } finally {
      fetchingImpressions = false;
    }
  }

  function extractPostData(root, link) {
    const href = link.getAttribute('href') || link.href || '';
    const fullUrl = href.startsWith('http') ? href : new URL(href, window.location.origin).href;
    const authorLink = root.querySelector('a[href*="/@"]');
    const authorUsername = authorLink ? (authorLink.getAttribute('href') || '').replace(/.*\/@([^/]+).*/, '$1') : '';
    const authorDisplayName = authorLink ? (authorLink.textContent || '').trim() : '';
    const postText = getPostBodyText(root, authorUsername, authorDisplayName);
    const timeEl = root.querySelector('time');
    const postedAt = timeEl ? (timeEl.getAttribute('datetime') || timeEl.textContent || '').trim() : '';

    const getMetricCount = (iconLabels) => {
      for (const label of iconLabels) {
        const svg = root.querySelector(`svg[aria-label*="${label}"]`);
        if (svg) {
          const btn = svg.closest('[role="button"]');
          if (btn) {
            const text = btn.innerText || btn.textContent || '';
            const match = text.match(/[\d,.]+[KMBkmb万億]?/);
            if (match) return match[0].replace(/,/g, '');
            const btnLabel = btn.getAttribute('aria-label') || '';
            const labelMatch = btnLabel.match(/[\d,.]+[KMBkmb万億]?/);
            if (labelMatch) return labelMatch[0].replace(/,/g, '');
          }
        }
      }
      return '';
    };

    const likesCount = getMetricCount(['いいね', 'Like', 'Me gusta', "J'aime"]);
    const repliesCount = getMetricCount(['返信', 'Reply', 'Responder', 'Répondre']);

    return {
      id: 0,
      post_text: postText,
      post_url: fullUrl,
      author_username: authorUsername,
      author_display_name: authorDisplayName,
      posted_at: postedAt,
      likes_count: likesCount,
      replies_count: repliesCount,
      impressions: '',
      quotes_count: '',
      collected_at: new Date().toISOString(),
    };
  }

  function scanAndCollect() {
    if (!isThreadsPage() || isPaused) return;
    const links = document.querySelectorAll(POST_LINK_SELECTOR);
    let added = 0;
    for (const link of links) {
      const postKey = getPostKey(link);
      if (!postKey || collectedIds.has(postKey)) continue;
      const root = getPostRoot(link);
      if (!root || root.hasAttribute('data-ts-processed')) continue;
      if (purePostsOnly && isNestedInAnotherPost(root, link)) continue;
      root.setAttribute('data-ts-processed', 'true');
      const data = extractPostData(root, link);
      data.id = collectedPosts.length + 1;
      collectedIds.add(postKey);
      collectedPosts.push(data);
      added++;
    }
    if (added > 0) updateCount();
  }

  function runScanThrottled() {
    if (throttleTimer) return;
    throttleTimer = setTimeout(() => {
      throttleTimer = null;
      scanAndCollect();
    }, THROTTLE_MS);
  }

  function updateCount() {
    if (countEl) countEl.textContent = `収集: ${collectedPosts.length} 件`;
    if (downloadBtn) downloadBtn.disabled = collectedPosts.length === 0;
  }

  function showDownloadError(msg) {
    if (errorEl) {
      errorEl.textContent = msg;
      errorEl.style.display = 'block';
    } else {
      alert(msg);
    }
  }

  function clearDownloadError() {
    if (errorEl) {
      errorEl.textContent = '';
      errorEl.style.display = 'none';
    }
  }

  function escapeCsvCell(str) {
    if (str == null) return '';
    const s = String(str);
    if (/[",\n\r]/.test(s)) return '"' + s.replace(/"/g, '""') + '"';
    return s;
  }

  async function downloadCsv() {
    clearDownloadError();
    scanAndCollect();
    if (collectedPosts.length === 0) {
      showDownloadError('収集されたポストがありません。スクロールしてポストを読み込んでから再度お試しください。');
      return;
    }
    // ダウンロード前にインプレッションを取得
    if (downloadBtn) downloadBtn.disabled = true;
    await fetchAllImpressions();
    const headers = ['id', 'post_text', 'post_url', 'author_username', 'posted_at', 'likes_count', 'replies_count', 'impressions'];
    const rows = [headers.map(escapeCsvCell).join(',')];
    for (const row of collectedPosts) {
      rows.push(headers.map((h) => escapeCsvCell(row[h])).join(','));
    }
    const csv = '\uFEFF' + rows.join('\r\n');
    const now = new Date();
    const stamp =
      now.getFullYear() +
      String(now.getMonth() + 1).padStart(2, '0') +
      String(now.getDate()).padStart(2, '0') +
      '_' +
      String(now.getHours()).padStart(2, '0') +
      String(now.getMinutes()).padStart(2, '0') +
      String(now.getSeconds()).padStart(2, '0');
    const filename = `threads_posts_${stamp}.csv`;
    chrome.runtime.sendMessage({ type: 'downloadCsv', csv, filename }, function (res) {
      if (chrome.runtime.lastError) {
        showDownloadError('エラー: ' + chrome.runtime.lastError.message);
        return;
      }
      if (res && res.ok) {
        clearDownloadError();
      } else if (res && res.error) {
        showDownloadError('エラー: ' + res.error);
      }
    });
  }

  function createPanel() {
    if (panelEl) return;
    const wrap = document.createElement('div');
    wrap.id = 'ts-export-panel';
    wrap.className = 'ts-panel';
    const ver = (typeof chrome !== 'undefined' && chrome.runtime && chrome.runtime.getManifest)
      ? chrome.runtime.getManifest().version
      : '?';
    wrap.innerHTML = `
      <div class="ts-panel-header" id="ts-panel-header">すれっしゅ v${ver}</div>
      <div class="ts-panel-body">
        <label class="ts-toggle-wrap" title="表示中のタイムラインから、リプライ・引用（別ポスト内にネストされたもの）を除外して収集します。Threadsの検索コマンドでは指定できません。">
          <input type="checkbox" id="ts-pure-only" class="ts-checkbox" />
          <span class="ts-toggle-label">純粋ポストのみ収集</span>
        </label>
        <button type="button" class="ts-btn ts-btn-start" id="ts-start">▶ スタート</button>
        <div class="ts-count" id="ts-count">収集: 0 件</div>
        <div class="ts-error" id="ts-error" style="display:none;"></div>
        <button type="button" class="ts-btn ts-btn-clear" id="ts-clear">データをクリア</button>
        <button type="button" class="ts-btn ts-btn-download" id="ts-download" disabled>Download CSV</button>
      </div>
    `;
    document.body.appendChild(wrap);
    panelEl = wrap;
    countEl = document.getElementById('ts-count');
    errorEl = document.getElementById('ts-error');
    downloadBtn = document.getElementById('ts-download');
    startBtn = document.getElementById('ts-start');

    const pureCheck = document.getElementById('ts-pure-only');
    pureCheck.checked = purePostsOnly;
    pureCheck.addEventListener('change', () => {
      purePostsOnly = pureCheck.checked;
    });

    startBtn.addEventListener('click', () => {
      if (isCollecting) {
        stopCollecting();
      } else {
        startCollecting();
      }
    });

    document.getElementById('ts-clear').addEventListener('click', () => {
      stopCollecting();
      collectedPosts = [];
      collectedIds.clear();
      // data-ts-processed をリセット（スタートからやり直すため）
      document.querySelectorAll('[data-ts-processed]').forEach(el => {
        el.removeAttribute('data-ts-processed');
      });
      clearDownloadError();
      updateCount();
    });

    document.getElementById('ts-download').addEventListener('click', () => {
      downloadCsv();
    });
  }

  function startCollecting() {
    if (isCollecting) return;
    isCollecting = true;
    isPaused = false;
    if (startBtn) {
      startBtn.textContent = '⏹ ストップ';
      startBtn.classList.add('ts-btn-stop');
      startBtn.classList.remove('ts-btn-start');
    }
    // スクロール監視を開始
    window.addEventListener('scroll', runScanThrottled, { passive: true });
    // DOM変更の監視を開始
    mutationObserver = new MutationObserver(() => runScanThrottled());
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    // 現在表示されている投稿をスキャン
    scanAndCollect();
  }

  function stopCollecting() {
    if (!isCollecting) return;
    isCollecting = false;
    isPaused = true;
    if (startBtn) {
      startBtn.textContent = '▶ スタート';
      startBtn.classList.remove('ts-btn-stop');
      startBtn.classList.add('ts-btn-start');
    }
    // スクロール監視を停止
    window.removeEventListener('scroll', runScanThrottled);
    // DOM変更の監視を停止
    if (mutationObserver) {
      mutationObserver.disconnect();
      mutationObserver = null;
    }
    if (throttleTimer) {
      clearTimeout(throttleTimer);
      throttleTimer = null;
    }
  }

  function init() {
    if (!isThreadsPage()) return;
    createPanel();
    updateCount();
  }

  if (document.readyState === 'loading') {
    document.addEventListener('DOMContentLoaded', init);
  } else {
    init();
  }
})();
