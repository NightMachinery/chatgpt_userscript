# Updating `basic.js` with MCP

This guide is for a future coding agent maintaining `basic.js` when ChatGPT UI changes break selectors or behavior.

## Goal

Keep these APIs working:

- `promptSet(msg)`
- `sendMessage(msg, checkInterval, sleep, timeout)`
- `sendMessageRepeatedly(msg, n, sleep, newChatP)`
- `clickDallEDownloadButtons()`

Required call style to preserve:

```js
sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)
```

## MCP Workflow

1. Open ChatGPT with MCP and use a signed-in session.
2. Navigate to a safe chat (new chat preferred).
3. Inspect current DOM structure (composer, send button, stop button, regenerate/retry buttons).
4. Run a smoke test in-page with deterministic markers.
5. Update selectors/logic in `basic.js`.
6. Re-run smoke tests until stable.

## Tool Sequence

Use these `chrome-devtools` MCP tools in this order:

1. `new_page` or `navigate_page` to `https://chatgpt.com/`
2. `take_snapshot` to understand accessible labels and controls
3. `evaluate_script` for DOM probes and runtime tests
4. `wait_for` (optional) when waiting for a known UI text state
5. `take_snapshot` again after edits/tests to confirm UI state

## Selector Probe Snippet

Run this with `evaluate_script`:

```js
() => {
  const composer = document.querySelector(
    '#prompt-textarea[contenteditable="true"], textarea#prompt-textarea, div#prompt-textarea'
  );
  const sendButton = document.querySelector(
    'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]'
  );
  const stopButton = document.querySelector('button[data-testid="stop-button"]');
  const regenCandidates = Array.from(document.querySelectorAll("button"))
    .filter((b) =>
      /regenerate|retry|try again/i.test(
        `${b.getAttribute("aria-label") || ""} ${(b.textContent || "").trim()}`
      )
    )
    .map((b) => ({
      aria: b.getAttribute("aria-label"),
      text: (b.textContent || "").trim(),
      disabled: b.disabled,
      testid: b.getAttribute("data-testid")
    }));

  return {
    composerFound: Boolean(composer),
    composerTag: composer ? composer.tagName : null,
    composerContentEditable: composer ? composer.getAttribute("contenteditable") : null,
    sendButtonFound: Boolean(sendButton),
    sendButtonDisabled: sendButton ? sendButton.disabled : null,
    stopButtonFound: Boolean(stopButton),
    regenerateButtons: regenCandidates
  };
}
```

## Composer Write Snippet

If text input starts appending instead of replacing, test this behavior:

```js
() => {
  const el = document.querySelector('#prompt-textarea[contenteditable="true"], div#prompt-textarea');
  if (!el) return { ok: false, reason: "composer not found" };

  el.focus();
  let inserted = false;
  try {
    document.execCommand("selectAll", false, null);
    inserted = document.execCommand("insertText", false, "SMOKE TEXT");
  } catch (_) {}

  if (!inserted) {
    el.innerHTML = "<p>SMOKE TEXT</p>";
    el.dispatchEvent(new InputEvent("input", { bubbles: true, inputType: "insertText", data: "SMOKE TEXT" }));
  }

  return { ok: true, inserted, text: el.textContent };
}
```

If this fails, update `setContentEditableText` in `basic.js`.

## Busy/Ready Model

Current logic assumes:

- Busy while `button[data-testid="stop-button"]` exists.
- Ready to send when not busy and send button exists and is enabled.

If upstream changes this, update:

- `isBusyGenerating()`
- `getSendButton()`
- `waitForButtonAvailable(...)`

Do not click random composer buttons by class only; many look similar (voice, dictate, submit).

## Smoke Test Snippet

After editing `basic.js`, run this in-page with `evaluate_script`:

```js
async () => {
  const base = `mcp-smoke-${Date.now()}`;
  await window.sendMessageRepeatedly(base, n = 2, sleep = 2);
  await new Promise((r) => setTimeout(r, 3000));

  const userTurns = Array.from(document.querySelectorAll('[data-message-author-role="user"]'))
    .map((el) => (el.textContent || "").trim());
  const matches = userTurns.filter((t) => t === base);

  return {
    base,
    expected: 2,
    actual: matches.length
  };
}
```

Expected result: `actual === 2`.

If actual is `0` or `1`, check:

- send button selector drift
- composer write method drift
- busy detection drift
- message send blocked by generation state

## DALL·E Download Buttons

If `clickDallEDownloadButtons()` breaks, inspect image tool actions from `take_snapshot` and update this selector:

- `button[aria-label="Download this image"]`
- `button[aria-label*="Download image" i]`
- `button[data-testid*="download" i]` (fallback)

Avoid utility-class selectors like `div.group-hover\\/dalle-image\\:visible button`; they are brittle and often change upstream.
Prefer stable attributes (`data-testid`, `aria-label`) whenever possible.

## Download Smoke Test Snippet

After editing `basic.js`, run this in-page with `evaluate_script`:

```js
() => {
  if (typeof window.clickDallEDownloadButtons !== "function") {
    return { ok: false, reason: "clickDallEDownloadButtons is not available on window" };
  }

  const expectedButtons = Array.from(
    document.querySelectorAll(
      'button[aria-label="Download this image"], button[aria-label*="Download image" i], button[data-testid*="download" i]'
    )
  ).filter((button) => !button.disabled);

  const originalClick = HTMLButtonElement.prototype.click;
  let totalClicks = 0;
  let downloadClicks = 0;

  HTMLButtonElement.prototype.click = function patchedClick() {
    totalClicks += 1;
    const label = `${this.getAttribute("aria-label") || ""} ${(this.textContent || "").trim()}`;
    if (/download this image|download image/i.test(label)) {
      downloadClicks += 1;
    }
  };

  try {
    window.clickDallEDownloadButtons();
  } finally {
    HTMLButtonElement.prototype.click = originalClick;
  }

  return {
    ok: true,
    expected: expectedButtons.length,
    totalClicks,
    downloadClicks
  };
}
```

Expected result:

- `ok === true`
- `downloadClicks === expected`

If it fails, check:

- exported global drift (`window.clickDallEDownloadButtons`)
- download selector drift (`aria-label`/`data-testid`)
- disabled state handling

## Edit Policy

When updating `basic.js`:

- Preserve exported globals (`window.sendMessageRepeatedly`, etc.)
- Preserve the required call style support (`window.n`, `window.sleep`)
- Keep fallbacks for both `contenteditable` and `textarea` composer variants
- Keep errors explicit (`throw new Error(...)`) for easier debugging
