# Keyboard shortcuts

`basic.js` does not remap Cmd+K or Cmd+Shift+O. Its `openNewChat()`
helper clicks a visible New chat control first and falls back to sending
Cmd+Shift+O (`fireShortcut("o", "KeyO", { shift: true })`).

The script only matches `https://chatgpt.com/*`, so it does not provide
shortcuts on Gemini or other chat websites.

`disable_paste_intercept.js` matches several chat sites, including Gemini,
but handles plain-text pasting only. It does not remap keyboard shortcuts.

A Cmd+K swap supplied by a separate extension or userscript would need to
be checked in that tool's configuration. Its presence and site coverage
cannot be inferred from this repository.
