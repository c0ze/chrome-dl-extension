export const TWITTER_HOSTS = [
  "twitter.com",
  "www.twitter.com",
  "mobile.twitter.com",
  "x.com",
  "www.x.com",
];

export const FACEBOOK_HOSTS = [
  "facebook.com",
  "www.facebook.com",
  "m.facebook.com",
  "web.facebook.com",
];

export const RESERVED_PROFILE_USERNAMES = [
  "home",
  "explore",
  "notifications",
  "messages",
  "i",
  "settings",
];

export function twitterProfileMediaUsername(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!TWITTER_HOSTS.includes(url.hostname)) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length < 2 || parts[1].toLowerCase() !== "media") {
      return null;
    }
    const candidate = parts[0];
    if (!/^[A-Za-z0-9_]{1,15}$/.test(candidate)) {
      return null;
    }
    return RESERVED_PROFILE_USERNAMES.includes(candidate.toLowerCase()) ? null : candidate;
  } catch (_error) {
    return null;
  }
}

export const FACEBOOK_RESERVED_SEGMENTS = [
  "reel", "reels", "watch", "groups", "marketplace", "events", "pages",
  "profile.php", "story.php", "photo", "share", "people", "login",
  "settings", "messages", "notifications",
];

export function facebookProfileReelsKey(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!FACEBOOK_HOSTS.includes(url.hostname)) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);

    if (parts.length === 1 && parts[0] === "profile.php") {
      if (url.searchParams.get("sk") !== "reels_tab") {
        return null;
      }
      const id = url.searchParams.get("id") || "";
      return /^\d+$/.test(id) ? id : null;
    }

    if (parts.length === 2 && parts[1].toLowerCase() === "reels") {
      const candidate = parts[0];
      if (FACEBOOK_RESERVED_SEGMENTS.includes(candidate.toLowerCase())) {
        return null;
      }
      return /^[A-Za-z0-9.\-]{1,60}$/.test(candidate) ? candidate : null;
    }

    return null;
  } catch (_error) {
    return null;
  }
}

export function batchTargetForUrl(rawUrl) {
  const twitterKey = twitterProfileMediaUsername(rawUrl);
  if (twitterKey) {
    return { provider: "twitter", key: twitterKey };
  }

  const facebookKey = facebookProfileReelsKey(rawUrl);
  if (facebookKey) {
    return { provider: "facebook", key: facebookKey };
  }

  return null;
}

/**
 * Runs in the scanned page. Must stay closure-free: everything it needs arrives
 * through `options` because chrome.scripting serialises the function source.
 *
 * One call scans for at most `options.budgetMs` so the service worker keeps
 * getting API responses (and therefore stays alive) while a long scan runs.
 */
