# Updating `basic.js` with MCP

This guide is for a future coding agent maintaining `basic.js` when ChatGPT UI changes break selectors or behavior.

## Goal

Keep these APIs working:

- `promptSet(msg)`
- `sendMessage(msg, checkInterval, sleep, timeout)`
- `sendMessageRepeatedly(msg, n, sleep, mode)`
- `sendMessageRepeatedlyArray(msgs, sleep, sep, prefix, postfix, from, to, mode)`
- `sendMessageRepeatedlyArrayChooseFile(sleep, sep, prefix, postfix, from, to, mode)`
- `openNewChat()`
- `skipCurrentPrompt()`
- `clickDallEDownloadButtons()`

Required call style to preserve:

```js
sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)
skipCurrentPrompt()
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
  const composerSelectors = [
    '#prompt-textarea[contenteditable="true"]',
    '[data-type="unified-composer"] [contenteditable="true"][role="textbox"]',
    'div#prompt-textarea',
    'textarea#prompt-textarea',
    'textarea[name="prompt-textarea"]'
  ];
  const composerCandidates = composerSelectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter((el, index, arr) => arr.indexOf(el) === index);
  const composer =
    composerCandidates.find((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }) || composerCandidates[0] || null;
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
  const selectors = [
    '#prompt-textarea[contenteditable="true"]',
    '[data-type="unified-composer"] [contenteditable="true"][role="textbox"]',
    'div#prompt-textarea',
    'textarea#prompt-textarea',
    'textarea[name="prompt-textarea"]'
  ];
  const candidates = selectors
    .flatMap((selector) => Array.from(document.querySelectorAll(selector)))
    .filter((node, index, arr) => arr.indexOf(node) === index);
  const el =
    candidates.find((node) => {
      const style = window.getComputedStyle(node);
      const rect = node.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    }) || candidates[0] || null;
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

When `mode === "new_chat_image"` in repeated send helpers, current flow is:

1. send prompt
2. wait until a visible generated image appears for the newest response
3. if ChatGPT instead replies with an image-limit reset message (`...limit resets in ...`), parse the duration, log the wait, wait through the reset window, then retry by opening a new chat and resending the original prompt
4. otherwise, if the image wait times out, run the next retry step
5. retry steps can be normal prompts or the special sentinel `MAGIC_RETRY`
6. `MAGIC_RETRY` means: open a new chat and resend the original prompt
7. the default retry queue is `MAGIC_RETRY`, then the creative-license guidance prompt, then `"Generate!"`
8. fetch the generated image asset URL(s) directly from the visible image tile(s) and trigger downloads
9. trigger new chat shortcut (`fireShortcut("o", "KeyO", { shift: true })`)
10. wait briefly, then continue

If this breaks, inspect the generated-image tile selector, the asset URL extraction, and the shortcut dispatch behavior.

Retry prompts reuse `sendMessage(...)`, so each one waits for the composer/send button instead of requiring immediate sendability at the exact timeout moment.
`MAGIC_RETRY` uses `openNewChat()` plus the original prompt instead of a follow-up message in the same chat.

## Array Range Semantics

For `sendMessageRepeatedlyArray(...)` and `sendMessageRepeatedlyArrayChooseFile(...)`:

- `from` is inclusive.
- `to` is exclusive.
- `to=0` maps to end-of-array (full range from `from` to the end).
- `sendMessageRepeatedlyArrayChooseFile(...)` skips entries that are only whitespace after splitting by `sep`; `from`/`to` are applied after that filtering.

## Console Skip Command

`skipCurrentPrompt()` is array-run only.
It is intended for an active `sendMessageRepeatedlyArray(...)` / `sendMessageRepeatedlyArrayChooseFile(...)` run and cooperatively advances to the next selected prompt at the next safe checkpoint.

Current behavior:

- if no array run is active, it logs a no-op status
- if the current prompt is still pending (send / retry / image wait / limit wait / download), the current prompt is skipped
- if the run is in an inter-prompt delay, the delay is shortened and the next prompt starts immediately
- in `new_chat_image` mode, if the skipped prompt was already sent, the runner opens a fresh new chat before continuing

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

## Generated Image Downloads

The old per-tile download buttons are no longer present in the current ChatGPT image UI.
`clickDallEDownloadButtons()` now works by:

1. finding visible generated-image tiles (currently `div[id^="image-"]` / `.group\\/imagegen-image`)
2. extracting the current image asset URL from their `img` descendant
3. fetching the `https://chatgpt.com/backend-api/estuary/content?...` asset directly
4. downloading the fetched blob with an anchor

Prefer the asset URL over brittle hover-only controls.
Use the tile/container plus `img[src*="/backend-api/estuary/content"]` as the primary detection path.
The most stable discriminator currently observed is an `img` with alt text beginning with `Generated image:`.
Operational note: in some chats, generated-image tiles are only mounted when scrolled into view, so scroll to the relevant part of the chat before running `clickDallEDownloadButtons()`.
The downloader throttles bursts: after every 10 downloads it waits 1.1 seconds before continuing.

## Image Limit Reset Detection

If image generation is rate-limited, the current UI returns an assistant text response such as:

- `You've hit the team plan limit for image generations requests. You can create more images when the limit resets in 8 hours and 22 minutes.`

Prefer detecting this from assistant turn text (`[data-message-author-role="assistant"]`) rather than brittle styling hooks.
Current implementation looks for assistant text that:

- mentions images / image generations
- contains `limit resets in`
- includes parseable time units like hours / minutes / seconds

When detected, the script logs the message, waits for the parsed duration plus a one-minute buffer, logs progress roughly once per minute, and then resumes.
After that wait, the current behavior is to run a fresh new-chat retry of the original prompt rather than consuming the ordinary fallback retry queue.
For manual debugging, `window.waitForImageGenerationLimitReset(previousAssistantTurnCount=0)` is exported.

## Download Smoke Test Snippet

After editing `basic.js`, run this in-page with `evaluate_script`:

```js
async () => {
  if (typeof window.clickDallEDownloadButtons !== "function") {
    return { ok: false, reason: "clickDallEDownloadButtons is not available on window" };
  }

  const expectedTargets = Array.from(document.querySelectorAll('[id^="image-"], .group\\/imagegen-image'))
    .filter((el) => {
      const style = window.getComputedStyle(el);
      const rect = el.getBoundingClientRect();
      return style.display !== "none" && style.visibility !== "hidden" && rect.width > 0 && rect.height > 0;
    })
    .filter((el) => el.querySelector('img[src*="/backend-api/estuary/content"]'));

  const originalAnchorClick = HTMLAnchorElement.prototype.click;
  let downloadClicks = 0;

  HTMLAnchorElement.prototype.click = function patchedClick() {
    if (this.hasAttribute("download")) {
      downloadClicks += 1;
    }
  };

  try {
    await window.clickDallEDownloadButtons();
  } finally {
    HTMLAnchorElement.prototype.click = originalAnchorClick;
  }

  return {
    ok: true,
    expected: expectedTargets.length,
    downloadClicks
  };
}
```

Expected result:

- `ok === true`
- `downloadClicks === expected`

If it fails, check:

- exported global drift (`window.clickDallEDownloadButtons`)
- generated-image tile selector drift
- asset URL extraction drift

## Edit Policy

When updating `basic.js`:

- Preserve exported globals (`window.sendMessageRepeatedly`, etc.)
- Preserve the required call style support (`window.n`, `window.sleep`, `window.mode`)
- Keep fallbacks for both `contenteditable` and `textarea` composer variants
- Keep errors explicit (`throw new Error(...)`) for easier debugging
