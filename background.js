'use strict';

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg.type === 'downloadCsv' && typeof msg.csv === 'string' && typeof msg.filename === 'string') {
    chrome.storage.session.set({ ts_csv: msg.csv, ts_filename: msg.filename }, function () {
      if (chrome.runtime.lastError) {
        sendResponse({ ok: false, error: chrome.runtime.lastError.message });
        return;
      }
      chrome.tabs.create({ url: chrome.runtime.getURL('download/download.html') });
      sendResponse({ ok: true });
    });
    return true;
  }

  if (msg.type === 'fetchImpressions' && typeof msg.postUrl === 'string') {
    fetchImpressionsFromTab(msg.postUrl)
      .then(count => sendResponse({ ok: true, impressions: count }))
      .catch(err => sendResponse({ ok: false, error: err.message, impressions: '' }));
    return true;
  }

  sendResponse({ ok: false, error: 'Unknown message type' });
  return true;
});

async function fetchImpressionsFromTab(postUrl) {
  let tab;
  try {
    // バックグラウンドで非アクティブタブとして開く
    tab = await chrome.tabs.create({ url: postUrl, active: false });

    // ページが完全にロードされるまで待つ
    await waitForTabLoad(tab.id, 20000);

    // ページが描画されるまで追加で待つ
    await sleep(3000);

    // スクリプトを注入して表示回数を取得
    const results = await chrome.scripting.executeScript({
      target: { tabId: tab.id },
      func: extractViewCount,
    });

    const count = results && results[0] && results[0].result ? results[0].result : '';
    return count;
  } catch (e) {
    return '';
  } finally {
    if (tab && tab.id) {
      try { await chrome.tabs.remove(tab.id); } catch(e) {}
    }
  }
}

function extractViewCount() {
  const text = document.body ? document.body.innerText : '';
  // 「表示1,684回」パターン
  const m = text.match(/表示([\d,.]+)回/);
  if (m) return m[1].replace(/,/g, '');
  // 英語: "1,684 views"
  const en = text.match(/([\d,]+)\s*views/i);
  if (en) return en[1].replace(/,/g, '');
  return '';
}

function waitForTabLoad(tabId, timeoutMs) {
  return new Promise((resolve, reject) => {
    const timeout = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      resolve(); // タイムアウトしても続行
    }, timeoutMs);

    const listener = (id, changeInfo) => {
      if (id === tabId && changeInfo.status === 'complete') {
        clearTimeout(timeout);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    };
    chrome.tabs.onUpdated.addListener(listener);
  });
}

function sleep(ms) {
  return new Promise(r => setTimeout(r, ms));
}
