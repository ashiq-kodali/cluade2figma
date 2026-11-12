const HOSTS = [
  /^https:\/\/([a-z0-9-]+\.)*claude\.ai\//i,
  /^https:\/\/([a-z0-9-]+\.)*claudeusercontent\.com\//i,
  /^https:\/\/([a-z0-9-]+\.)*claude\.site\//i
];
const IS_MAC = /Mac/.test(navigator.platform);

const $ = (s) => document.querySelector(s);
const statusEl = $('#status');
let tabId = null;

function setStatus(text, kind = '') {
  statusEl.textContent = text;
  statusEl.className = kind;
}

async function init() {
  if (!IS_MAC) {
    document.querySelectorAll('.paste').forEach((e) => (e.textContent = 'Ctrl+V'));
  } else {
    document.querySelectorAll('.k-alt').forEach((e) => (e.textContent = '⌥'));
  }

  const [tab] = await chrome.tabs.query({ active: true, currentWindow: true });
  if (!tab || !HOSTS.some((r) => r.test(tab.url || ''))) {
    $('#off').hidden = false;
    return;
  }
  tabId = tab.id;
  $('#main').hidden = false;

  $('#pick').addEventListener('click', async () => {
    await chrome.runtime.sendMessage({ type: 'c2f-start', tabId });
    window.close();
  });
  $('#refresh').addEventListener('click', loadFrames);

  await chrome.runtime.sendMessage({ type: 'c2f-ensure', tabId });
  loadFrames();
}

async function loadFrames() {
  const list = $('#frames');
  list.innerHTML = '<li class="empty">Looking for frames…</li>';
  let results = [];
  try {
    results = await chrome.scripting.executeScript({
      target: { tabId, allFrames: true },
      func: () => (window.C2F && window.C2F.findFrames ? window.C2F.findFrames() : [])
    });
  } catch (e) {
    list.innerHTML = '<li class="empty">Can’t read this page. Reload it and try again.</li>';
    return;
  }
  const rows = [];
  for (const r of results) for (const f of r.result || []) rows.push({ ...f, frameId: r.frameId });
  // Prefer frames from embedded design iframes: list them first.
  rows.sort((a, b) => (a.frameId === 0) - (b.frameId === 0));

  list.innerHTML = '';
  if (!rows.length) {
    list.innerHTML = '<li class="empty">No frames found — use “Pick a frame”.</li>';
    return;
  }
  for (const f of rows) {
    const li = document.createElement('li');
    const name = document.createElement('span');
    name.className = 'fname';
    name.textContent = f.name;
    name.title = f.name;
    const meta = document.createElement('span');
    meta.className = 'fmeta';
    meta.textContent = `${f.w} × ${f.h}`;
    li.append(name);
    if (f.frameId !== 0) {
      const tag = document.createElement('span');
      tag.className = 'tag';
      tag.textContent = 'design';
      tag.title = 'Inside the design canvas iframe';
      li.append(tag);
    }
    const btn = document.createElement('button');
    btn.className = 'copy';
    btn.textContent = 'Copy';
    btn.addEventListener('click', () => copyFrame(f, btn));
    li.append(meta, btn);
    li.addEventListener('mouseenter', () =>
      chrome.tabs.sendMessage(tabId, { type: 'c2f-highlight', id: f.id }, { frameId: f.frameId }).catch(() => {})
    );
    li.addEventListener('mouseleave', () =>
      chrome.tabs.sendMessage(tabId, { type: 'c2f-unhighlight' }, { frameId: f.frameId }).catch(() => {})
    );
    list.append(li);
  }
}

async function copyFrame(f, btn) {
  btn.disabled = true;
  btn.textContent = '…';
  setStatus('Copying “' + f.name + '”…');
  let res;
  try {
    res = await chrome.tabs.sendMessage(tabId, { type: 'c2f-copy-frame', id: f.id }, { frameId: f.frameId });
  } catch (e) {
    res = { ok: false, error: e.message };
  }
  btn.disabled = false;
  btn.textContent = 'Copy';
  if (res && res.ok) {
    const paste = IS_MAC ? '⌘V' : 'Ctrl+V';
    setStatus(`Copied ✓ Press ${paste} in Figma.`, 'ok');
  } else {
    setStatus('Copy failed: ' + ((res && res.error) || 'unknown error'), 'err');
  }
}

init();
