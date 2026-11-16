// CheckYo'Self: Instagram test kit (a developer tool; NOT part of the extension).
//
// Use it to check what Instagram's page really looks like, for example after
// Instagram changes its design, before editing content/instagram-adapter.ts.
//
// How to use:
//   1. Open https://www.instagram.com in Chrome, press F12, open the Console tab.
//   2. Paste this whole file and press Enter. A small black toolbar appears top-left.
//   3. Inspect  = take one snapshot of the open Instagram dialog(s) now.
//      Record   = start recording every change on the page (until Copy or the next Record).
//      Copy report = copy everything collected so far, to paste into an issue or chat.
//
// It only READS the page. It never clicks anything on Instagram. Snapshots may
// include your caption text and profile name; use a test account.
(() => {
  if (window.__secondLookTestKit) {
    console.log("Test kit is already running.");
    return;
  }
  window.__secondLookTestKit = true;

  const report = [];      // everything collected, in order
  let recording = null;   // { number, start, last, entries, observer }
  let counter = 0;
  const MAX_ENTRIES = 300;

  function size(el) {
    const r = el.getBoundingClientRect();
    return Math.round(r.width) + "x" + Math.round(r.height);
  }

  /** A short description of every open dialog, plus page-level messages. */
  function describePage() {
    const dialogs = [...document.querySelectorAll('[role="dialog"]')].map((d) => ({
      aria: d.getAttribute("aria-label"),
      size: size(d),
      headings: [...d.querySelectorAll('h1,h2,[role="heading"]')].map((h) => h.textContent.trim()).slice(0, 5),
      editors: [...d.querySelectorAll('[contenteditable="true"]')].map((e) => ({
        role: e.getAttribute("role"),
        aria: e.getAttribute("aria-label"),
        lexical: e.hasAttribute("data-lexical-editor"),
      })),
      text: (d.innerText || "").replace(/\s+/g, " ").trim().slice(0, 400),
      buttons: [...d.querySelectorAll('button,[role="button"]')]
        .map((b) => ({ tag: b.tagName, text: b.textContent.trim().slice(0, 30), aria: b.getAttribute("aria-label"), size: size(b) }))
        .filter((b) => b.text || b.aria)
        .slice(0, 30),
      imgs: [...d.querySelectorAll("img")]
        .map((m) => ({ src: m.src.slice(0, 40), alt: (m.alt || "").slice(0, 60), size: size(m) })),
      svgLabels: [...d.querySelectorAll("svg[aria-label]")].map((s) => s.getAttribute("aria-label")).slice(0, 20),
      canvases: [...d.querySelectorAll("canvas")].map((c) => ({ w: c.width, h: c.height, size: size(c) })),
      videos: d.querySelectorAll("video").length,
      postLinks: [...d.querySelectorAll("a[href]")].map((a) => a.getAttribute("href")).filter((h) => /\/(p|reel)\//.test(h)),
      // Carousel hints: dots / arrows near the photo.
      carouselHints: [...d.querySelectorAll('[aria-label*="Go back" i],[aria-label*="Next" i],[aria-label*="slide" i]')]
        .map((e) => e.getAttribute("aria-label"))
        .slice(0, 10),
    }));
    const messages = [...document.querySelectorAll('[role="alert"],[role="status"],[aria-live]')]
      .map((a) => (a.innerText || "").trim())
      .filter(Boolean)
      .slice(0, 10);
    return { path: location.pathname, lang: document.documentElement.lang, dialogs, messages };
  }

  function stopRecording() {
    if (!recording) return;
    recording.observer.disconnect();
    report.push({ kind: "recording", number: recording.number, entries: recording.entries });
    status("Recording #" + recording.number + " stopped (" + recording.entries.length + " changes).");
    recording = null;
  }

  function startRecording() {
    stopRecording();
    const number = ++counter;
    const start = Date.now();
    recording = { number, start, last: "", entries: [], observer: null };
    const snap = () => {
      if (!recording || recording.entries.length >= MAX_ENTRIES) return;
      const page = describePage();
      // Compare without sizes, so moving/animated elements don't flood the log.
      const key = JSON.stringify(page.dialogs.map((d) => [d.aria, d.text, d.headings, d.imgs.map((i) => i.alt), d.svgLabels, d.postLinks])) + JSON.stringify(page.messages) + page.path;
      if (key === recording.last) return;
      recording.last = key;
      recording.entries.push({ t: ((Date.now() - start) / 1000).toFixed(1) + "s", ...page });
    };
    recording.observer = new MutationObserver(snap);
    recording.observer.observe(document.body, { childList: true, subtree: true, characterData: true, attributes: true });
    snap();
    status("Recording #" + number + "... (click Copy report when done)");
  }

  function inspect() {
    const number = ++counter;
    report.push({ kind: "inspect", number, ...describePage() });
    status("Inspect #" + number + " saved.");
  }

  async function copyReport() {
    stopRecording();
    const text = JSON.stringify(report, null, 1);
    try {
      await navigator.clipboard.writeText(text);
      status("Copied " + report.length + " item(s). Paste into Claude.");
    } catch {
      console.log(text);
      status("Couldn't copy. The report was printed in the Console instead.");
    }
  }

  // --- The toolbar --------------------------------------------------------
  const bar = document.createElement("div");
  bar.style.cssText =
    "position:fixed;top:8px;left:8px;z-index:2147483647;background:#111;color:#fff;padding:6px 8px;" +
    "border-radius:8px;font:13px system-ui;display:flex;gap:6px;align-items:center;box-shadow:0 2px 8px #0008";
  const statusLine = document.createElement("span");
  statusLine.style.cssText = "margin-left:6px;max-width:320px";
  function status(text) {
    statusLine.textContent = text;
  }
  function makeButton(label, onClick) {
    const b = document.createElement("button");
    b.textContent = label;
    b.style.cssText = "font:600 13px system-ui;padding:4px 10px;border-radius:6px;border:0;cursor:pointer";
    b.addEventListener("click", onClick);
    return b;
  }
  bar.append(makeButton("Inspect", inspect), makeButton("Record", startRecording), makeButton("Copy report", copyReport), statusLine);
  // Keep our clicks away from Instagram (so it doesn't think we clicked outside its dialog).
  for (const type of ["click", "mousedown", "mouseup", "pointerdown", "pointerup"]) {
    bar.addEventListener(type, (e) => e.stopPropagation());
  }
  document.body.append(bar);
  status("Ready.");
  return "Test kit ready: see the black toolbar at the top-left.";
})();
