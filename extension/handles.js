// The handle list: every X/Twitter account in the library, filed under its
// group, with a check that looks at a profile for videos not downloaded yet.

import {
  favoriteChips,
  findHandleEntry,
  formatChecked,
  groupHandles,
  handleGroups,
  pendingLabel,
  shortPath,
} from "./grouping.js";
import { favoritesGroupFor } from "./library-views.js";

const SCAN_ORIGINS = ["https://x.com/*"];
const SORT_KEY = "handlesSort";
const UNGROUPED_LABEL = "No group";

export function initHandles({ callHost, showMessage, onQueued, onLoaded, onChanged, onOpenFavorites, elements }) {
  let handles = [];
  let favoriteCounts = {};
  let groups = [];
  // `busy` is held by Import and Edit/Save. A check has its own slot, taken
  // before it asks for the x.com permission and given up only by that run, so
  // no other action finishing can free it; `working()` is either.
  let busy = false;
  let checkRunning = false;
  const working = () => busy || checkRunning;
  let progressText = "";
  let libraryRoot = "";
  // Lower-cased handles: the ones in the check that is running, the ones whose
  // latest check since this page opened read everything it had to and found
  // nothing new, and the ones whose latest check found nothing but stopped
  // before it had read everything (a partial check never claims "nothing new").
  // A later check of the handle, a failed one, Download and Seen all take it
  // out of the last two sets again. The downloads pane reads them through
  // `isChecking`, `foundNothingNew` and `checkedPartial`.
  const checking = new Set();
  const foundNothing = new Set();
  const partialNothing = new Set();
  let editing = null;
  let adding = false;
  // Groups start closed (a library has hundreds of handles); a group the user
  // opened or closed keeps that state.
  const openGroups = new Map();

  function makeButton(label, title, extraClass, onClick) {
    const button = document.createElement("button");
    button.type = "button";
    button.className = `download-action-button ${extraClass}`.trim();
    button.textContent = label;
    button.title = title;
    button.disabled = working();
    button.addEventListener("click", onClick);
    return button;
  }

  function makeGroupInput(value) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "handle-input";
    input.placeholder = "Group folder (empty for none)";
    input.value = value;
    input.setAttribute("list", "handle-groups");
    input.spellcheck = false;
    return input;
  }

  function makeHandleInput(value) {
    const input = document.createElement("input");
    input.type = "text";
    input.className = "handle-input";
    input.placeholder = "handle";
    input.value = value;
    input.spellcheck = false;
    input.autocomplete = "off";
    return input;
  }

  /** The inline form used both to add a handle and to rename or move one. */
  function makeForm(entry, rowGroup = "") {
    const form = document.createElement("form");
    form.className = "handle-form";
    const handleInput = makeHandleInput(entry ? entry.handle : "");
    const groupInput = makeGroupInput(entry ? rowGroup : "");

    const note = document.createElement("p");
    note.className = "handle-meta";
    note.textContent = entry
      ? "A new handle gets its own folder and this handle's folder moves inside it. Changing the group moves the folder."
      : "Follow an account before downloading from it.";

    const actions = document.createElement("div");
    actions.className = "handle-actions";
    const save = document.createElement("button");
    save.type = "submit";
    save.className = "download-action-button";
    save.textContent = entry ? "Save" : "Add";
    save.disabled = working();
    actions.append(
      save,
      makeButton("Cancel", "Close without changing anything", "button-muted-small", () => {
        editing = null;
        adding = false;
        render();
      })
    );

    form.append(handleInput, groupInput, note, actions);
    form.addEventListener("submit", (event) => {
      event.preventDefault();
      const handle = handleInput.value.trim().replace(/^@/, "");
      const group = groupInput.value.trim();
      if (!handle) {
        handleInput.focus();
        return;
      }
      void (entry ? saveEdit(entry, rowGroup, handle, group) : addHandle(handle, group));
    });
    return form;
  }

  const rowKey = (entry, rowGroup) => `${entry.handle}\n${rowGroup}`;

  /** One handle as listed under rowGroup; its actions apply to its folder there. */
  function makeHandleItem(entry, rowGroup) {
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
    const folder = (entry.folders || []).find((candidate) => candidate.group === rowGroup);
    name.title = folder ? `${folder.base_dir}/${folder.name}` : entry.profile_url;
    head.append(name);

    if (entry.pending_count) {
      const badge = document.createElement("span");
      badge.className = "handle-new";
      badge.textContent = pendingLabel(entry.pending_count);
      head.append(badge);
    }
    if (entry.stale) {
      const badge = document.createElement("span");
      badge.className = "handle-new handle-stale";
      badge.textContent = "Stale";
      badge.title = `The account was gone on ${entry.stale}. Group checks and Check All skip it.`;
      head.append(badge);
    }

    const meta = document.createElement("p");
    meta.className = "handle-meta";
    const count = Math.max(entry.video_count, entry.known_count);
    meta.textContent = `${count} videos, ${formatChecked(entry.last_checked)}`;
    item.append(head, meta);

    if (entry.aliases.length) {
      const former = document.createElement("p");
      former.className = "handle-meta";
      former.textContent = `Formerly ${entry.aliases.map((alias) => `@${alias}`).join(", ")}`;
      item.append(former);
    }

    const elsewhere = handleGroups(entry).filter((group) => group !== rowGroup);
    if (elsewhere.length) {
      const also = document.createElement("p");
      also.className = "handle-meta";
      also.textContent = `Also in ${elsewhere.map((group) => group || UNGROUPED_LABEL).join(", ")}`;
      item.append(also);
    }

    if (editing === rowKey(entry, rowGroup)) {
      item.append(makeForm(entry, rowGroup));
      return item;
    }

    const actions = document.createElement("div");
    actions.className = "handle-actions";
    if (entry.pending_count) {
      actions.append(
        makeButton(
          "Download",
          `Queue the ${entry.pending_count} new videos into this handle's folder in ${rowGroup || "the library"}`,
          "",
          () => {
            void downloadPending(entry, rowGroup);
          }
        ),
        makeButton("Seen", "Mark the new videos as seen without downloading them", "button-muted-small", () => {
          void markSeen(entry);
        })
      );
    }
    if (entry.stale) {
      actions.append(
        makeButton("Not Stale", "Include this handle in group checks again", "button-muted-small", () => {
          void hostAction({ type: "set_handle_stale", handle: entry.handle, stale: false }, "Could not update the handle.")
            .catch((error) => showMessage("error", error.message))
            .then(refresh);
        })
      );
    }
    actions.append(
      makeButton("Check", "Look at this profile for new videos", "button-muted-small", () => {
        void checkHandles([entry]);
      }),
      makeButton("Edit", "Change the handle or its group", "button-muted-small", () => {
        editing = rowKey(entry, rowGroup);
        adding = false;
        render();
      }),
      makeButton("Unlist", "Take this handle off the list. Its folder and videos are kept.", "button-muted-small", () => {
        void simpleAction("remove_handle", entry);
      })
    );
    item.append(actions);
    return item;
  }

  function makeGroup(group, searching) {
    const details = document.createElement("details");
    details.className = "download-group";
    const holdsEdit = group.handles.some((entry) => rowKey(entry, group.group) === editing);
    details.open = searching || holdsEdit || (openGroups.get(group.group) ?? false);
    details.addEventListener("toggle", () => {
      if (!searching) {
        openGroups.set(group.group, details.open);
      }
    });

    const summary = document.createElement("summary");
    const label = document.createElement("span");
    label.className = "group-handle";
    label.textContent = group.group || UNGROUPED_LABEL;
    const counts = document.createElement("span");
    counts.className = "group-summary";
    const live = group.handles.filter((entry) => !entry.stale);
    const favoriteCount = favoriteCounts[favoritesGroupFor(group.group)] || 0;
    const staleCount = group.handles.length - live.length;
    counts.textContent =
      `${group.handles.length}` +
      (group.pending ? `, ${group.pending} with new` : "") +
      (staleCount ? `, ${staleCount} stale` : "") +
      (favoriteCount ? `, ★ ${favoriteCount}` : "");
    const check = makeButton("Check", `Check the ${live.length} handles in this group that are not stale`, "button-muted-small group-check", (event) => {
      event.preventDefault();
      void checkHandles(live);
    });
    summary.append(label, counts);
    if (live.length) {
      summary.append(check);
    }

    const items = document.createElement("div");
    items.className = "group-items";
    const favorites = favoriteCounts[favoritesGroupFor(group.group)] || 0;
    if (favorites) {
      const row = document.createElement("button");
      row.type = "button";
      row.className = "handle-favorites";
      row.title = "Show this group's favorites";
      row.textContent = `★ Favorites`;
      const count = document.createElement("span");
      count.textContent = `${favorites} ${favorites === 1 ? "video" : "videos"}`;
      row.append(count);
      row.addEventListener("click", () => onOpenFavorites(group.group));
      items.append(row);
    }
    group.handles.forEach((entry) => items.append(makeHandleItem(entry, group.group)));

    details.append(summary, items);
    return details;
  }

  function renderFavoriteChips() {
    const chips = favoriteChips(favoriteCounts);
    elements.favoriteChips.textContent = "";
    elements.favoriteChips.classList.toggle("hidden", !chips.length);
    for (const { group, count } of chips) {
      const chip = document.createElement("button");
      chip.type = "button";
      chip.className = "favorite-chip";
      chip.title = `Show the favorites in ${group}: ${count} ${count === 1 ? "video" : "videos"}`;
      chip.textContent = `★ ${group} ${count}`;
      chip.addEventListener("click", () => onOpenFavorites(group));
      elements.favoriteChips.append(chip);
    }
  }

  function render() {
    renderFavoriteChips();
    for (const button of [elements.checkAllButton, elements.importButton, elements.addHandleButton]) {
      button.disabled = working();
    }
    elements.checkAllButton.disabled = working() || !handles.length;
    elements.handleList.textContent = "";

    elements.handleGroups.textContent = "";
    groups.forEach((group) => {
      const option = document.createElement("option");
      option.value = group;
      elements.handleGroups.append(option);
    });

    const withNew = handles.filter((entry) => entry.pending_count).length;
    elements.handlesSummary.textContent =
      progressText ||
      (handles.length
        ? `${handles.length} handles${withNew ? `, ${withNew} with new videos` : ""}`
        : "No handles yet");

    if (adding) {
      const item = document.createElement("article");
      item.className = "handle-item";
      item.append(makeForm(null));
      elements.handleList.append(item);
    }

    const query = elements.handleSearch.value;
    const grouped = groupHandles(handles, query, elements.handleSort.value);
    if (!query.trim()) {
      // A group can hold favorites without any listed handle, such as videos
      // saved straight into the library folder.
      const listed = new Set(grouped.map((group) => favoritesGroupFor(group.group)));
      for (const name of Object.keys(favoriteCounts).sort()) {
        if (!listed.has(name)) {
          grouped.push({ group: name, handles: [], pending: 0 });
        }
      }
    }
    if (!grouped.length) {
      const emptyState = document.createElement("div");
      emptyState.className = "empty-state";
      emptyState.textContent = handles.length
        ? "No handle matches the search."
        : "Handles you download from are listed here. Import reads the ones already in your download folder.";
      elements.handleList.append(emptyState);
      return;
    }

    grouped.forEach((group) => elements.handleList.append(makeGroup(group, Boolean(query.trim()))));
  }

  async function refresh() {
    try {
      const response = await callHost({ type: "get_handles" });
      if (!response?.ok) {
        throw new Error(response?.error || "Could not load the handle list.");
      }
      handles = Array.isArray(response.handles) ? response.handles : [];
      groups = Array.isArray(response.groups) ? response.groups : [];
      libraryRoot = typeof response.library_root === "string" ? response.library_root : "";
      const favorites = await callHost({ type: "get_favorites" });
      favoriteCounts = favorites?.ok ? favorites.groups || {} : {};
      onLoaded(handles, groups, libraryRoot);
    } catch (error) {
      handles = [];
      progressText = error.message || "Handle list unavailable";
    }
    render();
    progressText = "";
    onChanged();
  }

  async function hostAction(payload, failure) {
    const response = await callHost(payload);
    if (!response?.ok) {
      throw new Error(response?.error || failure);
    }
    return response;
  }

  async function simpleAction(type, entry) {
    try {
      await hostAction({ type, handle: entry.handle }, "The handle list could not be updated.");
    } catch (error) {
      showMessage("error", error.message);
    }
    await refresh();
  }

  function forgetCheckResult(entry) {
    foundNothing.delete(entry.handle.toLowerCase());
    partialNothing.delete(entry.handle.toLowerCase());
  }

  function markSeen(entry) {
    forgetCheckResult(entry);
    return simpleAction("mark_handle_seen", entry);
  }

  async function addHandle(handle, group) {
    try {
      await hostAction({ type: "add_handle", handle, group }, "The handle could not be added.");
      adding = false;
      openGroups.set(group, true);
    } catch (error) {
      showMessage("error", error.message);
    }
    await refresh();
  }

  async function saveEdit(entry, rowGroup, handle, group) {
    if (working()) {
      showMessage("info", "Another handle list action is still running.");
      return;
    }
    const payload = { type: "update_handle", handle: entry.handle };
    if (handle !== entry.handle) {
      payload.new_handle = handle;
    }
    if (group !== rowGroup) {
      payload.group = group;
      payload.from_group = rowGroup;
    }

    const renamed = handle.toLowerCase() !== entry.handle.toLowerCase();
    if (renamed || "group" in payload) {
      const moves = renamed
        ? `Rename @${entry.handle} to @${handle}? Its folder moves inside the @${handle} folder, in every group it is filed under.`
        : `Move @${entry.handle} from "${rowGroup || UNGROUPED_LABEL}" to "${group || UNGROUPED_LABEL}"? Its folder moves with it.`;
      if (!window.confirm(moves)) {
        return;
      }
    }

    busy = true;
    progressText = `Updating @${entry.handle}…`;
    render();
    try {
      const response = await hostAction(payload, "The handle could not be changed.");
      editing = null;
      const folders = response.handle.folders.map((folder) => `${folder.base_dir}/${folder.name}`);
      response.handle.folders.forEach((folder) => openGroups.set(folder.group, true));
      showMessage("success", `@${response.handle.handle} is in ${folders.join(" and ")}`);
    } catch (error) {
      showMessage("error", error.message);
    } finally {
      busy = false;
      progressText = "";
    }
    await refresh();
  }

  async function importLibrary() {
    if (working()) {
      showMessage("info", "Another handle list action is still running.");
      return;
    }
    busy = true;
    progressText = "Reading the download folder…";
    render();
    try {
      const response = await hostAction({ type: "import_library" }, "The library could not be read.");
      const notes = [`Found ${response.found} handles with ${response.videos} videos, ${response.added} new to the list.`];
      if (response.skipped_count) {
        notes.push(`Folders that are not handles: ${response.skipped_count}, for example ${response.skipped.slice(0, 3).join(", ")}.`);
      }
      if (response.in_several_groups) {
        notes.push(`Handles with a folder in more than one group: ${response.in_several_groups}.`);
      }
      showMessage("success", notes.join(" "));
    } catch (error) {
      showMessage("error", error.message);
    } finally {
      busy = false;
      progressText = "";
    }
    await refresh();
  }

  async function downloadPending(entry, rowGroup) {
    forgetCheckResult(entry);
    try {
      const response = await hostAction(
        { type: "download_handle_pending", handle: entry.handle, group: rowGroup },
        "Could not queue the new videos."
      );
      showMessage(
        "success",
        `Queued ${response.queued_count} new videos from @${entry.handle} in ${shortPath(response.download_dir, libraryRoot)}`
      );
      onQueued();
    } catch (error) {
      showMessage("error", error.message);
    }
    await refresh();
  }

  /**
   * What a check of the handle found: its new videos and whether it read all it
   * had to ({ pending, complete }), or null when the account is gone.
   */
  async function checkOne(entry, staleFound) {
    const scan = await chrome.runtime.sendMessage({
      type: "check-handle",
      profileUrl: entry.profile_url,
      stopAtId: entry.checked_through || null,
    });
    if (!scan?.ok) {
      if (scan?.gone) {
        await hostAction({ type: "set_handle_stale", handle: entry.handle, stale: true }, "Could not mark the handle stale.");
        staleFound.push(entry.handle);
        return null;
      }
      throw new Error(scan?.error || "The profile could not be scanned.");
    }

    const response = await hostAction(
      {
        type: "record_handle_scan",
        handle: entry.handle,
        urls: scan.urls,
        newest_id: scan.newestId,
        complete: scan.complete,
      },
      "The check could not be saved."
    );
    return { pending: response.handle.pending_count, complete: Boolean(scan.complete) };
  }

  async function checkHandles(entries) {
    if (!entries.length) {
      return;
    }
    if (working()) {
      showMessage("info", "Another handle list action is still running.");
      return;
    }

    // The check slot is taken before the permission is asked for, so a second
    // Check during the prompt finds it taken. The request stays the first await:
    // Chrome only shows the prompt for a user gesture, and a scan cannot read a
    // tab it opened itself without it.
    checkRunning = true;
    // Drawn now, still inside the click: Import and Edit are off for the whole
    // wait. Updating the page does not use up the click the prompt needs.
    render();
    let granted = false;
    try {
      granted = await chrome.permissions.request({ origins: SCAN_ORIGINS });
    } catch (_error) {
      granted = false;
    }
    if (!granted) {
      checkRunning = false;
      render();
      showMessage("error", "Checking profiles needs permission to read x.com.");
      return;
    }

    let found = 0;
    let partial = 0;
    const failures = [];
    const staleFound = [];
    try {
      for (const entry of entries) {
        checking.add(entry.handle.toLowerCase());
        forgetCheckResult(entry);
      }
      onChanged();
      for (const [index, entry] of entries.entries()) {
        progressText = `Checking ${index + 1} of ${entries.length}: @${entry.handle}`;
        render();
        try {
          const result = await checkOne(entry, staleFound);
          if (result !== null) {
            found += result.pending;
            if (!result.complete) {
              partial += 1;
            }
            if (result.pending === 0) {
              (result.complete ? foundNothing : partialNothing).add(entry.handle.toLowerCase());
            }
          }
        } catch (error) {
          failures.push(`@${entry.handle}: ${error.message}`);
        }
      }
    } finally {
      checkRunning = false;
      progressText = "";
      checking.clear();
    }

    await refresh();
    const parts = [
      found
        ? `Found ${found} new videos.`
        : partial
          ? `No new videos in what was read, but ${partial === 1 ? "a check" : `${partial} checks`} stopped before reading everything. Check again.`
          : "No new videos.",
    ];
    if (staleFound.length) {
      parts.push(
        `Gone, marked stale: ${staleFound.slice(0, 5).map((handle) => `@${handle}`).join(", ")}` +
          (staleFound.length > 5 ? ` and ${staleFound.length - 5} more.` : ".")
      );
    }
    if (failures.length) {
      parts.push(`Could not check ${failures.length} of ${entries.length}. ${failures[0]}`);
    }
    showMessage(failures.length ? "error" : found ? "success" : "info", parts.join(" "));
  }

  try {
    elements.handleSort.value = window.localStorage.getItem(SORT_KEY) || "name";
  } catch (_error) {
    // Keep the default order.
  }

  elements.checkAllButton.addEventListener("click", () => {
    void checkHandles(handles.filter((entry) => !entry.stale));
  });
  elements.importButton.addEventListener("click", () => {
    void importLibrary();
  });
  elements.addHandleButton.addEventListener("click", () => {
    adding = !adding;
    editing = null;
    render();
  });
  elements.handleSearch.addEventListener("input", render);
  elements.handleSort.addEventListener("change", () => {
    try {
      window.localStorage.setItem(SORT_KEY, elements.handleSort.value);
    } catch (_error) {
      // The order simply does not survive a reload.
    }
    render();
  });

  return {
    refresh,
    entryFor: (handle) => findHandleEntry(handles, handle),
    checkHandles,
    downloadPending,
    markSeen,
    // True from the start of a check that includes this handle until it ends.
    isChecking: (handle) => {
      const entry = findHandleEntry(handles, handle);
      return Boolean(entry) && checking.has(entry.handle.toLowerCase());
    },
    // True when this handle's latest check since this page opened found nothing
    // new, and no Download or Seen has happened since.
    foundNothingNew: (handle) => {
      const entry = findHandleEntry(handles, handle);
      return Boolean(entry) && foundNothing.has(entry.handle.toLowerCase());
    },
    // True when the latest check found nothing but did not read everything.
    checkedPartial: (handle) => {
      const entry = findHandleEntry(handles, handle);
      return Boolean(entry) && partialNothing.has(entry.handle.toLowerCase());
    },
  };
}
