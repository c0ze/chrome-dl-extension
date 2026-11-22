// Pure helpers for the dashboard: which handle a download belongs to, and how
// downloads are grouped for display. Kept free of DOM and chrome APIs so they
// can be tested directly.

const TWITTER_HOSTS = new Set(["x.com", "www.x.com", "twitter.com", "www.twitter.com", "mobile.twitter.com"]);
export const NO_HANDLE = "";

export function jobHandle(job) {
  if (typeof job?.handle === "string" && job.handle) {
    return job.handle;
  }

  try {
    const url = new URL(job?.url || "");
    const [owner, segment] = url.pathname.split("/").filter(Boolean);
    if (TWITTER_HOSTS.has(url.hostname.toLowerCase()) && segment === "status" && owner !== "i") {
      return owner;
    }
  } catch (_error) {
    // Not a URL; it belongs with the other downloads that have no handle.
  }

  return NO_HANDLE;
}

function countStatus(jobs, status) {
  return jobs.filter((job) => job.status === status).length;
}

/**
 * Groups downloads by handle, ignoring the handle's case. Groups keep the order
 * their newest download has in the input, except that a group with a running
 * download comes first and groups with queued ones come next: what is
 * happening now must not sit below finished history.
 */
export function groupJobsByHandle(jobs) {
  const groups = new Map();
  for (const job of jobs) {
    const handle = jobHandle(job);
    const key = handle.toLowerCase();
    if (!groups.has(key)) {
      groups.set(key, { key, handle, jobs: [] });
    }
    groups.get(key).jobs.push(job);
  }

  const ranked = [...groups.values()].map((group, index) => {
    const running = countStatus(group.jobs, "running");
    const queued = countStatus(group.jobs, "queued");
    return {
      ...group,
      running,
      queued,
      complete: countStatus(group.jobs, "complete"),
      failed: countStatus(group.jobs, "failed"),
      rank: running ? 0 : queued ? 1 : 2,
      index,
    };
  });

  ranked.sort((a, b) => a.rank - b.rank || a.index - b.index);
  return ranked.map(({ rank: _rank, index: _index, ...group }) => group);
}

export function groupSummary(group) {
  const parts = [];
  if (group.running) parts.push(`${group.running} running`);
  if (group.queued) parts.push(`${group.queued} queued`);
  if (group.complete) parts.push(`${group.complete} done`);
  if (group.failed) parts.push(`${group.failed} failed`);
  const other = group.jobs.length - group.running - group.queued - group.complete - group.failed;
  if (other) parts.push(`${other} cancelled`);
  return parts.join(", ");
}

/**
 * What the inline player steps through for a handle group: its finished
 * downloads that have a file, in display order. The title is the handle, empty
 * for downloads that have none (the player adds the "@" itself).
 */
export function playableJobs(group) {
  return group.jobs
    .filter((job) => job.status === "complete" && job.filename)
    .map((job) => ({ path: job.filename, title: group.handle, favorite: Boolean(job.favorite), job }));
}

/** The same for a favorites group: the favorites whose file is still there. */
export function playableFavorites(favorites) {
  return favorites
    .filter((item) => item.exists)
    .map((item) => ({ path: item.path, title: item.handle, favorite: true, item }));
}

/**
 * Whether a finished download's video is gone once the host has answered
 * `remove_download`: deleted now, or already missing from disk. `deletes` is
 * whether this was a finished download with a file (a failed or queued one has
 * no video to remove). The host only deletes inside the library folder, so a
 * file outside it stays on disk while its list entry goes, and a file it
 * cannot look up is not known to be gone; both throw, so nothing claims a
 * deletion that did not happen. `missing` is the host's confirmed absence.
 */
export function videoRemoved(response, deletes) {
  if (response.deleted) {
    return true;
  }
  if (!deletes) {
    return false;
  }
  if (response.missing) {
    return true;
  }
  throw new Error(
    "This video was not deleted: it is outside the library folder or cannot be accessed. The download was taken off the list."
  );
}