export async function profileScanChunk(options) {
  if (options.provider === "facebook") {
    function collectFacebookReels() {
      const root = document.querySelector("[role='main']");
      if (!root) {
        return [];
      }
      const suggestionWords = ["suggested", "people also watched", "reels for you"];
      const found = [];
      root.querySelectorAll("a[href*='/reel/']").forEach((anchor) => {
        if (anchor.closest("[role='complementary']")) {
          return;
        }
        let node = anchor.parentElement;
        while (node && node !== root) {
          const heading = node.querySelector(":scope > h1, :scope > h2, :scope > h3");
          const text = (heading?.textContent || "").toLowerCase();
          if (text && suggestionWords.some((word) => text.includes(word))) {
            return;
          }
          node = node.parentElement;
        }
        const match = /^\/reel\/(\d+)\/?$/.exec(new URL(anchor.href, window.location.href).pathname);
        if (match) {
          found.push(`https://www.facebook.com/reel/${match[1]}`);
        }
      });
      return found;
    }

    function facebookProfileName() {
      const og = document.querySelector("meta[property='og:title']");
      if (og?.content?.trim()) {
        return og.content.trim();
      }
      const heading = document.querySelector("[role='main'] h1");
      if (heading?.textContent?.trim()) {
        return heading.textContent.trim();
      }
      const title = (document.title || "")
        .replace(/^\(\d+\+?\)\s*/, "")
        .replace(/\s*\|\s*Facebook\s*$/i, "")
        .trim();
      return title || "";
    }

    const urls = Array.from(new Set(collectFacebookReels()));
    return { ok: true, urls, profileName: facebookProfileName(), done: true };
  }

  const sleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));
  const hosts = new Set(options.hosts || []);
  const reserved = new Set(options.reserved || []);
  const usernamePattern = /^[A-Za-z0-9_]{1,15}$/;
  const videoSelector = "video,[data-testid='videoPlayer'],[data-testid='videoComponent']";

  function mediaUsername(rawUrl) {
    try {
      const url = new URL(rawUrl);
      if (!hosts.has(url.hostname)) {
        return null;
      }

      const parts = url.pathname.split("/").filter(Boolean);
      if (parts.length < 2 || parts[1].toLowerCase() !== "media") {
        return null;
      }

      const candidate = parts[0];
      if (!usernamePattern.test(candidate) || reserved.has(candidate.toLowerCase())) {
        return null;
      }

      return candidate;
    } catch (_error) {
      return null;
    }
  }

  const username = mediaUsername(window.location.href);
  if (!username) {
    return { ok: false, error: "Open an X/Twitter profile media page first." };
  }

  const expectedUsername = options.expectedUsername || "";
  if (expectedUsername && expectedUsername.toLowerCase() !== username.toLowerCase()) {
    return {
      ok: false,
      error: "Open the matching X/Twitter profile media page before starting a profile download.",
    };
  }

  const progress = Object.assign(
    {
      urls: [],
      passes: 0,
      stablePasses: 0,
      lastCount: 0,
      lastScrollY: -1,
      originalScrollY: null,
    },
    options.progress || {}
  );

  if (typeof progress.originalScrollY !== "number") {
    progress.originalScrollY = window.scrollY;
  }

  const links = new Map();
  (progress.urls || []).forEach((url) => links.set(url, url));

  // True when `node` sits inside a quoted post or an embedded article, i.e. it
  // belongs to a different author than the post `root` represents.
  function isEmbeddedContent(node, root) {
    let element = node.parentElement;
    while (element && element !== root) {
      if (element.tagName === "ARTICLE") {
        return true;
      }
      if (element.tagName === "DIV" && element.getAttribute("role") === "link") {
        return true;
      }
      element = element.parentElement;
    }
    return false;
  }

  function hasOwnVideoElement(root) {
    const nodes = root.querySelectorAll(videoSelector);
    for (const node of nodes) {
      if (!isEmbeddedContent(node, root)) {
        return true;
      }
    }
    return false;
  }

  function statusFromHref(href) {
    try {
      const url = new URL(href, window.location.href);
      if (!hosts.has(url.hostname)) {
        return null;
      }

      const parts = url.pathname.split("/").filter(Boolean);
      const statusIndex = parts.indexOf("status");
      if (statusIndex < 1 || statusIndex + 1 >= parts.length) {
        return null;
      }

      const owner = parts[statusIndex - 1];
      const id = parts[statusIndex + 1];
      if (!usernamePattern.test(owner) || !/^\d+$/.test(id)) {
        return null;
      }

      return {
        owner,
        id,
        url: `https://x.com/${owner}/status/${id}`,
        isVideoPath: (parts[statusIndex + 2] || "").toLowerCase() === "video",
      };
    } catch (_error) {
      return null;
    }
  }

  function ownedByProfile(status) {
    return Boolean(status) && status.owner.toLowerCase() === username.toLowerCase();
  }

  function ownAnchors(root) {
    const anchors = [];
    root.querySelectorAll("a[href*='/status/']").forEach((anchor) => {
      if (isEmbeddedContent(anchor, root)) {
        return;
      }
      const status = statusFromHref(anchor.getAttribute("href") || anchor.href);
      if (ownedByProfile(status)) {
        anchors.push({ anchor, status });
      }
    });
    return anchors;
  }

  // One canonical permalink per post: the timestamp anchor when present,
  // otherwise the first non-embedded status anchor owned by this profile.
  function canonicalPermalink(entries) {
    let fallback = null;
    for (const entry of entries) {
      if (entry.anchor.querySelector("time")) {
        return entry.status;
      }
      if (!fallback) {
        fallback = entry.status;
      }
    }
    return fallback;
  }

  function collectVisibleLinks() {
    document.querySelectorAll("article").forEach((article) => {
      if (isEmbeddedContent(article, document.body)) {
        return;
      }

      const entries = ownAnchors(article);
      const permalink = canonicalPermalink(entries);
      if (!permalink) {
        return;
      }

      const hasVideoAnchor = entries.some(
        (entry) => entry.status.isVideoPath && entry.status.id === permalink.id
      );
      if (!hasVideoAnchor && !hasOwnVideoElement(article)) {
        return;
      }

      links.set(permalink.url, permalink.url);
    });

    // Media-grid cells are plain anchors rather than articles.
    document.querySelectorAll("a[href*='/status/']").forEach((anchor) => {
      if (anchor.closest("article")) {
        return;
      }

      const status = statusFromHref(anchor.getAttribute("href") || anchor.href);
      if (!ownedByProfile(status)) {
        return;
      }
      if (!status.isVideoPath && !hasOwnVideoElement(anchor)) {
        return;
      }

      links.set(status.url, status.url);
    });
  }

  const startedAt = Date.now();
  const maxPasses = options.maxPasses || 36;
  const budgetMs = options.budgetMs || 4000;
  let done = false;

  collectVisibleLinks();

  while (true) {
    if (progress.passes >= maxPasses || progress.stablePasses >= 4) {
      done = true;
      break;
    }
    if (Date.now() - startedAt >= budgetMs) {
      break;
    }

    window.scrollBy(0, Math.max(700, Math.floor(window.innerHeight * 0.86)));
    await sleep(900);
    collectVisibleLinks();

    progress.passes += 1;
    const didGrow = links.size > progress.lastCount;
    const didMove = window.scrollY !== progress.lastScrollY;
    progress.stablePasses = didGrow || didMove ? 0 : progress.stablePasses + 1;
    progress.lastCount = links.size;
    progress.lastScrollY = window.scrollY;
  }

  progress.urls = Array.from(links.values());

  return { ok: true, username, done, progress };
}
