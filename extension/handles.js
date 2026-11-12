// The handle list: every X/Twitter account in the library, filed under its
// group, with a check that looks at a profile for videos not downloaded yet.

import { formatChecked, groupHandles, handleGroups, pendingLabel } from "./grouping.js";

const SCAN_ORIGINS = ["https://x.com/*"];
const SORT_KEY = "handlesSort";
const UNGROUPED_LABEL = "No group";

export function initHandles({ callHost, showMessage, onQueued, onLoaded, elements }) {
  let handles = [];
  let groups = [];
  let busy = false;
  let progressText = "";
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
    button.disabled = busy;
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
          void simpleAction("mark_handle_seen", entry);
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
      makeButton("Remove", "Remove this handle from the list. Its folder and videos are kept.", "button-danger", () => {
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
    counts.textContent = `${group.handles.length}${group.pending ? `, ${group.pending} with new` : ""}`;
    const check = makeButton("Check", `Check the ${group.handles.length} handles in this group`, "button-muted-small group-check", (event) => {
      event.preventDefault();
      void checkHandles(group.handles);
    });
    summary.append(label, counts, check);

    const items = document.createElement("div");
    items.className = "group-items";
    group.handles.forEach((entry) => items.append(makeHandleItem(entry, group.group)));

    details.append(summary, items);
    return details;
  }

  function render() {
    for (const button of [elements.checkAllButton, elements.importButton, elements.addHandleButton]) {
      button.disabled = busy;
    }
    elements.checkAllButton.disabled = busy || !handles.length;
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
      onLoaded(handles);
    } catch (error) {
      handles = [];
      progressText = error.message || "Handle list unavailable";
    }
    render();
    progressText = "";
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
    try {
      const response = await hostAction(
        { type: "download_handle_pending", handle: entry.handle, group: rowGroup },
        "Could not queue the new videos."
      );
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

    const response = await hostAction(
      { type: "record_handle_scan", handle: entry.handle, urls: scan.urls },
      "The check could not be saved."
    );
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

  try {
    elements.handleSort.value = window.localStorage.getItem(SORT_KEY) || "name";
  } catch (_error) {
    // Keep the default order.
  }

  elements.checkAllButton.addEventListener("click", () => {
    void checkHandles(handles);
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

  return { refresh };
}
