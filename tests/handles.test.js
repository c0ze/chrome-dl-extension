import test from "node:test";
import assert from "node:assert/strict";
import { JSDOM } from "jsdom";
import { initHandles } from "../extension/handles.js";

const tick = () => new Promise((resolve) => setTimeout(resolve, 0));
const settle = async () => {
  for (let i = 0; i < 10; i += 1) await tick();
};

// A click that waits on the held permission prompt would hang the test run
// for good if the slot were not taken, so it fails instead.
const within = (promise, what) =>
  Promise.race([
    promise,
    new Promise((_resolve, reject) => setTimeout(() => reject(new Error(`${what} did not return`)), 1000)),
  ]);

const entry = (handle, pending = 0) => ({
  handle,
  name: handle,
  profile_url: `https://x.com/${handle}/media`,
  base_dir: "/srv/archive/media/twitter/group a",
  group: "group a",
  folders: [{ group: "group a", base_dir: "/srv/archive/media/twitter/group a", name: handle }],
  aliases: [],
  video_count: 3,
  known_count: 3,
  pending_count: pending,
  last_checked: null,
  checked_through: null,
  stale: null,
});

// The handle list over a fake host and a fake chrome. `scanResults[handle]` is
// the pending count a check of that profile leaves; the permission prompt and
// the scans can be held open with `holdPermission()` and `holdScans()`.
async function setup({ scanResults = {}, gone = [] } = {}) {
  const dom = new JSDOM(
    `<!doctype html><button id="check-all"></button><button id="import"></button>
     <button id="add"></button><div id="chips"></div><div id="list"></div>
     <datalist id="groups"></datalist><p id="summary"></p><input id="search">
     <select id="sort"><option value="name"></option><option value="new"></option>
     <option value="checked"></option><option value="videos"></option></select>`,
    { url: "http://localhost/" }
  );
  global.window = dom.window;
  global.document = dom.window.document;
  const $ = (id) => dom.window.document.getElementById(id);

  const entries = [entry("alice"), entry("bob")];
  const messages = [];
  const log = [];
  const scans = [];
  let permissionRequests = 0;
  let permissionGate = null;
  let scanGate = null;
  let importGate = null;
  let refreshGate = null;
  let grant = true;
  let complete = true;

  const callHost = async (payload) => {
    log.push(payload);
    const target = entries.find((candidate) => candidate.handle === payload.handle);
    switch (payload.type) {
      case "import_library":
        if (importGate) await importGate;
        return { ok: true, found: 2, videos: 6, added: 0, skipped_count: 0, in_several_groups: 0 };
      case "get_handles":
        if (refreshGate) await refreshGate;
        return { ok: true, handles: JSON.parse(JSON.stringify(entries)), groups: ["group a"], library_root: "/srv/archive/media/twitter" };
      case "get_favorites":
        return { ok: true, groups: {} };
      case "record_handle_scan":
        target.pending_count = scanResults[payload.handle] ?? 0;
        return { ok: true, handle: JSON.parse(JSON.stringify(target)) };
      case "mark_handle_seen":
        target.pending_count = 0;
        return { ok: true };
      case "download_handle_pending": {
        const queued = target.pending_count;
        target.pending_count = 0;
        return { ok: true, queued_count: queued, download_dir: "/srv/archive/media/twitter/group a/alice" };
      }
      default:
        return { ok: true };
    }
  };

  global.chrome = {
    permissions: {
      request: async () => {
        permissionRequests += 1;
        if (permissionGate) await permissionGate;
        return grant;
      },
    },
    runtime: {
      sendMessage: async (message) => {
        const handle = message.profileUrl.split("/")[3];
        scans.push(handle);
        if (scanGate) await scanGate;
        if (gone.includes(handle)) return { ok: false, gone: true };
        return { ok: true, urls: [], newestId: "1001", complete };
      },
    },
  };

  let changed = 0;
  const panel = initHandles({
    callHost,
    showMessage: (kind, text) => messages.push([kind, text]),
    onQueued: () => {},
    onLoaded: () => {},
    onChanged: () => { changed += 1; },
    onOpenFavorites: () => {},
    elements: {
      checkAllButton: $("check-all"),
      importButton: $("import"),
      addHandleButton: $("add"),
      favoriteChips: $("chips"),
      handleList: $("list"),
      handleGroups: $("groups"),
      handlesSummary: $("summary"),
      handleSearch: $("search"),
      handleSort: $("sort"),
    },
  });
  await panel.refresh();

  const open = () => {
    let release;
    const gate = new Promise((resolve) => (release = resolve));
    return [gate, release];
  };
  return {
    panel,
    entries,
    messages,
    log,
    scans,
    permissionRequests: () => permissionRequests,
    changes: () => changed,
    importButton: $("import"),
    list: $("list"),
    setComplete: (value) => { complete = value; },
    holdRefresh() {
      const [gate, release] = open();
      refreshGate = gate;
      return () => {
        refreshGate = null;
        release();
      };
    },
    holdImport() {
      const [gate, release] = open();
      importGate = gate;
      return release;
    },
    window: dom.window,
    deny: () => { grant = false; },
    allow: () => { grant = true; },
    holdPermission() {
      const [gate, release] = open();
      permissionGate = gate;
      return release;
    },
    holdScans() {
      const [gate, release] = open();
      scanGate = gate;
      return release;
    },
    entry: (handle) => panel.entryFor(handle),
  };
}

