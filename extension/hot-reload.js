const HOT_RELOAD_INTERVAL_MS = 1000;
const HOT_RELOAD_WATCH = ["app.html", "app.js", "app.css", "background.js", "manifest.json"];
const HOT_RELOAD_FULL = new Set(["background.js", "manifest.json"]);

async function hotReloadSnapshot() {
  const entries = await Promise.all(
    HOT_RELOAD_WATCH.map(async (file) => {
      try {
        const res = await fetch(`${chrome.runtime.getURL(file)}?t=${Date.now()}`, { cache: "no-store" });
        return [file, await res.text()];
      } catch {
        return [file, null];
      }
    }),
  );
  return Object.fromEntries(entries);
}

(async function watchHotReload() {
  if (!globalThis.chrome?.runtime?.getURL) return;
  let baseline = await hotReloadSnapshot();
  setInterval(async () => {
    const current = await hotReloadSnapshot();
    let needsFull = false;
    let needsPage = false;
    for (const file of HOT_RELOAD_WATCH) {
      if (current[file] !== baseline[file]) {
        if (HOT_RELOAD_FULL.has(file)) needsFull = true;
        else needsPage = true;
      }
    }
    if (!needsFull && !needsPage) return;
    baseline = current;
    if (needsFull) chrome.runtime.reload();
    else location.reload();
  }, HOT_RELOAD_INTERVAL_MS);
})();
