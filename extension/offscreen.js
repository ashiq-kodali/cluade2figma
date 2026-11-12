/* Offscreen document: the only reliable place in MV3 to write to the clipboard
   without depending on the (often sandboxed) page frame. */
chrome.runtime.onMessage.addListener((msg, _sender, sendResponse) => {
  if (!msg || msg.target !== 'c2f-offscreen' || msg.type !== 'copy') return;
  const ta = document.getElementById('buf');
  ta.value = msg.text;
  ta.select();
  let ok = false;
  try {
    ok = document.execCommand('copy');
  } catch (e) {
    ok = false;
  }
  ta.value = '';
  sendResponse({ ok });
});