test("a second Check while the permission prompt is open does not start another check", async () => {
  const page = await setup();
  const answer = page.holdPermission();
  const first = page.panel.checkHandles([page.entry("alice")]);
  // The prompt is requested inside the click, before anything else is awaited.
  assert.equal(page.permissionRequests(), 1);

  await within(page.panel.checkHandles([page.entry("bob")]), "the second Check");
  assert.equal(page.permissionRequests(), 1, "the second click did not ask again");
  assert.deepEqual(page.messages.at(-1), ["info", "Another handle list action is still running."]);

  answer();
  await first;
  assert.deepEqual(page.scans, ["alice"], "only the first check scanned");
  assert.equal(page.panel.isChecking("alice"), false);
  assert.equal(page.panel.isChecking("bob"), false);
});

test("a check that is running stays marked until it ends, whatever else is clicked", async () => {
  const page = await setup();
  const finish = page.holdScans();
  const first = page.panel.checkHandles([page.entry("alice")]);
  await settle();
  assert.equal(page.panel.isChecking("alice"), true);

  await page.panel.checkHandles([page.entry("bob")]);
  await settle();
  assert.equal(page.panel.isChecking("alice"), true, "the second click did not end the first check's mark");
  assert.equal(page.panel.isChecking("bob"), false);
  assert.deepEqual(page.scans, ["alice"]);

  finish();
  await first;
  assert.equal(page.panel.isChecking("alice"), false);
});

test("a refused permission frees the check slot again", async () => {
  const page = await setup();
  page.deny();
  await page.panel.checkHandles([page.entry("alice")]);
  assert.deepEqual(page.messages.at(-1), ["error", "Checking profiles needs permission to read x.com."]);
  assert.deepEqual(page.scans, []);
  assert.equal(page.panel.isChecking("alice"), false);

  // The next click is a new check, not "still running".
  page.allow();
  await page.panel.checkHandles([page.entry("alice")]);
  assert.equal(page.messages.some(([, text]) => text.includes("still running")), false);
  assert.equal(page.permissionRequests(), 2);
  assert.deepEqual(page.scans, ["alice"]);
});

test("a second Check during a prompt that ends in a refusal is turned away, then the next one runs", async () => {
  const page = await setup();
  const answer = page.holdPermission();
  page.deny();
  const refused = page.panel.checkHandles([page.entry("alice")]);
  await within(page.panel.checkHandles([page.entry("bob")]), "the second Check");
  assert.equal(page.messages.at(-1)[1], "Another handle list action is still running.");
  answer();
  await refused;
  assert.deepEqual(page.messages.at(-1), ["error", "Checking profiles needs permission to read x.com."]);

  page.allow();
  await page.panel.checkHandles([page.entry("bob")]);
  assert.deepEqual(page.scans, ["bob"]);
});

