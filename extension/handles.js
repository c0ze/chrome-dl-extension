// The handle list: every X/Twitter account something was downloaded from, and
// a check that looks at each profile for videos that were not downloaded yet.

import { formatChecked, pendingLabel } from "./grouping.js";

const SCAN_ORIGINS = ["https://x.com/*"];

export function initHandles({ callHost, showMessage, onQueued, elements }) {
  let handles = [];
  let busy = false;
  let progressText = "";

  function makeButton(label, title, extraClass, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `download-action-button ${extraClass}`.trim();
    button.textContent = label;
    button.title = title;
    button.disabled = busy;
    button.addEventListener("click", onClick);
    return button;
  }

  function makeHandleItem(entry) {
    const item = document.createElement("article");
    item.className = entry.pending_count ? "handle-item has-new" : "handle-item";

    const head = document.createElement("div");
    head.className = "handle-head";

    const name = document.createElement("a");
    name.className = "handle-name";
    name.href = entry.profile_url;
    name.target = "_blank";
    name.rel = "noreferrer";
    name.textContent = `@${entry.handle}`;
    name.title = entry.base_dir ? `${entry.base_dir}/${entry.name}` : entry.profile_url;
    head.append(name);

    if (entry.pending_count) {
      const badge = document.createElement("span");
      badge.className = "handle-new";
      badge.textContent = pendingLabel(entry.pending_count);
      head.append(badge);
    }

    const meta = document.createElement("p");
    meta.className = "handle-meta";
    meta.textContent = `${entry.known_count} downloaded, ${formatChecked(entry.last_checked)}`;

    const actions = document.createElement("div");
    actions.className = "handle-actions";
    if (entry.pending_count) {
      actions.append(
        makeButton("Download", `Queue the ${entry.pending_count} new videos`, "", () => {
          void downloadPending(entry);
        }),
        makeButton("Seen", "Mark the new videos as seen without downloading them", "button-muted-small", () => {
          void simpleAction("mark_handle_seen", entry);
        })
      );
    }
    actions.append(
      makeButton("Check", "Look at this profile for new videos", "button-muted-small", () => {
        void checkHandles([entry]);
      }),
      makeButton("Remove", "Remove this handle from the list. Downloaded files are kept.", "button-danger", () => {
        void simpleAction("remove_handle", entry);
      })
    );

    item.append(head, meta, actions);
    return item;
  }

  function render() {
    elements.checkAllButton.disabled = busy || !handles.length;
    elements.handleList.textContent = "";

    const withNew = handles.filter((entry) => entry.pending_count).length;
    elements.handlesSummary.textContent =
      progressText ||
      (handles.length
        ? `${handles.length} handles${withNew ? `, ${withNew} with new videos` : ""}`
        : "No handles yet");

    if (!handles.length) {
      const emptyState = document.createElement("div");
      emptyState.className = "empty-state";
      emptyState.textContent = "Handles you download from are listed here.";
      elements.handleList.append(emptyState);
      return;
    }

    // Handles with something new first; the host already sorts by name.
    const ordered = [...handles].sort(
      (a, b) => Boolean(b.pending_count) - Boolean(a.pending_count)
    );
    ordered.forEach((entry) => elements.handleList.append(makeHandleItem(entry)));
  }

  async function refresh() {
    try {
      const response = await callHost({ type: "get_handles" });
      if (!response?.ok) {
        throw new Error(response?.error || "Could not load the handle list.");
      }
      handles = Array.isArray(response.handles) ? response.handles : [];
    } catch (error) {
      handles = [];
      progressText = error.message || "Handle list unavailable";
    }
    render();
    progressText = "";
  }

  async function simpleAction(type, entry) {
    try {
      const response = await callHost({ type, handle: entry.handle });
      if (!response?.ok) {
        throw new Error(response?.error || "The handle list could not be updated.");
      }
    } catch (error) {
      showMessage("error", error.message);
    }
    await refresh();
  }

  async function downloadPending(entry) {
    try {
      const response = await callHost({ type: "download_handle_pending", handle: entry.handle });
      if (!response?.ok) {
        throw new Error(response?.error || "Could not queue the new videos.");
      }
      showMessage(
        "success",
        `Queued ${response.queued_count} new videos from @${entry.handle} in ${response.download_dir}`
      );
      onQueued();
    } catch (error) {
      showMessage("error", error.message);
    }
    await refresh();
  }

  async function checkOne(entry) {
    const scan = await chrome.runtime.sendMessage({
      type: "check-handle",
      profileUrl: entry.profile_url,
    });
    if (!scan?.ok) {
      throw new Error(scan?.error || "The profile could not be scanned.");
    }

    const response = await callHost({
      type: "record_handle_scan",
      handle: entry.handle,
      urls: scan.urls,
    });
    if (!response?.ok) {
      throw new Error(response?.error || "The check could not be saved.");
    }
    return response.handle.pending_count;
  }

  async function checkHandles(entries) {
    if (busy || !entries.length) {
      return;
    }

    // Asked for here, on the click: Chrome only shows the prompt for a user
    // gesture, and a scan cannot read a tab it opened itself without it.
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: SCAN_ORIGINS });
    } catch (_error) {
      granted = false;
    }
    if (!granted) {
      showMessage("error", "Checking profiles needs permission to read x.com.");
      return;
    }

    busy = true;
    let found = 0;
    const failures = [];
    try {
      for (const [index, entry] of entries.entries()) {
        progressText = `Checking ${index + 1} of ${entries.length}: @${entry.handle}`;
        render();
        try {
          found += await checkOne(entry);
        } catch (error) {
          failures.push(`@${entry.handle}: ${error.message}`);
        }
      }
    } finally {
      busy = false;
      progressText = "";
    }

    await refresh();
    if (failures.length) {
      showMessage("error", `Could not check ${failures.length} of ${entries.length}. ${failures[0]}`);
    } else {
      showMessage(
        found ? "success" : "info",
        found ? `Found ${found} new videos.` : "No new videos."
      );
    }
  }

  elements.checkAllButton.addEventListener("click", () => {
    void checkHandles(handles);
  });

  return { refresh };
}