/** "3 new", for a handle row; empty when a check found nothing. */
export function pendingLabel(count) {
  return count > 0 ? `${count} new` : "";
}

export function formatChecked(lastChecked, now = Date.now()) {
  if (!lastChecked) {
    return "never checked";
  }

  const then = new Date(String(lastChecked).replace(" ", "T")).getTime();
  if (Number.isNaN(then)) {
    return "never checked";
  }

  const minutes = Math.max(0, Math.round((now - then) / 60000));
  if (minutes < 1) return "checked just now";
  if (minutes < 60) return `checked ${minutes} min ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 48) return `checked ${hours} h ago`;
  return `checked ${Math.round(hours / 24)} days ago`;
}

export const HANDLE_SORTS = ["name", "new", "checked", "videos"];

function checkedTime(entry) {
  const time = new Date(String(entry.last_checked || "").replace(" ", "T")).getTime();
  return Number.isNaN(time) ? 0 : time;
}

/** Whether a handle matches a search: by its name or any former name. */
export function handleMatches(entry, query) {
  const wanted = query.trim().toLowerCase().replace(/^@/, "");
  if (!wanted) {
    return true;
  }
  return [entry.handle, ...(entry.aliases || [])].some((name) =>
    String(name).toLowerCase().includes(wanted)
  );
}

export function sortHandles(entries, sort) {
  const byName = (a, b) => a.handle.toLowerCase().localeCompare(b.handle.toLowerCase());
  const orders = {
    name: byName,
    new: (a, b) => b.pending_count - a.pending_count || byName(a, b),
    // Never-checked handles first: they are the ones a check is most due for.
    checked: (a, b) => checkedTime(a) - checkedTime(b) || byName(a, b),
    videos: (a, b) => b.video_count - a.video_count || byName(a, b),
  };
  return [...entries].sort(orders[sort] || byName);
}

/** The groups a handle is filed under; one creator may have a folder in several. */
export function handleGroups(entry) {
  const groups = (entry.folders || []).map((folder) => folder.group || "");
  return groups.length ? [...new Set(groups)] : [entry.group || ""];
}

/**
 * Files handles under their groups for display: a handle with folders in two
 * groups is listed in both. Groups are in name order with the ungrouped
 * handles last; empty groups are left out.
 */
export function groupHandles(entries, query, sort) {
  const groups = new Map();
  for (const entry of entries) {
    if (!handleMatches(entry, query)) {
      continue;
    }
    for (const group of handleGroups(entry)) {
      if (!groups.has(group)) {
        groups.set(group, []);
      }
      groups.get(group).push(entry);
    }
  }

  return [...groups.entries()]
    .sort(([a], [b]) => (a === "") - (b === "") || a.toLowerCase().localeCompare(b.toLowerCase()))
    .map(([group, handles]) => ({
      group,
      handles: sortHandles(handles, sort),
      pending: handles.filter((entry) => entry.pending_count).length,
    }));
}

/**
 * The chips above the handle list: one per group that has favorites, from the
 * counts the host returns (keyed by the favorites group), in name order.
 */
export function favoriteChips(counts) {
  return Object.entries(counts || {})
    .filter(([, count]) => count > 0)
    .map(([group, count]) => ({ group, count }))
    .sort((a, b) => a.group.toLowerCase().localeCompare(b.group.toLowerCase()));
}

/** The list entry for a handle, ignoring case and matching former names too. */
export function findHandleEntry(entries, handle) {
  const wanted = String(handle || "").toLowerCase();
  if (!wanted) {
    return null;
  }
  return (
    entries.find(
      (candidate) =>
        String(candidate.handle).toLowerCase() === wanted ||
        (candidate.aliases || []).some((alias) => String(alias).toLowerCase() === wanted)
    ) || null
  );
}

/**
 * Where a download from this handle goes without asking: a creator with exactly
 * one folder starts there (`auto`); one with folders in several groups waits for
 * a group choice, and `groups` says which. A profile batch names the folder's
 * base and the host adds the handle's own folder; a single post is saved
 * exactly where the path points.
 */
export function downloadPlan(entries, handle, isProfile) {
  const entry = findHandleEntry(entries, handle);
  const folders = entry?.folders || [];
  if (!folders.length) {
    return { auto: null, groups: [] };
  }
  const groups = folders.map((folder) => folder.group || "");
  if (folders.length > 1) {
    return { auto: null, groups };
  }
  const [folder] = folders;
  return {
    auto: {
      directory: isProfile ? folder.base_dir : `${folder.base_dir}/${folder.name}`,
      group: folder.group || "",
      handle: entry.handle,
    },
    groups,
  };
}

function trimSlashes(path) {
  const text = String(path || "");
  return text.replace(/\/+$/, "") || text;
}

/**
 * The folder a group button files a download in. A post goes in the handle's own
 * folder inside the group (its recorded name there, else the handle); a profile
 * batch, or a post with no handle, names the group folder itself. A group is a
 * folder under the library root, except one the host labels with an absolute
 * path (a folder outside the library), which is used as it is.
 */
export function groupDirectory(root, group, handle, entries, isProfile) {
  const groupDir = String(group).startsWith("/") ? trimSlashes(group) : `${trimSlashes(root)}/${group}`;
  if (isProfile || !handle) {
    return groupDir;
  }
  const folder = (findHandleEntry(entries, handle)?.folders || []).find((candidate) => candidate.group === group);
  return `${groupDir}/${folder?.name || handle}`;
}

/**
 * A path as the library shows it: from the root's parent folder when it is under
 * there ("media/twitter/group a"), `~/…` under the home folder, else in full.
 */
export function shortPath(path, root, home = "") {
  const full = trimSlashes(path);
  const base = trimSlashes(root);
  if (base) {
    const anchor = base.split("/").slice(0, -2).join("/") + "/";
    if (full.startsWith(anchor)) {
      return full.slice(anchor.length);
    }
  }
  const homeDir = trimSlashes(home);
  if (homeDir && full === homeDir) {
    return "~";
  }
  if (homeDir && full.startsWith(`${homeDir}/`)) {
    return `~/${full.slice(homeDir.length + 1)}`;
  }
  return full;
}

/**
 * Whether the picker may start the download itself: the creator's folder is
 * known, the user has not touched it, and nothing started yet. A profile also
 * waits for its scan to finish with videos in hand.
 */
export function autoStartReady({ auto, isProfile, scanStatus, urlCount, folderEdited, started }) {
  if (!auto || folderEdited || started) {
    return false;
  }
  return !isProfile || (scanStatus === "done" && urlCount > 0);
}

export function formatBytes(bytes) {
  const value = Number(bytes) || 0;
  if (value >= 1024 ** 3) return `${(value / 1024 ** 3).toFixed(1)} GB`;
  if (value >= 1024 ** 2) return `${(value / 1024 ** 2).toFixed(1)} MB`;
  return `${value > 0 ? Math.max(1, Math.round(value / 1024)) : 0} KB`;
}

export function formatDuration(seconds) {
  const total = Math.round(Number(seconds) || 0);
  return `${Math.floor(total / 60)}:${String(total % 60).padStart(2, "0")}`;
}

/** One line for the scan panel, from the host's scan status. */
export function scanSummary(status) {
  if (status.state === "running") {
    const count = status.total ? ` ${status.done} of ${status.total}` : "";
    return `${status.stage || "Scanning"}${count}…`;
  }
  if (status.state === "failed") {
    return status.error || "The last scan failed.";
  }
  if (!status.finished_at) {
    return "The library has not been scanned yet.";
  }
  return (
    `${status.scanned} videos scanned on ${status.finished_at}. Broken: ${status.broken_count}. ` +
    `Duplicate sets: ${status.group_count}, taking ${formatBytes(status.duplicate_bytes)} extra.`
  );
}
