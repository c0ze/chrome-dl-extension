// The folder picker's own pieces: what kind of page it was opened for, and the
// group buttons. download.js decides when a download starts; nothing here does.

import { jobHandle } from "./grouping.js";
import { RESERVED_PROFILE_USERNAMES, TWITTER_HOSTS, batchTargetForUrl } from "./providers.js";

// A post, by the shapes X serves one under, each optionally followed by sub-pages
// such as /video/1 or /photo/1:
//   /<handle>/status/<id>   the handle is a valid name and not one of X's own routes
//   /i/status/<id>          a link with no author
//   /i/web/status/<id>
// The match is anchored at the start of the path and allows no empty segment
// (/alice//status/1001 is another path, as in twitterProfileUsername): a status
// id deeper in some other page (/settings/profile/status/1001) is not a post,
// and neither are the other X pages (/home, /search, /alice/followers).
const TWITTER_POST_PATH = /^\/(i\/web|[^/]+)\/status\/\d+(?:\/[^/]+)*\/?$/;

function isTwitterPost(rawUrl) {
  try {
    const url = new URL(rawUrl);
    if (!TWITTER_HOSTS.includes(url.hostname)) {
      return false;
    }
    const match = url.pathname.match(TWITTER_POST_PATH);
    if (!match) {
      return false;
    }
    const owner = match[1];
    if (owner === "i/web" || owner === "i") {
      return true;
    }
    return /^[A-Za-z0-9_]{1,15}$/.test(owner) && !RESERVED_PROFILE_USERNAMES.includes(owner.toLowerCase());
  } catch (_error) {
    return false;
  }
}

/**
 * What the picker was opened for. `twitter` is true for an X/Twitter profile or
 * post only (group buttons and auto-start are for those); `handle` is the
 * creator when the URL names one (a post's author, a profile's own name) and ""
 * when it does not (/i/status/…); `isProfile` is true for a profile batch.
 */
export function pickerTarget(rawUrl) {
  const batch = batchTargetForUrl(rawUrl);
  if (batch?.provider === "twitter") {
    return { twitter: true, handle: batch.key, isProfile: true };
  }
  if (batch) {
    return { twitter: false, handle: "", isProfile: true };
  }
  if (isTwitterPost(rawUrl)) {
    return { twitter: true, handle: jobHandle({ url: rawUrl }), isProfile: false };
  }
  return { twitter: false, handle: "", isProfile: false };
}

/** What shows while the picker starts a download by itself. */
export function autoStartNotice(auto) {
  return `Downloading into ${[auto.group, auto.handle].filter(Boolean).join(" / ")}`;
}

/**
 * Draws one button per group into `container`, which is the whole panel: it is
 * emptied and hidden when there is nothing to show. `highlight` are the groups
 * the creator is already filed under. A group with no name has no button (a
 * folder in it would be the library root itself), and a group appears once
 * however often the plan lists it.
 */
export function renderGroupButtons(container, { groups, highlight = [], onPick }) {
  container.textContent = "";

  const shown = [...new Set(groups.filter((group) => typeof group === "string" && group.trim()))];
  container.classList.toggle("hidden", !shown.length);
  if (!shown.length) {
    return;
  }

  const held = new Set(highlight);
  const make = (tag, className) => {
    const element = container.ownerDocument.createElement(tag);
    if (className) {
      element.className = className;
    }
    return element;
  };
  const header = make("div", "panel-header");
  const text = make("div");
  const label = make("p", "label");
  label.textContent = "Groups";
  const hint = make("p", "hint");
  hint.textContent = shown.some((group) => held.has(group))
    ? "Highlighted groups already hold this creator."
    : "Click a group to download there.";
  text.append(label, hint);
  header.append(text);

  const list = make("div", "group-list");
  for (const group of shown) {
    const button = make("button", held.has(group) ? "group-button highlighted" : "group-button");
    button.type = "button";
    button.textContent = group;
    button.title = held.has(group)
      ? `Download into ${group}, where this creator already has a folder`
      : `Download into ${group}`;
    button.addEventListener("click", () => onPick(group));
    list.append(button);
  }

  container.append(header, list);
}
