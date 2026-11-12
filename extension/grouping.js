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

/** The folder a download from this URL's handle belongs in, if the handle is known. */
export function folderForTarget(entries, handle, isProfile) {
  const wanted = String(handle || "").toLowerCase();
  if (!wanted) {
    return null;
  }
  const entry = entries.find(
    (candidate) =>
      candidate.handle.toLowerCase() === wanted ||
      (candidate.aliases || []).some((alias) => String(alias).toLowerCase() === wanted)
  );
  if (!entry || !entry.base_dir) {
    return null;
  }
  // A profile batch names its base folder and the host adds the handle's own
  // folder; a single post is saved exactly where the path points.
  return {
    entry,
    directory: isProfile ? entry.base_dir : `${entry.base_dir}/${entry.name}`,
  };
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
