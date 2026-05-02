const MENU_ID = "download-with-ytdlp";

function isTwitterHost(hostname) {
  return [
    "twitter.com",
    "www.twitter.com",
    "mobile.twitter.com",
    "x.com",
    "www.x.com",
  ].includes(hostname);
}

function normalizeUrl(rawUrl) {
  if (!rawUrl) {
    return null;
  }

  try {
    const url = new URL(rawUrl);
    if (!["http:", "https:"].includes(url.protocol)) {
      return null;
    }

    url.hash = "";
    if (isTwitterHost(url.hostname)) {
      url.search = "";
    }

    return url.toString();
  } catch (_error) {
    return null;
  }
}

function openHelpPage(reason) {
  const url = chrome.runtime.getURL(`options.html?reason=${encodeURIComponent(reason)}`);
  chrome.tabs.create({ url });
}

function getTargetUrl(info, tab) {
  return normalizeUrl(info.linkUrl || info.pageUrl || info.srcUrl || tab?.url || "");
}

function openDownloadPicker(url, source) {
  if (!url) {
    openHelpPage("invalid-url");
    return;
  }

  const params = new URLSearchParams({ url, source });
  chrome.windows.create({
    url: chrome.runtime.getURL(`download.html?${params.toString()}`),
    type: "popup",
    width: 520,
    height: 720,
  });
}

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: MENU_ID,
      title: "Download with yt-dlp",
      contexts: ["page", "link"],
    });
  });
});

chrome.contextMenus.onClicked.addListener((info, tab) => {
  if (info.menuItemId !== MENU_ID) {
    return;
  }

  openDownloadPicker(getTargetUrl(info, tab), "context-menu");
});

chrome.action.onClicked.addListener((tab) => {
  openDownloadPicker(normalizeUrl(tab?.url || ""), "toolbar");
});
