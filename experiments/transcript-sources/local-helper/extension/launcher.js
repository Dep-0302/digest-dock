document.getElementById("openBtn").addEventListener("click", async () => {
  await chrome.tabs.create({ url: chrome.runtime.getURL("probe.html") });
  window.close();
});