test("an Import is refused while a check holds the slot, from the permission prompt to the last scan", async () => {
  const page = await setup();
  const answer = page.holdPermission();
  const finishScan = page.holdScans();
  const first = page.panel.checkHandles([page.entry("alice")]);

  // The page was redrawn inside the click, before the prompt.
  assert.equal(page.importButton.disabled, true);
  page.importButton.click();
  await settle();
  assert.equal(page.log.some((message) => message.type === "import_library"), false, "a disabled button does nothing");

  // And the action itself refuses, should a click get through.
  page.importButton.disabled = false;
  page.importButton.click();
  await settle();
  assert.deepEqual(page.messages.at(-1), ["info", "Another handle list action is still running."]);
  assert.equal(page.log.some((message) => message.type === "import_library"), false, "the Import never ran");

  answer();
  await settle();
  assert.deepEqual(page.scans, ["alice"]);
  assert.equal(page.panel.isChecking("alice"), true);
  assert.equal(page.importButton.disabled, true, "still off during the scan");

  await within(page.panel.checkHandles([page.entry("bob")]), "the second Check");
  await settle();
  assert.deepEqual(page.scans, ["alice"], "only one scan runs");
  assert.equal(page.permissionRequests(), 1);
  assert.equal(page.panel.isChecking("alice"), true, "the first check keeps its mark until its scan ends");

  finishScan();
  await first;
  assert.equal(page.panel.isChecking("alice"), false);
  assert.equal(page.importButton.disabled, false, "the Import is back once the check ends");
});

test("Edit's Save is refused and disabled while a check holds the slot", async () => {
  const page = await setup();
  const edit = [...page.list.querySelectorAll("button")].find((b) => b.textContent === "Edit");
  edit.click();
  const form = () => page.list.querySelector("form");
  assert.ok(form(), "the edit form is open");
  assert.equal(form().querySelector("[type=submit]").disabled, false);

  const answer = page.holdPermission();
  const first = page.panel.checkHandles([page.entry("bob")]);
  assert.equal(form().querySelector("[type=submit]").disabled, true, "Save is off during the prompt");
  const field = form().querySelector("input");
  field.value = "renamed";
  form().dispatchEvent(new page.window.Event("submit", { cancelable: true }));
  await settle();
  assert.equal(page.log.some((message) => message.type === "update_handle"), false, "nothing was sent");
  assert.deepEqual(page.messages.at(-1), ["info", "Another handle list action is still running."]);

  answer();
  await first;
});

test("a check that is running does not free an Import's slot either", async () => {
  const page = await setup();
  const finishImport = page.holdImport();
  page.importButton.click();
  await settle();

  await within(page.panel.checkHandles([page.entry("alice")]), "a Check during an Import");
  assert.deepEqual(page.messages.at(-1), ["info", "Another handle list action is still running."]);
  assert.equal(page.permissionRequests(), 0, "no permission is asked for while another action runs");
  finishImport();
  await settle();

  await page.panel.checkHandles([page.entry("alice")]);
  assert.deepEqual(page.scans, ["alice"]);
});

test("a check that finds nothing says so, until the next check", async () => {
  const page = await setup({ scanResults: { alice: 0 } });
  assert.equal(page.panel.foundNothingNew("alice"), false);
  await page.panel.checkHandles([page.entry("alice")]);
  assert.equal(page.panel.foundNothingNew("alice"), true);
  assert.equal(page.panel.foundNothingNew("bob"), false);
  assert.equal(page.panel.foundNothingNew("ALICE"), true, "the handle's case does not matter");

  const finish = page.holdScans();
  const again = page.panel.checkHandles([page.entry("alice")]);
  await settle();
  assert.equal(page.panel.foundNothingNew("alice"), false, "a check that is running has no result yet");
  finish();
  await again;
  assert.equal(page.panel.foundNothingNew("alice"), true);
});

test("a check that found videos never reads as nothing new, even after Seen", async () => {
  const page = await setup({ scanResults: { alice: 2 } });
  await page.panel.checkHandles([page.entry("alice")]);
  assert.equal(page.entry("alice").pending_count, 2);
  assert.equal(page.panel.foundNothingNew("alice"), false);

  await page.panel.markSeen(page.entry("alice"));
  assert.equal(page.entry("alice").pending_count, 0);
  assert.equal(page.panel.foundNothingNew("alice"), false);
});

