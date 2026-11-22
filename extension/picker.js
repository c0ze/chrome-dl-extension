// The folder picker's own pieces: what kind of page it was opened for, and the
// group buttons. download.js decides when a download starts; nothing here does.

import { jobHandle } from "./grouping.js";
import { TWITTER_HOSTS, batchTargetForUrl } from "./providers.js";

function isTwitterHost(rawUrl) {
  try {
    return TWITTER_HOSTS.includes(new URL(rawUrl).hostname);
  } catch (_error) {
    return false;
  }
}

/**
 * What the picker was opened for. `twitter` is true for an X/Twitter profile or
 * post (group buttons and auto-start are for those only); `handle` is the
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

  const handle = jobHandle({ url: rawUrl });
  return { twitter: Boolean(handle) || isTwitterHost(rawUrl), handle, isProfile: false };
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
