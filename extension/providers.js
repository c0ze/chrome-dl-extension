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

    // /people/<name-segment>/<digits> — the numeric id is the key, matching
    // profile.php?id=<digits> so the same profile keys the same batch however
    // it is reached. Checked before the two-segment vanity rule below since it
    // is a structurally different (three-segment) form.
    if (parts.length === 3 && parts[0].toLowerCase() === "people") {
      if (url.searchParams.get("sk") !== "reels_tab") {
        return null;
      }
      const id = parts[2];
      return /^\d+$/.test(id) ? id : null;
    }

    if (parts.length === 2 && parts[1].toLowerCase() === "reels") {
      const candidate = parts[0];
      if (FACEBOOK_RESERVED_SEGMENTS.includes(candidate.toLowerCase())) {
        return null;
      }
      return /^(?=[A-Za-z0-9.\-]{1,60}$)(?=.*[A-Za-z0-9])[A-Za-z0-9.\-]+$/.test(candidate)
        ? candidate
        : null;
    }

    return null;
  } catch (_error) {
    return null;
  }
}

/**
 * The percent-decoded name segment from a /people/<name>/<digits> URL, or
 * null for any other URL shape. Never throws on malformed percent-encoding —
 * callers fall back to the numeric id in that case.
 */
export function facebookPeopleUrlName(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!FACEBOOK_HOSTS.includes(url.hostname)) {
      return null;
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts.length !== 3 || parts[0].toLowerCase() !== "people") {
      return null;
    }
    const decoded = decodeURIComponent(parts[1]).trim();
    return decoded || null;
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
    const fbHosts = new Set(options.hosts || []);

    function facebookReelsKeyFromLocation() {
      try {
        const url = new URL(window.location.href);
        if (!fbHosts.has(url.hostname)) {
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

        // /people/<name-segment>/<digits> — the numeric id is the key, matching
        // profile.php?id=<digits> so the same profile keys the same batch
        // however it is reached. Checked before the two-segment vanity rule
        // below since it is a structurally different (three-segment) form.
        // Kept in exact behavioural agreement with facebookProfileReelsKey and
        // its host-side counterpart facebook_profile_reels_key.
        if (parts.length === 3 && parts[0].toLowerCase() === "people") {
          if (url.searchParams.get("sk") !== "reels_tab") {
            return null;
          }
          const id = parts[2];
          return /^\d+$/.test(id) ? id : null;
        }

        if (parts.length === 2 && parts[1].toLowerCase() === "reels") {
          const candidate = parts[0];
          const reservedSegments = [
            "reel", "reels", "watch", "groups", "marketplace", "events", "pages",
            "profile.php", "story.php", "photo", "share", "people", "login",
            "settings", "messages", "notifications",
          ];
          if (reservedSegments.includes(candidate.toLowerCase())) {
            return null;
          }
          return /^(?=[A-Za-z0-9.\-]{1,60}$)(?=.*[A-Za-z0-9])[A-Za-z0-9.\-]+$/.test(candidate)
            ? candidate
            : null;
        }

        return null;
      } catch (_error) {
        return null;
      }
    }

    const facebookKey = facebookReelsKeyFromLocation();
    if (!facebookKey) {
      return { ok: false, error: "Open a Facebook profile reels page first." };
    }

    const expectedFacebookUsername = options.expectedUsername || "";
    if (expectedFacebookUsername && expectedFacebookUsername.toLowerCase() !== facebookKey.toLowerCase()) {
      return {
        ok: false,
        error: "Open the matching Facebook profile reels page before starting a profile download.",
      };
    }

    // Multilingual "this is not the profile's own content" wording. Substring
    // match, case-insensitive. Facebook class names are randomised per build
    // and per locale, so wording + ARIA structure are the only signals left.
    const suggestionWords = [
      "suggested", "suggestions", "people also watched", "reels for you", "for you",
      "you might like", "recommended",
      "おすすめ", "あなたへのおすすめ", "関連",
      "sugerencias", "para ti",
      "sugestões", "para você",
      "pour vous",
      "vorschläge", "für dich",
    ];

    // True when `node` sits inside a nested/embedded/quoted-post wrapper, i.e.
    // shared or repost content that does not belong to the scanned profile.
    function isEmbeddedFacebookContent(node, root) {
      let element = node.parentElement;
      while (element && element !== root) {
        if (element.getAttribute("role") === "article") {
          return true;
        }
        const testId = (element.getAttribute("data-testid") || "").toLowerCase();
        if (testId.includes("attachment") || testId.includes("quoted")) {
          return true;
        }
        if (element.getAttribute("role") === "link") {
          return true;
        }
        element = element.parentElement;
      }
      return false;
    }

    // True when `node` looks like a labelled content section: a `<section>`,
    // an explicit region/complementary role, or anything carrying its own
    // aria-label(ledby). These are the nodes whose label we inspect for
    // suggestion wording.
    function isSectionLike(element) {
      if (element.tagName === "SECTION") {
        return true;
      }
      const role = element.getAttribute("role");
      if (role === "region" || role === "complementary") {
        return true;
      }
      if (element.hasAttribute("aria-label") || element.hasAttribute("aria-labelledby")) {
        return true;
      }
      return false;
    }

    // First h1/h2/h3 within `element`'s own subtree, without descending into
    // a nested section-like boundary (other than `element` itself) - so a
    // high-level ancestor never inherits headings that belong to a more
    // specific nested section.
    function ownHeadingText(element) {
      const stack = Array.from(element.children);
      while (stack.length) {
        const child = stack.shift();
        if (/^H[123]$/.test(child.tagName)) {
          return (child.textContent || "").trim();
        }
        if (isSectionLike(child)) {
          continue;
        }
        stack.unshift(...Array.from(child.children));
      }
      return "";
    }

    function sectionLabel(element) {
      const ariaLabel = element.getAttribute("aria-label");
      if (ariaLabel && ariaLabel.trim()) {
        return ariaLabel.trim();
      }
      const labelledBy = element.getAttribute("aria-labelledby");
      if (labelledBy) {
        const labelNode = document.getElementById(labelledBy);
        const labelText = (labelNode?.textContent || "").trim();
        if (labelText) {
          return labelText;
        }
      }
      return ownHeadingText(element);
    }

    function looksLikeSuggestion(text) {
      const lower = text.toLowerCase();
      return suggestionWords.some((word) => lower.includes(word));
    }

    // Bias toward under-collection: any ambiguity here means "exclude".
    function isSuggestedOrUnscoped(anchor, root) {
      let node = anchor.parentElement;
      while (node && node !== root) {
        if (isSectionLike(node)) {
          const label = sectionLabel(node);
          if (label && looksLikeSuggestion(label)) {
            return true;
          }
        }
        node = node.parentElement;
      }
      return false;
    }

    function collectFacebookReels() {
      const root = document.querySelector("[role='main']");
      if (!root) {
        return [];
      }
      const found = [];
      root.querySelectorAll("a[href*='/reel/']").forEach((anchor) => {
        const resolved = new URL(anchor.href, window.location.href);
        if (!fbHosts.has(resolved.hostname)) {
          return;
        }
        if (anchor.closest("[role='complementary']")) {
          return;
        }
        if (isEmbeddedFacebookContent(anchor, root)) {
          return;
        }
        if (isSuggestedOrUnscoped(anchor, root)) {
          return;
        }
        const match = /^\/reel\/(\d+)\/?$/.exec(resolved.pathname);
        if (match) {
          found.push(`https://www.facebook.com/reel/${match[1]}`);
        }
      });
      return found;
    }

    function isPlausibleProfileName(name) {
      if (!name) {
        return false;
      }
      return name.toLowerCase() !== "facebook";
    }

    // Percent-decoded name segment from a /people/<name>/<digits> URL, or ""
    // for any other URL shape or on malformed percent-encoding. Kept in exact
    // behavioural agreement with the module-level facebookPeopleUrlName.
    function facebookPeopleUrlNameFromLocation() {
      try {
        const url = new URL(window.location.href);
        const parts = url.pathname.split("/").filter(Boolean);
        if (parts.length !== 3 || parts[0].toLowerCase() !== "people") {
          return "";
        }
        const decoded = decodeURIComponent(parts[1]).trim();
        return decoded;
      } catch (_error) {
        return "";
      }
    }

    function facebookProfileName() {
      const og = document.querySelector("meta[property='og:title']");
      const ogName = (og?.content || "").replace(/\s+/g, " ").trim();
      if (isPlausibleProfileName(ogName)) {
        return ogName;
      }
      const heading = document.querySelector("[role='main'] h1");
      const headingName = (heading?.textContent || "").replace(/\s+/g, " ").trim();
      if (isPlausibleProfileName(headingName)) {
        return headingName;
      }
      const title = (document.title || "")
        .replace(/^\(\d+\+?\)\s*/, "")
        .replace(/\s*\|\s*Facebook\s*$/i, "")
        .replace(/\s+/g, " ")
        .trim();
      if (isPlausibleProfileName(title)) {
        return title;
      }
      const urlName = facebookPeopleUrlNameFromLocation();
      return isPlausibleProfileName(urlName) ? urlName : "";
    }

    const fbSleep = (ms) => new Promise((resolve) => window.setTimeout(resolve, ms));

    const fbProgress = Object.assign(
      {
        urls: [],
        passes: 0,
        stablePasses: 0,
        lastCount: 0,
        lastScrollY: -1,
        originalScrollY: null,
        profileName: "",
      },
      options.progress || {}
    );

    if (typeof fbProgress.originalScrollY !== "number") {
      fbProgress.originalScrollY = window.scrollY;
    }

    const fbLinks = new Map();
    (fbProgress.urls || []).forEach((url) => fbLinks.set(url, url));

    function collectFacebookRound() {
      collectFacebookReels().forEach((url) => fbLinks.set(url, url));
      const name = facebookProfileName();
      if (name && !fbProgress.profileName) {
        fbProgress.profileName = name;
      }
    }

    const fbStartedAt = Date.now();
    const fbMaxPasses = options.maxPasses || 36;
    const fbBudgetMs = options.budgetMs || 4000;
    let fbDone = false;

    collectFacebookRound();

    while (true) {
      if (fbProgress.passes >= fbMaxPasses || fbProgress.stablePasses >= 4) {
        fbDone = true;
        break;
      }
      if (Date.now() - fbStartedAt >= fbBudgetMs) {
        break;
      }

      window.scrollBy(0, Math.max(700, Math.floor(window.innerHeight * 0.86)));
      await fbSleep(900);
      collectFacebookRound();

      fbProgress.passes += 1;
      const didGrow = fbLinks.size > fbProgress.lastCount;
      const didMove = window.scrollY !== fbProgress.lastScrollY;
      fbProgress.stablePasses = didGrow || didMove ? 0 : fbProgress.stablePasses + 1;
      fbProgress.lastCount = fbLinks.size;
      fbProgress.lastScrollY = window.scrollY;
    }

    fbProgress.urls = Array.from(fbLinks.values());

    return {
      ok: true,
      username: facebookKey,
      urls: fbProgress.urls,
      profileName: fbProgress.profileName,
      done: fbDone,
      progress: fbProgress,
    };
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

  return { ok: true, username, done, progress, urls: progress.urls };
}
