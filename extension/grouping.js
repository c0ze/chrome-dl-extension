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
