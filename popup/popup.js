document.getElementById('open-search').addEventListener('click', () => {
  chrome.tabs.create({ url: 'https://www.threads.net/search' });
});
