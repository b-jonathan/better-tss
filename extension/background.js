const TSS_MATCH = "https://tss.ucsd.edu/*";
const TSS_HOME = "https://tss.ucsd.edu/fiori";
const FETCH_TIMEOUT_MS = 30000;

chrome.action.onClicked.addListener(() => {
  chrome.tabs.create({ url: chrome.runtime.getURL("app.html") });
});

function waitForTabComplete(tabId, timeoutMs = 25000) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      chrome.tabs.onUpdated.removeListener(listener);
      reject(new Error("TSS tab load timed out"));
    }, timeoutMs);
    function listener(id, info) {
      if (id === tabId && info.status === "complete") {
        clearTimeout(timer);
        chrome.tabs.onUpdated.removeListener(listener);
        resolve();
      }
    }
    chrome.tabs.onUpdated.addListener(listener);
  });
}

async function getReadyTssTab() {
  const existing = await chrome.tabs.query({ url: TSS_MATCH });
  if (existing.length) return existing[0];
  const tab = await chrome.tabs.create({ url: TSS_HOME, active: false });
  await waitForTabComplete(tab.id);
  return chrome.tabs.get(tab.id);
}

async function tssFetch(url) {
  const tab = await getReadyTssTab();
  if (!tab.url || !tab.url.startsWith("https://tss.ucsd.edu/")) {
    return { status: 401, body: "" };
  }
  const [injection] = await chrome.scripting.executeScript({
    target: { tabId: tab.id },
    world: "MAIN",
    args: [String(url), FETCH_TIMEOUT_MS],
    func: async (target, timeoutMs) => {
      const controller = new AbortController();
      const timer = setTimeout(() => controller.abort(), timeoutMs || 30000);
      try {
        const res = await fetch(target, {
          headers: { Accept: "application/json", "sap-passport": "better-tss" },
          credentials: "include",
          signal: controller.signal,
        });
        return { status: res.status, body: await res.text() };
      } catch (e) {
        return { status: 0, body: String((e && e.message) || e) };
      } finally {
        clearTimeout(timer);
      }
    },
  });
  return injection?.result ?? { status: 0, body: "No result from injected fetch." };
}

async function silentReauth() {
  const existing = await chrome.tabs.query({ url: TSS_MATCH });
  if (!existing.length) {
    const tab = await getReadyTssTab();
    return { ok: !!tab.url && tab.url.startsWith("https://tss.ucsd.edu/") };
  }
  const tab = existing[0];
  await chrome.tabs.reload(tab.id);
  try {
    await waitForTabComplete(tab.id);
  } catch {
    return { ok: false };
  }
  const refreshed = await chrome.tabs.get(tab.id);
  return { ok: !!refreshed.url && refreshed.url.startsWith("https://tss.ucsd.edu/") };
}

async function openTss() {
  const existing = await chrome.tabs.query({ url: TSS_MATCH });
  if (existing.length) {
    await chrome.tabs.update(existing[0].id, { active: true });
    await chrome.windows.update(existing[0].windowId, { focused: true });
    return;
  }
  await chrome.tabs.create({ url: TSS_HOME, active: true });
}

chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (msg?.type === "tssFetch") {
    tssFetch(msg.url)
      .then(sendResponse)
      .catch((e) => sendResponse({ status: 0, body: String((e && e.message) || e) }));
    return true;
  }
  if (msg?.type === "silentReauth") {
    silentReauth()
      .then(sendResponse)
      .catch(() => sendResponse({ ok: false }));
    return true;
  }
  if (msg?.type === "openTss") {
    openTss()
      .then(() => sendResponse({ ok: true }))
      .catch((e) => sendResponse({ ok: false, error: String((e && e.message) || e) }));
    return true;
  }
});
