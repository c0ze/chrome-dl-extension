// The inline player: an overlay over the downloads column that plays one
// finished video through a <video> pointing at its file:// URL, with Prev,
// Next, Favorite, Remove and the external player next to it. It needs the
// manifest's file:/// host permission and the extension's "Allow access to
// file URLs" switch. Callers own what the buttons do (see `open`).

import { OUTSIDE_LIBRARY_NOTE } from "./grouping.js";

const NO_FILE_ACCESS =
  "Turn on “Allow access to file URLs” for this extension in chrome://extensions.";
const PLAY_ERROR = "Could not play this file.";

// Each path segment is encoded on its own so `#`, `?` and `%` in a file name
// stay part of the name while the separators stay separators.
export function fileUrl(path) {
  return "file://" + path.split("/").map(encodeURIComponent).join("/");
}

// The external player's button label: the program the configured command
// runs, without its path or arguments, capitalised ("mpv --fs" -> "Mpv").
export function playerLabel(command) {
  const program = String(command ?? "").match(/^\s*(?:"([^"]*)"|'([^']*)'|(\S+))/);
  const name = (program?.[1] ?? program?.[2] ?? program?.[3] ?? "").split("/").pop();
  return name ? name[0].toUpperCase() + name.slice(1) : "Player";
}

async function checkFileAccess() {
  try {
    return Boolean(await globalThis.chrome.extension.isAllowedFileSchemeAccess());
  } catch {
    // Unknown: let the video's own error say if the file cannot be read.
    return true;
  }
}

