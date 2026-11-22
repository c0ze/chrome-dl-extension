// The two library views that take over the dashboard panel: a group's
// favorites (shared with Haruna's vtag) and the videos you removed.

import { formatBytes, formatDuration, playableFavorites } from "./grouping.js";

const PAGE_SIZE = 60;
const THUMBNAIL_BATCH = 24;
// vtag files videos that sit outside any group under "other".
export const UNGROUPED_FAVORITES = "other";

export function favoritesGroupFor(handleGroup) {
  return handleGroup || UNGROUPED_FAVORITES;
}

export function initLibraryViews({ callHost, showMessage, elements, onChanged, getPlayer, getPlayerName }) {
  let mode = null; // { kind: "favorites", group } or { kind: "removed" }
  let items = [];
  let total = 0;
  const thumbnails = new Map();
  const missing = new Set();

  async function hostAction(payload, failure) {
    const response = await callHost(payload);
    if (!response?.ok) {
      throw new Error(response?.error || failure);
    }
    return response;
  }

  function button(label, title, extraClass, onClick) {
    const element = document.createElement("button");
    element.type = "button";
    element.className = `download-action-button ${extraClass}`.trim();
    element.textContent = label;
    element.title = title;
    element.addEventListener("click", onClick);
    return element;
  }

  function setVisible(open) {
    elements.libraryView.classList.toggle("hidden", !open);
    elements.downloadList.classList.toggle("hidden", open);
    elements.downloadControls.classList.toggle("hidden", open);
    elements.dashboardSummary.classList.toggle("hidden", open);
    elements.removedButton.classList.toggle("active", open && mode?.kind === "removed");
  }

  function thumbKey(item) {
    return mode?.kind === "removed" ? item.id : item.thumb;
  }

  function makeTile(item) {
    const tile = document.createElement("article");
    tile.className = "download-tile";

    const picture = document.createElement("div");
    picture.className = "tile-picture";
    const data = thumbnails.get(thumbKey(item));
    if (data) {
      const image = document.createElement("img");
      image.src = `data:image/jpeg;base64,${data}`;
      image.alt = "";
      picture.append(image);
    } else {
      picture.textContent = "No preview";
    }

    const body = document.createElement("div");
    body.className = "tile-body";
    const title = document.createElement("p");
    title.className = "download-title";
    title.textContent = item.name;
    title.title = item.relative || item.path || item.name;
    const meta = document.createElement("div");
    meta.className = "download-meta";
    const actions = document.createElement("div");
    actions.className = "download-actions";

    if (mode.kind === "favorites") {
      for (const text of [`@${item.handle}`, item.added.slice(0, 10)]) {
        const part = document.createElement("span");
        part.textContent = text;
        meta.append(part);
      }
      if (!item.exists) {
        const badge = document.createElement("span");
        badge.className = "download-status failed";
        badge.textContent = "File missing";
        picture.append(badge);
      } else {
        picture.classList.add("playable");
        picture.addEventListener("click", () => play(item));
        actions.append(
          button("Play", "Play this video here", "", () => play(item)),
          button(getPlayerName(), "Open this video in the configured player", "button-muted-small", () => {
            void fileAction("play_library_file", item.relative);
          }),
          button("Folder", "Open the containing folder", "button-muted-small", () => {
            void fileAction("open_library_folder", item.relative);
          })
        );
      }
      actions.append(
        button("★", "Remove from favorites", "favorite-button active", () => {
          void unfavorite(item);
        })
      );
      if (item.exists) {
        actions.append(
          button("Remove", "Delete this video from disk and keep it under Removed", "button-danger", () => {
            void removeFromTile(item);
          })
        );
      }
    } else {
      const parts = [`@${item.handle}`, item.group, formatBytes(item.size)];
      if (item.duration) parts.push(formatDuration(item.duration));
      parts.push(`removed ${item.removed_at.slice(0, 10)}`);
      if (item.reason !== "removed") parts.push(item.reason);
      for (const text of parts) {
        const part = document.createElement("span");
        part.textContent = text;
        meta.append(part);
      }
      if (item.favorite) {
        const badge = document.createElement("span");
        badge.className = "download-status complete";
        badge.textContent = "Was a favorite";
        picture.append(badge);
      }
      if (item.url) {
        const link = document.createElement("a");
        link.className = "download-action-button button-muted-small";
        link.href = item.url;
        link.target = "_blank";
        link.rel = "noreferrer";
        link.textContent = "Post";
        actions.append(link);
      }
      actions.append(
        button("Allow Again", "Let this video be downloaded again", "", () => {
          void allowAgain(item);
        })
      );
    }

    body.append(title, meta, actions);
    tile.append(picture, body);
    return tile;
  }

  function render() {
    if (!mode) {
      return;
    }
    const view = elements.libraryView;
    view.textContent = "";

    const bar = document.createElement("div");
    bar.className = "group-head";
    const summary = document.createElement("span");
    summary.className = "group-summary";
    bar.append(
      button("← Downloads", "Back to the download list", "button-muted-small", () => close())
    );
    if (mode.kind === "favorites") {
      elements.dashboardLabel.textContent = `Favorites in ${mode.group}`;
      summary.textContent = `${total} ${total === 1 ? "video" : "videos"}`;
      bar.append(summary);
      if (items.some((item) => item.exists)) {
        bar.append(
          button("Play All", "Open this group's favorites as a playlist in the configured player", "group-check", () => {
            void hostAction({ type: "play_favorites", group: mode.group }, "Could not play the favorites.").catch(
              (error) => showMessage("error", error.message)
            );
          })
        );
      }
    } else {
      elements.dashboardLabel.textContent = "Removed Videos";
      summary.textContent = `${total} removed. They are deleted from disk and will not be downloaded again.`;
      bar.append(summary);
    }
    view.append(bar);

    if (!items.length) {
      const empty = document.createElement("div");
      empty.className = "empty-state";
      empty.textContent = mode.kind === "favorites" ? "No favorites in this group." : "Nothing removed yet.";
      view.append(empty);
      return;
    }

    const grid = document.createElement("div");
    grid.className = "group-items tiles";
    items.forEach((item) => grid.append(makeTile(item)));
    view.append(grid);

    if (items.length < total) {
      view.append(
        button(`Show More (${total - items.length} left)`, "Load more removed videos", "button-muted-small", () => {
          void load(true);
        })
      );
    }
  }

  async function loadThumbnails() {
    const current = mode;
    const wanted = items
      .filter((item) => mode?.kind === "removed" ? item.thumb : item.exists)
      .map((item) => [thumbKey(item), mode.kind === "removed" ? item.id : item.relative])
      .filter(([key]) => !thumbnails.has(key) && !missing.has(key))
      .slice(0, THUMBNAIL_BATCH);
    if (!wanted.length) {
      return;
    }

    let received = 0;
    try {
      const response =
        mode.kind === "removed"
          ? await callHost({ type: "get_removed_thumbnails", ids: wanted.map(([, id]) => id) })
          : await callHost({ type: "get_favorite_thumbnails", paths: wanted.map(([, path]) => path) });
      for (const [key, data] of Object.entries(response?.thumbs || {})) {
        thumbnails.set(key, data);
        received += 1;
      }
    } catch (_error) {
      // Tiles stay without a picture.
    }
    if (current !== mode) {
      return;
    }
    if (!received) {
      wanted.forEach(([key]) => missing.add(key));
    }
    render();
    void loadThumbnails();
  }

  async function load(append = false) {
    const current = mode;
    try {
      if (mode.kind === "favorites") {
        const response = await hostAction({ type: "get_favorites", group: mode.group }, "Could not load the favorites.");
        items = response.items;
        total = items.length;
      } else {
        const response = await hostAction(
          { type: "get_removed", offset: append ? items.length : 0, limit: PAGE_SIZE },
          "Could not load the removed videos."
        );
        items = append ? [...items, ...response.items] : response.items;
        total = response.total;
      }
    } catch (error) {
      showMessage("error", error.message);
      items = [];
      total = 0;
    }
    if (current !== mode) {
      return;
    }
    render();
    void loadThumbnails();
  }

  async function fileAction(type, path) {
    try {
      await hostAction({ type, path }, "That did not work.");
    } catch (error) {
      showMessage("error", error.message);
    }
  }

  // Resolves to the favorite's new state. Throws when the host refused: the
  // caller says where the failure shows (the page's message, or the player).
  async function setFavorite(item, favorite) {
    const response = await hostAction(
      { type: "set_favorite", relative: item.relative, favorite },
      "Could not change the favorite."
    );
    onChanged();
    return Boolean(response.favorite);
  }

  // Resolves to true once the file is deleted, false when the confirmation was
  // declined. Throws when the host refused, like setFavorite.
  async function removeFavorite(item) {
    if (!window.confirm(`Delete ${item.name} from disk? It stays listed under Removed and will not be downloaded again.`)) {
      return false;
    }
    await hostAction({ type: "remove_library_files", paths: [item.relative], reason: "removed" }, "Could not remove the video.");
    showMessage("success", `Deleted ${item.name}.`);
    onChanged();
    return true;
  }

  // The tile's star and Remove report a failure in the page's message.
  async function unfavorite(item) {
    try {
      await setFavorite(item, false);
    } catch (error) {
      showMessage("error", error.message);
    }
    await load();
  }

  async function removeFromTile(item) {
    try {
      if (!(await removeFavorite(item))) {
        return;
      }
    } catch (error) {
      showMessage("error", error.message);
    }
    await load();
  }

  // Opens the player over this group's favorites that are still on disk. The
  // player reports a failed Favorite or Remove itself, so those handlers throw
  // instead of using the page's message; the view reloads once it closes.
  function play(item) {
    const queue = playableFavorites(items);
    const index = queue.findIndex((entry) => entry.item === item);
    if (index < 0) {
      return;
    }
    const shown = mode;
    getPlayer().open(queue, index, {
      toggleFavorite: (entry) => setFavorite(entry.item, !entry.favorite),
      remove: (entry) => removeFavorite(entry.item),
      external: (entry) => {
        void fileAction("play_library_file", entry.item.relative);
      },
      closed: () => {
        if (mode === shown) {
          void load();
        }
      },
    });
  }

  async function allowAgain(item) {
    try {
      await hostAction({ type: "allow_removed", id: item.id }, "Could not allow the video again.");
      showMessage("success", `${item.name} can be downloaded again.`);
    } catch (error) {
      showMessage("error", error.message);
    }
    await load();
  }

  function open(next) {
    mode = next;
    items = [];
    total = 0;
    setVisible(true);
    render();
    void load();
  }

  function close() {
    mode = null;
    setVisible(false);
    elements.dashboardLabel.textContent = "Download Dashboard";
    elements.libraryView.textContent = "";
  }

  elements.removedButton.addEventListener("click", () => {
    if (mode?.kind === "removed") {
      close();
    } else {
      open({ kind: "removed" });
    }
  });

  return {
    showFavorites: (group) => open({ kind: "favorites", group: favoritesGroupFor(group) }),
    refresh: () => (mode ? load() : undefined),
  };
}
