document.querySelector('#open-home').addEventListener('click', () => chrome.tabs.create({ url: chrome.runtime.getURL('home.html') }));
