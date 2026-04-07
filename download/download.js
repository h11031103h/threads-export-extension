(function () {
  'use strict';

  const msgEl = document.getElementById('msg');
  const filenameEl = document.getElementById('filename');
  const filenameWrapEl = document.getElementById('filename-wrap');

  chrome.storage.session.get(['ts_csv', 'ts_filename'], function (data) {
    if (!data.ts_csv || !data.ts_filename) {
      msgEl.textContent = 'データがありません。Threads のページで再度「Download CSV」を押してください。';
      return;
    }
    const csv = data.ts_csv;
    const filename = data.ts_filename;
    chrome.storage.session.remove(['ts_csv', 'ts_filename']);

    filenameEl.textContent = filename;
    filenameEl.href = '#';
    filenameWrapEl.style.display = 'block';
    msgEl.textContent = '下のファイル名をクリックして CSV を保存してください。';

    filenameEl.addEventListener('click', async function onDownload(e) {
      e.preventDefault();
      if (!csv || !filename) return;

      if (typeof showSaveFilePicker === 'function') {
        try {
          const handle = await showSaveFilePicker({
            suggestedName: filename,
            types: [
              { description: 'CSV ファイル', accept: { 'text/csv': ['.csv'] } },
              { description: 'すべてのファイル', accept: { '*/*': ['.csv'] } },
            ],
          });
          const writable = await handle.createWritable();
          await writable.write(csv);
          await writable.close();
          msgEl.textContent = 'CSV を保存しました。';
          return;
        } catch (err) {
          if (err.name === 'AbortError') {
            msgEl.textContent = '保存をキャンセルしました。';
            return;
          }
        }
      }

      var blob = new Blob([csv], { type: 'text/csv;charset=utf-8' });
      var url = URL.createObjectURL(blob);
      var a = document.createElement('a');
      a.href = url;
      a.download = filename;
      a.style.display = 'none';
      document.body.appendChild(a);
      a.click();
      document.body.removeChild(a);
      URL.revokeObjectURL(url);
      msgEl.textContent = 'ダウンロードを開始しました。ファイル名が違う場合は手動でリネームしてください。';
    });
  });
})();
