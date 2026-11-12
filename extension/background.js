/* Service worker: commands, context menu, clipboard (via offscreen doc), image fetch fallback. */
importScripts('lib/image.js');

const MATCHES = [
  'https://claude.ai/*',
  'https://*.claude.ai/*',
  'https://*.claudeusercontent.com/*',
  'https://*.claude.site/*'
];
const CONTENT_FILES = chrome.runtime.getManifest().content_scripts[0].js;

chrome.runtime.onInstalled.addListener(() => {
  chrome.contextMenus.removeAll(() => {
    chrome.contextMenus.create({
      id: 'c2f-copy',
      title: 'Copy this frame to Figma',
      contexts: ['all'],
      documentUrlPatterns: MATCHES
    });
    chrome.contextMenus.create({
      id: 'c2f-pick',
      title: 'Pick a frame to copy…',
      contexts: ['all'],
      documentUrlPatterns: MATCHES
    });
  });
});

chrome.contextMenus.onClicked.addListener(async (info, tab) => {
  if (!tab || tab.id == null) return;
  await ensureInjected(tab.id).catch(() => {});
  if (info.menuItemId === 'c2f-copy') {
    chrome.tabs
      .sendMessage(tab.id, { type: 'c2f-context-copy' }, { frameId: info.frameId || 0 })
      .catch(() => {});
  } else if (info.menuItemId === 'c2f-pick') {
    startPicker(tab.id);
  }
});

chrome.commands.onCommand.addListener(async (command, tab) => {
  if (command !== 'start-picker') return;
  const t = tab || (await chrome.tabs.query({ active: true, currentWindow: true }))[0];
  if (!t || t.id == null) return;
  await ensureInjected(t.id).catch(() => {});
  startPicker(t.id);
});

function startPicker(tabId) {
  return chrome.tabs.sendMessage(tabId, { type: 'c2f-start-picker' }).catch(() => {});
}

/** Inject content scripts into frames that loaded before the extension was installed. */
async function ensureInjected(tabId) {
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => !!(window.C2F && window.C2F.ready)
    });
  } catch (e) {
    return; // no access to this tab (not a Claude page)
  }
  const missing = results.filter((r) => !r.result).map((r) => r.frameId);
  if (!missing.length) return;
  await chrome.scripting
    .executeScript({ target: { tabId, frameIds: missing }, files: CONTENT_FILES })
    .catch(() => {});
}

chrome.runtime.onMessage.addListener((msg, sender, sendResponse) => {
  if (!msg || msg.target === 'c2f-offscreen') return;
  switch (msg.type) {
    case 'c2f-copy-text':
      writeClipboard(msg.text).then(
        (ok) => sendResponse({ ok }),
        (e) => sendResponse({ ok: false, error: String((e && e.message) || e) })
      );
      return true;
    case 'c2f-fetch-image':
      fetchImage(msg.url).then(sendResponse, () => sendResponse(null));
      return true;
    case 'c2f-picker-stop-all':
      if (sender.tab) {
        chrome.tabs
          .sendMessage(sender.tab.id, { type: 'c2f-picker-stop', except: msg.except || null })
          .catch(() => {});
      }
      return;
    case 'c2f-ensure':
      ensureInjected(msg.tabId).then(
        () => sendResponse({ ok: true }),
        (e) => sendResponse({ ok: false, error: String(e) })
      );
      return true;
    case 'c2f-start':
      ensureInjected(msg.tabId)
        .then(() => startPicker(msg.tabId))
        .then(
          () => sendResponse({ ok: true }),
          (e) => sendResponse({ ok: false, error: String(e) })
        );
      return true;
  }
});

async function fetchImage(url) {
  if (!/^(https?|data):/i.test(url)) return null;
  const res = await fetch(url, { credentials: 'omit' });
  if (!res.ok) return null;
  return self.C2FImage.processBlob(await res.blob());
}

/* ---------- clipboard via offscreen document ---------- */
let creatingOffscreen = null;

async function ensureOffscreen() {
  const url = chrome.runtime.getURL('offscreen.html');
  const contexts = await chrome.runtime.getContexts({
    contextTypes: ['OFFSCREEN_DOCUMENT'],
    documentUrls: [url]
  });
  if (contexts.length) return;
  if (!creatingOffscreen) {
    creatingOffscreen = chrome.offscreen
      .createDocument({
        url: 'offscreen.html',
        reasons: ['CLIPBOARD'],
        justification: 'Write the copied Claude Design frame to the clipboard'
      })
      .finally(() => {
        creatingOffscreen = null;
      });
  }
  await creatingOffscreen;
}

async function writeClipboard(text) {
  await ensureOffscreen();
  const res = await chrome.runtime.sendMessage({ target: 'c2f-offscreen', type: 'copy', text });
  return !!(res && res.ok);
}
