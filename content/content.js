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
  let hasUserScrolled = false;
  let initialPostKeys = new Set();
  const activeThreadGroups = [];
  let expandingCollapsedThreads = false;
  const THROTTLE_MS = 800;
  const MAX_IMPRESSIONS_FETCH = 25;

  function isThreadsPage() {
    const u = window.location.href;
    return /threads\.(net|com)/i.test(u);
  }

  function getPostKey(link) {
    try {
      const href = link.getAttribute('href') || link.href || '';
      const path = href.replace(/^https?:\/\/[^/]+/, '').replace(/\?.*$/, '');
      const postPath = path.match(/^(\/@[^/]+\/post\/[^/?#]+)/)?.[1] || path.match(/^(\/post\/[^/?#]+)/)?.[1];
      if (postPath) return postPath;
      return path || href;
    } catch {
      return '';
    }
  }

  function getCanonicalPostUrl(link) {
    const postKey = getPostKey(link);
    if (postKey && postKey.startsWith('/')) return new URL(postKey, window.location.origin).href;
    const href = link.getAttribute('href') || link.href || '';
    return href.startsWith('http') ? href : new URL(href, window.location.origin).href;
  }

  function getPostKeysIn(root) {
    const keys = new Set();
    if (!root || !root.querySelectorAll) return keys;
    if (root.matches?.(POST_LINK_SELECTOR)) {
      const ownKey = getPostKey(root);
      if (ownKey) keys.add(ownKey);
    }
    root.querySelectorAll(POST_LINK_SELECTOR).forEach((a) => {
      const key = getPostKey(a);
      if (key) keys.add(key);
    });
    return keys;
  }

  function isUsablePostRoot(root) {
    if (!root || root.nodeType !== 1) return false;
    if (root.closest?.('#ts-export-panel')) return false;
    if (!root.querySelector?.(POST_LINK_SELECTOR)) return false;
    return Boolean(root.querySelector('time') || root.querySelector('a[href*="/@"]') || root.querySelector('[dir="auto"]'));
  }

  function getPostRoot(link) {
    const postKey = getPostKey(link);
    let bestSinglePostRoot = null;
    let lastSinglePostAncestor = null;

    for (let el = link.parentElement; el && el !== document.body; el = el.parentElement) {
      if (el.id === 'ts-export-panel') break;
      const keys = getPostKeysIn(el);
      if (!keys.has(postKey)) continue;
      if (keys.size > 1) break;

      lastSinglePostAncestor = el;
      if (isUsablePostRoot(el)) {
        bestSinglePostRoot = el;
      }
    }

    if (bestSinglePostRoot) return bestSinglePostRoot;
    if (lastSinglePostAncestor) return lastSinglePostAncestor;

    let broadFallback = null;
    for (const sel of POST_ROOT_SELECTORS) {
      const root = link.closest(sel);
      if (!root || !root.contains(link)) continue;
      const keys = getPostKeysIn(root);
      if (keys.size <= 1) return root;
      if (!broadFallback && keys.has(postKey)) broadFallback = root;
    }
    if (broadFallback) return broadFallback;

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
    const ownKey = getPostKey(link);
    let parent = root.parentElement;
    for (let i = 0; i < 25 && parent; i++) {
      const keys = getPostKeysIn(parent);
      if (keys.size > 1 && keys.has(ownKey)) {
        const siblingPostRoots = Array.from(parent.querySelectorAll(POST_LINK_SELECTOR))
          .map((a) => getPostRoot(a))
          .filter(Boolean);
        if (siblingPostRoots.some((candidate) => candidate !== root && candidate.contains(root))) return true;
      }
      parent = parent.parentElement;
    }
    return false;
  }

  function isLikelyReplyOrQuote(root, link) {
    if (!root) return false;
    const text = (root.innerText || root.textContent || '').trim();
    if (!text) return false;

    // Threads UI の文言ゆらぎに対応するため、複数言語の代表語で判定
    const markers = [
      '返信',
      'に返信しました',
      'Replying to',
      'Replied to',
      'quote',
      'quoted',
      '引用',
      'を引用',
      'repost',
      'reposted',
    ];
    const lower = text.toLowerCase();
    if (markers.some((m) => lower.includes(m.toLowerCase()))) return true;

    // 異なる /post/ リンクが同一カード内に複数ある場合は引用カードの可能性が高い
    const hrefs = new Set();
    root.querySelectorAll(POST_LINK_SELECTOR).forEach((a) => {
      const href = (a.getAttribute('href') || a.href || '').replace(/\?.*$/, '');
      if (href) hrefs.add(href);
    });
    const currentHref = (link.getAttribute('href') || link.href || '').replace(/\?.*$/, '');
    if (hrefs.size >= 2 && hrefs.has(currentHref)) return true;

    return false;
  }

  function isUiOnlyPostText(text) {
    const normalized = String(text || '')
      .replace(/\s+/g, '')
      .trim()
      .toLowerCase();
    if (!normalized) return true;

    const moreLabels = [
      'もっと見る',
      'もっとみる',
      'さらに表示',
      'seemore',
      'showmore',
    ];
    if (moreLabels.includes(normalized)) return true;

    const relativeTime = '(たった今|\\d+秒|\\d+分|\\d+時間|\\d+日|\\d+週間|\\d+か月|\\d+ヶ月|\\d+年|\\d+s|\\d+m|\\d+h|\\d+d|\\d+w|\\d+mo|\\d+y)';
    const more = '(もっと見る|もっとみる|さらに表示|seemore|showmore)';
    if (new RegExp(`^${relativeTime}${more}$`, 'i').test(normalized)) return true;
    if (new RegExp(`^${relativeTime}$`, 'i').test(normalized)) return true;

    return false;
  }

  function cleanUiTextFromPost(text) {
    return String(text || '')
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .filter((line) => !/^他\d+件を見る$/.test(line))
      .filter((line) => !/^他\d+件を表示$/.test(line))
      .filter((line) => !/^(view|show)\d+more$/i.test(line.replace(/\s+/g, '')))
      .join('\n')
      .trim();
  }

  function getThreadPartInfo(text) {
    const cleaned = String(text || '').replace(/\u00a0/g, ' ');
    const match = cleaned.match(/(?:^|[\s\n])(\d{1,2})\s*\/\s*(\d{1,2})(?=$|[\s\n])/);
    if (!match) return null;
    const index = Number(match[1]);
    const total = Number(match[2]);
    if (!Number.isFinite(index) || !Number.isFinite(total)) return null;
    if (index < 1 || total < 2 || index > total || total > 20) return null;
    return { index, total };
  }

  function mergeThreadPost(data, postKey, partInfo) {
    if (!partInfo) return false;

    let group = activeThreadGroups.find((g) => {
      if (g.authorUsername !== data.author_username) return false;
      if (g.total !== partInfo.total) return false;
      if (g.parts.has(partInfo.index)) return false;
      const indexes = Array.from(g.parts.keys());
      const maxIndex = indexes.length ? Math.max(...indexes) : 0;
      return partInfo.index === maxIndex + 1 || partInfo.index === 1;
    });

    if (!group && partInfo.index === 1) {
      data.id = collectedPosts.length + 1;
      group = {
        authorUsername: data.author_username,
        total: partInfo.total,
        row: data,
        rowIndex: collectedPosts.length,
        parts: new Map(),
        keys: new Set(),
      };
      activeThreadGroups.push(group);
      collectedPosts.push(data);
    }

    if (!group) return false;

    group.parts.set(partInfo.index, cleanUiTextFromPost(data.post_text));
    group.keys.add(postKey);

    const ordered = [];
    for (let i = 1; i <= group.total; i++) {
      const part = group.parts.get(i);
      if (part) ordered.push(part);
    }
    group.row.post_text = ordered.join('\n\n').trim();
    if (partInfo.index === 1) {
      group.row.post_url = data.post_url;
      group.row.posted_at = data.posted_at;
      group.row.likes_count = data.likes_count;
      group.row.replies_count = data.replies_count;
    }

    for (const key of group.keys) collectedIds.add(key);

    if (group.parts.size >= group.total) {
      const idx = activeThreadGroups.indexOf(group);
      if (idx >= 0) activeThreadGroups.splice(idx, 1);
    }

    return true;
  }

  function clickCollapsedThreadControls() {
    if (expandingCollapsedThreads) return 0;
    const controls = Array.from(document.querySelectorAll('button, [role="button"], a'))
      .filter((el) => !el.closest('#ts-export-panel'))
      .filter((el) => {
        const text = (el.innerText || el.textContent || '').replace(/\s+/g, '').trim();
        if (!text) return false;
        return /^他\d+件を見る$/.test(text) ||
          /^他\d+件を表示$/.test(text) ||
          /^(view|show)\d+more$/i.test(text);
      });

    let clicked = 0;
    for (const control of controls.slice(0, 3)) {
      try {
        control.click();
        clicked++;
      } catch {}
    }

    if (clicked > 0) {
      expandingCollapsedThreads = true;
      setTimeout(() => {
        expandingCollapsedThreads = false;
        runScanThrottled();
      }, 1500);
    }
    return clicked;
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

    const isDateText = (t) => {
      const s = (t || '').trim();
      if (!s) return false;
      // 2026/03/24, 2026-03-24, 2026.03.24
      if (/^\d{4}[\/.\-]\d{1,2}[\/.\-]\d{1,2}$/.test(s)) return true;
      // 2026年3月24日
      if (/^\d{4}年\d{1,2}月\d{1,2}日$/.test(s)) return true;
      return false;
    };

    const cleanBodyText = (text) => {
      const lines = String(text || '')
        .split(/\r?\n/)
        .map((l) => l.trim())
        .filter(Boolean)
        .filter((l) => !isDateText(l));
      return lines.join('\n').trim();
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
        return cleanBodyText(unique.join('\n')).slice(0, 5000);
      }
    }

    // 方法2: フォールバック - span から本文候補を探す
    const allSpans = root.querySelectorAll('span');
    for (const s of allSpans) {
      const t = (s.textContent || '').trim();
      if (t.length > 10 && t.length < 5000 && !isExcludedText(t) && !s.closest('a[href*="/@"]')) {
        if (!s.querySelector('span') && !isMetricText(t)) return cleanBodyText(t);
      }
    }

    // 方法3: 最終フォールバック - root全体テキストからauthor名を除外
    const full = (root.textContent || '').trim();
    if (full.length > 5) {
      if (excludeAuthorUsername) {
        const escaped = (excludeAuthorUsername || '').replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
        const withoutAuthor = full.replace(new RegExp(escaped, 'gi'), '').trim();
        if (withoutAuthor.length > 2) return cleanBodyText(withoutAuthor).slice(0, 5000);
      }
    }
    return cleanBodyText(full).slice(0, 5000);
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
      const target = postsNeedingImpressions.slice(0, MAX_IMPRESSIONS_FETCH);
      let done = 0;
      for (const post of target) {
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
    const fullUrl = getCanonicalPostUrl(link);
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
    if (!isThreadsPage() || isPaused || !hasUserScrolled) return;
    if (clickCollapsedThreadControls() > 0) return;

    const links = document.querySelectorAll(POST_LINK_SELECTOR);
    let added = 0;
    const seenKeys = new Set();
    for (const link of links) {
      const postKey = getPostKey(link);
      if (!postKey || collectedIds.has(postKey)) continue;
      if (seenKeys.has(postKey)) continue;
      if (initialPostKeys.has(postKey)) continue;
      const root = getPostRoot(link);
      if (!root) continue;
      if (purePostsOnly && (isNestedInAnotherPost(root, link) || isLikelyReplyOrQuote(root, link))) continue;
      const data = extractPostData(root, link);
      if (!data.post_text && !data.posted_at) continue;
      if (isUiOnlyPostText(data.post_text)) continue;
      data.post_text = cleanUiTextFromPost(data.post_text);
      const partInfo = getThreadPartInfo(data.post_text);
      if (partInfo && mergeThreadPost(data, postKey, partInfo)) {
        seenKeys.add(postKey);
        added++;
        continue;
      }
      seenKeys.add(postKey);
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

  function handleScroll() {
    hasUserScrolled = true;
    runScanThrottled();
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
      activeThreadGroups.length = 0;
      hasUserScrolled = false;
      initialPostKeys = new Set();
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
    activeThreadGroups.length = 0;
    hasUserScrolled = false;
    initialPostKeys = new Set();
    document.querySelectorAll(POST_LINK_SELECTOR).forEach((link) => {
      const k = getPostKey(link);
      if (k) initialPostKeys.add(k);
    });
    if (startBtn) {
      startBtn.textContent = '⏹ ストップ';
      startBtn.classList.add('ts-btn-stop');
      startBtn.classList.remove('ts-btn-start');
    }
    // スクロール監視を開始
    window.addEventListener('scroll', handleScroll, { passive: true });
    // DOM変更の監視を開始
    mutationObserver = new MutationObserver(() => runScanThrottled());
    mutationObserver.observe(document.body, { childList: true, subtree: true });
    // 初回はスクロールされるまで収集しない
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
    window.removeEventListener('scroll', handleScroll);
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