test("a check that found videos never reads as nothing new, even after Download", async () => {
  const page = await setup({ scanResults: { alice: 3 } });
  await page.panel.checkHandles([page.entry("alice")]);
  assert.equal(page.panel.foundNothingNew("alice"), false);

  await page.panel.downloadPending(page.entry("alice"), "group a");
  assert.equal(page.entry("alice").pending_count, 0);
  assert.equal(page.panel.foundNothingNew("alice"), false);
});

test("a check that found videos after an empty one clears nothing new", async () => {
  const results = { alice: 0 };
  const page = await setup({ scanResults: results });
  await page.panel.checkHandles([page.entry("alice")]);
  assert.equal(page.panel.foundNothingNew("alice"), true);

  results.alice = 1;
  await page.panel.checkHandles([page.entry("alice")]);
  assert.equal(page.panel.foundNothingNew("alice"), false);
});

test("Seen after an empty check clears nothing new too", async () => {
  const page = await setup({ scanResults: { alice: 0 } });
  await page.panel.checkHandles([page.entry("alice")]);
  assert.equal(page.panel.foundNothingNew("alice"), true);
  await page.panel.markSeen(page.entry("alice"));
  assert.equal(page.panel.foundNothingNew("alice"), false);
});

test("the dashboard is told when a check starts and when the list refreshes", async () => {
  const page = await setup();
  const before = page.changes();
  await page.panel.checkHandles([page.entry("alice")]);
  assert.ok(page.changes() >= before + 2, "once on start, once after the refresh");
});

test("a check that found nothing but did not read everything is partial, never nothing new", async () => {
  const page = await setup({ scanResults: { alice: 0 } });
  page.setComplete(false);
  await page.panel.checkHandles([page.entry("alice")]);
  assert.equal(page.panel.foundNothingNew("alice"), false);
  assert.equal(page.panel.checkedPartial("alice"), true);
  assert.match(page.messages.at(-1)[1], /^No new videos in what was read.*Check again\.$/);

  // A later complete check replaces it.
  page.setComplete(true);
  await page.panel.checkHandles([page.entry("alice")]);
  assert.equal(page.panel.foundNothingNew("alice"), true);
  assert.equal(page.panel.checkedPartial("alice"), false);
  assert.deepEqual(page.messages.at(-1), ["info", "No new videos."]);
});

test("Seen and Download take a partial result off the handle too", async () => {
  const page = await setup({ scanResults: { alice: 0 } });
  page.setComplete(false);
  await page.panel.checkHandles([page.entry("alice")]);
  assert.equal(page.panel.checkedPartial("alice"), true);
  await page.panel.markSeen(page.entry("alice"));
  assert.equal(page.panel.checkedPartial("alice"), false);
});

test("a check that found videos is not partial-nothing even when it stopped early", async () => {
  const page = await setup({ scanResults: { alice: 2 } });
  page.setComplete(false);
  await page.panel.checkHandles([page.entry("alice")]);
  assert.equal(page.panel.checkedPartial("alice"), false);
  assert.equal(page.panel.foundNothingNew("alice"), false);
});

test("a check's summary names the accounts it found gone, whatever check starts after it", async () => {
  const page = await setup({ gone: ["alice"] });
  const release = page.holdRefresh();
  const first = page.panel.checkHandles([page.entry("alice")]);
  await settle();
  // The first check has freed its slot and waits for the refreshed list.
  const second = page.panel.checkHandles([page.entry("bob")]);
  await settle();
  release();
  await first;
  await second;

  const summaries = page.messages.map(([, text]) => text);
  assert.ok(summaries.some((text) => text.includes("Gone, marked stale: @alice")), summaries.join(" | "));
  assert.equal(
    summaries.filter((text) => text.includes("@alice")).length,
    1,
    "only the first check reports it"
  );
});

test("the queued message shows the folder the way the picker does", async () => {
  const page = await setup({ scanResults: { alice: 3 } });
  await page.panel.checkHandles([page.entry("alice")]);
  await page.panel.downloadPending(page.entry("alice"), "group a");
  assert.deepEqual(page.messages.at(-1), [
    "success",
    "Queued 3 new videos from @alice in media/twitter/group a/alice",
  ]);
});
