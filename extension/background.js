const MENU_ID = "download-with-ytdlp";
const PROFILE_BATCH_PREFIX = "profileBatch:";

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

function twitterProfileMediaUsername(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!isTwitterHost(url.hostname)) {
      return null;
    }

    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || parts[1].toLowerCase() !== "media") {
      return null;
    }

    return /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) ? parts[0] : null;
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

async function collectProfileMediaLinks(tabId) {
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId },
    func: async () => {
      const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
      const twitterHosts = new Set([
        "twitter.com",
        "www.twitter.com",
        "mobile.twitter.com",
        "x.com",
        "www.x.com",
      ]);

      function mediaUsername(rawUrl) {
        try {
          const url = new URL(rawUrl);
          if (!twitterHosts.has(url.hostname)) {
            return null;
          }
          const parts = url.pathname.split("/").filter(Boolean);
          if (parts.length < 2 || parts[1].toLowerCase() !== "media") {
            return null;
          }
          return /^[A-Za-z0-9_]{1,15}$/.test(parts[0]) ? parts[0] : null;
        } catch (_error) {
          return null;
        }
      }

      const username = mediaUsername(window.location.href);
      if (!username) {
        return {
          ok: false,
          error: "Open an X/Twitter profile media page first.",
          urls: [],
        };
      }

      const links = new Map();

      function articleLooksVideoBacked(article) {
        if (!article) {
          return false;
        }

        if (article.querySelector("video,[data-testid='videoPlayer']")) {
          return true;
        }

        const videoishNode = article.querySelector(
          [
            "[data-testid*='video' i]",
            "[aria-label*='video' i]",
            "[aria-label*='play' i]",
            "[aria-label*='gif' i]",
          ].join(",")
        );
        if (videoishNode) {
          return true;
        }

        const text = article.innerText || "";
        if (/\bgif\b/i.test(text)) {
          return true;
        }
        return /\b\d+(?:[.,]\d+)?[KMB]?\s+views\b/i.test(text);
      }

      function statusUrlFromHref(href) {
        try {
          const url = new URL(href, window.location.href);
          if (!twitterHosts.has(url.hostname)) {
            return null;
          }

          const parts = url.pathname.split("/").filter(Boolean);
          const statusIndex = parts.findIndex((part) => part === "status");
          if (statusIndex < 1 || statusIndex + 1 >= parts.length) {
            return null;
          }

          const id = parts[statusIndex + 1];
          if (!/^\d+$/.test(id)) {
            return null;
          }

          return `https://x.com/${parts[statusIndex - 1]}/status/${id}`;
        } catch (_error) {
          return null;
        }
      }

      function collectVisibleLinks() {
        document.querySelectorAll("a[href*='/status/']").forEach((anchor) => {
          const container =
            anchor.closest("article,[data-testid='cellInnerDiv'],li") || anchor.parentElement;
          if (!anchor.href.includes("/video/") && !articleLooksVideoBacked(container)) {
            return;
          }

          const url = statusUrlFromHref(anchor.href);
          if (url) {
            links.set(url, url);
          }
        });
      }

      let stablePasses = 0;
      let lastCount = 0;
      let lastScrollY = -1;
      collectVisibleLinks();

      for (let pass = 0; pass < 36; pass += 1) {
        window.scrollBy(0, Math.max(700, Math.floor(window.innerHeight * 0.86)));
        await sleep(900);
        collectVisibleLinks();

        const didGrow = links.size > lastCount;
        const didMove = window.scrollY !== lastScrollY;
        stablePasses = didGrow || didMove ? 0 : stablePasses + 1;
        lastCount = links.size;
        lastScrollY = window.scrollY;

        if (stablePasses >= 4) {
          break;
        }
      }

      return {
        ok: true,
        username,
        urls: Array.from(links.values()),
      };
    },
  });

  return injection?.result || { ok: false, error: "Could not inspect the profile page.", urls: [] };
}

async function prepareProfileBatch(tab, url) {
  const username = twitterProfileMediaUsername(url);
  if (!username || typeof tab?.id !== "number") {
    return {};
  }

  try {
    const result = await collectProfileMediaLinks(tab.id);
    if (!result.ok) {
      return { profileScanError: result.error || "Could not scan the profile media page." };
    }
    if (result.username && result.username.toLowerCase() !== username.toLowerCase()) {
      return {
        profileScanError:
          "Open the matching X/Twitter profile media page before starting a profile download.",
      };
    }

    const key = `${PROFILE_BATCH_PREFIX}${Date.now()}:${Math.random().toString(36).slice(2)}`;
    await chrome.storage.session.set({
      [key]: {
        username: result.username || username,
        urls: Array.isArray(result.urls) ? result.urls : [],
      },
    });
    return { profileBatchKey: key };
  } catch (error) {
    return {
      profileScanError:
        error?.message || "Could not scan the profile media page. Try reloading it first.",
    };
  }
}

async function openDownloadPicker(url, source, tab) {
  if (!url) {
    openHelpPage("invalid-url");
    return;
  }

  const params = new URLSearchParams({ url, source });
  const profileBatch = await prepareProfileBatch(tab, url);
  Object.entries(profileBatch).forEach(([key, value]) => {
    if (value) {
      params.set(key, value);
    }
  });

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

  void openDownloadPicker(getTargetUrl(info, tab), "context-menu", tab);
});

chrome.action.onClicked.addListener((tab) => {
  void openDownloadPicker(normalizeUrl(tab?.url || ""), "toolbar", tab);
});