export function createPlayer({ root, playerName }) {
  const doc = root.ownerDocument;

  function element(tag, className, text) {
    const node = doc.createElement(tag);
    if (className) node.className = className;
    if (text !== undefined) node.textContent = text;
    return node;
  }

  function actionButton(action, label, title, extraClass, onClick) {
    const button = element("button", `download-action-button ${extraClass}`, label);
    button.type = "button";
    button.title = title;
    button.dataset.action = action;
    button.addEventListener("click", onClick);
    return button;
  }

  const heading = element("span", "player-title");
  const closeButton = element("button", "icon-button player-close", "✕");
  closeButton.type = "button";
  closeButton.title = "Close (Esc)";
  closeButton.setAttribute("aria-label", "Close");
  closeButton.dataset.action = "close";
  const head = element("div", "player-head");
  head.append(heading, closeButton);

  const notice = element("p", "message error player-notice hidden");
  notice.setAttribute("role", "alert");

  // A handler that failed (Favorite, Remove): shown under the video, which
  // keeps playing, unlike `notice`, which replaces a video that cannot play.
  const failure = element("p", "message error player-notice player-failure hidden");
  failure.setAttribute("role", "alert");

  const video = element("video", "player-video");
  video.controls = true;
  video.autoplay = true;
  // Videos start muted. Turning the sound on or off with the video's own
  // control is kept for the videos after it (Prev, Next, another one opened
  // from the list) until the page is reloaded.
  let muted = true;
  video.muted = muted;
  video.addEventListener("volumechange", () => {
    muted = video.muted;
  });

  const prev = actionButton("prev", "‹ Prev", "Previous video", "button-muted-small", () => step(-1));
  const favorite = actionButton("favorite", "", "", "favorite-button", () => toggleFavorite());
  const remove = actionButton(
    "remove",
    "Remove",
    "Delete this video from disk and keep it under Removed",
    "button-danger",
    () => removeCurrent()
  );
  const external = actionButton(
    "external",
    playerName || "Player",
    "Open this video in the configured player",
    "button-muted-small",
    () => session?.handlers.external(current())
  );
  const next = actionButton("next", "Next ›", "Next video", "button-muted-small", () => step(1));
  const actions = element("div", "player-actions");
  actions.append(prev, favorite, remove, external, next);

  // For a video the host cannot act on (outside the library folder): Favorite,
  // Remove and the external player are hidden and this says why.
  const unmanaged = element("p", "player-note hidden", OUTSIDE_LIBRARY_NOTE);

  const box = element("div", "player-box");
  box.append(head, notice, video, failure, unmanaged, actions);
  root.setAttribute("role", "dialog");
  root.setAttribute("aria-label", "Video player");
  root.replaceChildren(box);

  // { items, index, handlers, busy, notifyWhenIdle } while open, otherwise null.
  let session = null;
  // null until the first open has asked Chrome; without the extension API
  // (tests, a plain page) there is nothing to ask.
  let fileAccess = typeof globalThis.chrome?.extension?.isAllowedFileSchemeAccess === "function" ? null : true;
  let fileAccessCheck = null;

  const current = () => session.items[session.index];

  function showNotice(text) {
    notice.textContent = text;
    notice.classList.remove("hidden");
    video.classList.add("hidden");
  }

  function clearNotice() {
    notice.classList.add("hidden");
    video.classList.remove("hidden");
  }

  function showFailure(what, error) {
    const reason = typeof error === "string" ? error : error?.message;
    failure.textContent = reason ? `Could not ${what}: ${reason}` : `Could not ${what}.`;
    failure.classList.remove("hidden");
  }

  function updateControls() {
    const { items, index, busy } = session;
    const item = items[index];
    const position = `${index + 1} of ${items.length}`;
    heading.textContent = item.title ? `@${item.title} · ${position}` : position;
    prev.disabled = busy || index === 0;
    next.disabled = busy || index === items.length - 1;
    favorite.disabled = busy;
    remove.disabled = busy;
    const managed = item.managed !== false;
    for (const control of [favorite, remove, external]) {
      control.classList.toggle("hidden", !managed);
    }
    unmanaged.classList.toggle("hidden", managed);
    favorite.textContent = `${item.favorite ? "★" : "☆"} Favorite`;
    favorite.title = item.favorite ? "Remove from favorites" : "Add to this group's favorites";
    favorite.classList.toggle("active", Boolean(item.favorite));
  }

  function loadCurrent() {
    if (fileAccess === null) return; // opened again once Chrome has answered
    if (fileAccess === false) {
      showNotice(NO_FILE_ACCESS);
      return;
    }
    clearNotice();
    video.muted = muted;
    video.src = fileUrl(current().path);
  }

  function show() {
    failure.classList.add("hidden");
    updateControls();
    loadCurrent();
  }

  function step(delta) {
    if (!session || session.busy) return;
    const target = session.index + delta;
    if (target < 0 || target >= session.items.length) return;
    session.index = target;
    show();
  }

  // Runs one of the caller's handlers with the buttons that change the list
  // disabled, so a second click or a step cannot overlap it. A failure is
  // shown under the video and leaves everything as it was, so the button can
  // be pressed again. `what` finishes "Could not ...".
  async function whileBusy(what, work) {
    const s = session;
    if (!s || s.busy) return;
    failure.classList.add("hidden");
    s.busy = true;
    updateControls();
    try {
      await work(s);
    } catch (error) {
      if (session === s) showFailure(what, error);
      else console.error(error); // closed meanwhile: nowhere to show it
    } finally {
      s.busy = false;
      if (session === s) updateControls();
      else if (s.notifyWhenIdle) s.handlers.closed?.();
    }
  }

  function toggleFavorite() {
    return whileBusy("update the favorite", async (s) => {
      const item = s.items[s.index];
      item.favorite = Boolean(await s.handlers.toggleFavorite(item));
    });
  }

  function removeCurrent() {
    return whileBusy("remove this file", async (s) => {
      if (!(await s.handlers.remove(s.items[s.index]))) return;
      if (session !== s) return;
      s.items.splice(s.index, 1);
      if (!s.items.length) {
        close();
        return;
      }
      s.index = Math.min(s.index, s.items.length - 1);
      show();
    });
  }

  function onKeydown(event) {
    // Esc leaves fullscreen first; only a second one closes the overlay.
    if (event.key === "Escape" && !doc.fullscreenElement) close();
  }

  video.addEventListener("error", () => {
    // Unloading the video on close can end in an error too.
    if (session && video.hasAttribute("src")) showNotice(PLAY_ERROR);
  });
  closeButton.addEventListener("click", () => close());

  // items: [{ path, title, favorite, managed? }]; the objects are the caller's,
  // and `favorite` is kept up to date on them. `managed: false` marks a video
  // outside the library folder: it plays, with no Favorite, Remove or external
  // player. handlers:
  //   toggleFavorite(item) -> Promise<boolean>  the new favorite state
  //   remove(item)         -> Promise<boolean>  true when the file was deleted
  //   external(item)                            open it in the external player
  //   closed()             optional; fires once after the overlay has closed
  //                        and after any Favorite or Remove still pending at
  //                        that moment has settled, so a caller reloading its
  //                        view in `closed` sees the final state. The overlay
  //                        itself closes at once.
  function open(items, index, handlers) {
    if (!items.length) return;
    // Opening over an open player ends that session first, which settles its
    // `closed()` and clears its failure notice.
    if (session) close();
    session = {
      items: items.slice(),
      index: Math.min(Math.max(index, 0), items.length - 1),
      handlers,
      busy: false,
      notifyWhenIdle: false,
    };
    root.classList.remove("hidden");
    doc.addEventListener("keydown", onKeydown);
    updateControls();
    if (fileAccess !== null) {
      loadCurrent();
      return;
    }
    const opened = session;
    fileAccessCheck ??= checkFileAccess().then((allowed) => {
      fileAccess = allowed;
    });
    fileAccessCheck.then(() => {
      if (session === opened) loadCurrent();
    });
  }

  function close() {
    const s = session;
    if (!s) return;
    session = null;
    video.pause();
    video.removeAttribute("src");
    video.load();
    clearNotice();
    failure.classList.add("hidden");
    root.classList.add("hidden");
    doc.removeEventListener("keydown", onKeydown);
    if (s.busy) s.notifyWhenIdle = true;
    else s.handlers.closed?.();
  }

  // The caller may only learn the external player's name after the overlay
  // was made, or even opened; this renames its button in place.
  function setPlayerName(name) {
    external.textContent = name || "Player";
  }

  return { open, close, setPlayerName };
}
