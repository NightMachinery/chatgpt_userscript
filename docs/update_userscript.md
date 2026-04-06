# Updating `basic.js` with MCP

This guide is for a future coding agent maintaining `basic.js` when ChatGPT UI changes break selectors or behavior.

## Goal

Keep these APIs working:

- `promptSet(msg)`
- `sendMessage(msg, checkInterval, sleep, timeout)`
- `sendMessageRepeatedly(msg, n, sleep, mode, pick_output_dir)`
- `sendMessageRepeatedlyArray(msgs, sleep, sep, prefix, postfix, from, to, mode, pick_output_dir)`
- `sendMessageRepeatedlyArrayChooseFile(sleep, sep, prefix, postfix, from, to, mode, pick_output_dir)`
- `openNewChat()`
- `skipCurrentPrompt()`
- `clickDallEDownloadButtons(pick_output_dir)`

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
- `resolveVisibleDialog(...)`
- `openNewChat(...)`

Do not click random composer buttons by class only; many look similar (voice, dictate, submit).
Also do not treat raw console noise as a failure by itself. Current benign-but-common examples include:

- `Permissions-Policy ... browsing-topics`
- `connectors/check 400`
- Radix/ARIA warnings such as `DialogContent requires a DialogTitle`
- router/accessibility noise such as `A router only supports one blocker at a time` or `aria-hidden ... retained focus`

Those lines matter only insofar as they hint a visible dialog/blocker may need to be resolved in-page.

When `mode === "new_chat_image"` in repeated send helpers, current flow is:

1. open a fresh chat before the first prompt, even if the user launched the helper from an existing conversation
2. send prompt
3. wait until a visible generated image appears for the newest response
4. if ChatGPT instead replies with an image-limit reset message (`...limit resets in ...`), parse the duration, log the wait, wait through the reset window, then retry by opening a new chat and resending the original prompt
5. otherwise, if the image wait times out, run the next retry step
6. retry steps can be normal prompts or the special sentinel `MAGIC_RETRY`
7. `MAGIC_RETRY` means: open a new chat and resend the original prompt
8. the default retry queue is `MAGIC_RETRY`, then the creative-license guidance prompt, then `"Generate!"`
9. fetch the generated image asset URL(s) directly from the visible image tile(s) and trigger downloads
10. if download acquisition fails after the image is already visible, keep retrying that same image forever with backoff and a 45-second per-attempt timeout; do not regenerate a fresh image just because download fetches are flaky
11. if the retry queue is exhausted without a visible image, let the image timeout bubble out; only UI/page-level failures should loop indefinitely
12. `openNewChat()` is now a recovery loop, not a one-shot shortcut:
    - resolve visible dialogs with a conservative allowlist
    - click a visible `New chat` control when available
    - fall back to `fireShortcut("o", "KeyO", { shift: true })`
    - only return once a fresh-chat-ready surface is visible
13. if composer/send readiness gets stuck, recover in-page forever (unless `skipCurrentPrompt()` is used) instead of throwing a fatal timeout

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
- if the skip happens during repeated generated-image download retries, the script first saves a diagnostic text file containing the prompt, prompt index, image index, target key, last asset URL, last error, and retry count
- if the UI gets wedged during new-chat/send recovery, use `skipCurrentPrompt()` as the manual escape hatch; the script now prefers infinite recovery loops over failing the batch

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
- visible route-blocker/dialog handling drift
- new-chat readiness heuristics drift

## Generated Image Downloads

The old per-tile download buttons are no longer present in the current ChatGPT image UI.
`clickDallEDownloadButtons()` now works by:

1. finding visible generated-image tiles (currently `div[id^="image-"]` / `.group\\/imagegen-image`)
2. extracting the current image asset URL from their `img` descendant
3. fetching the `https://chatgpt.com/backend-api/estuary/content?...` asset directly
4. either downloading the fetched blob with an anchor, or writing it into a user-picked folder when `pick_output_dir=true`

Prefer the asset URL over brittle hover-only controls.
Use the tile/container plus `img[src*="/backend-api/estuary/content"]` as the primary detection path.
The most stable discriminator currently observed is an `img` with alt text beginning with `Generated image:`.
Operational note: in some chats, generated-image tiles are only mounted when scrolled into view, so scroll to the relevant part of the chat before running `clickDallEDownloadButtons()`.
The downloader throttles bursts: after every 10 downloads it waits 1.1 seconds before continuing.
When `pick_output_dir=true`, the script uses `showDirectoryPicker({ mode: "readwrite", startIn: "downloads", id: "chatgpt-userscript-output" })` once at the start, and the picked folder is the exact final destination. If `pick_output_dir` is false/omitted, native downloads are used.
After a generated image is visible, download acquisition is retried forever on that same image target: each attempt re-resolves the current tile and asset URL, uses `fetch(..., { credentials: "include", cache: "no-store" })`, times out after 45 seconds, and backs off `1s -> 2s -> 4s ...` capped at 60 seconds.
Retryable download failures include missing/remounted tiles, missing asset URLs, `TypeError: Failed to fetch`, non-OK estuary responses, and `response.blob()` failures. Picked-directory write failures are *not* retried; they should still fail fast.
If picked-folder mode breaks, inspect the File System Access API path (`showDirectoryPicker`, `getDirectoryHandle`, `getFileHandle`, `createWritable`) in addition to the image selectors.
Browser console noise from ChatGPT itself is often benign. In particular, `Permissions-Policy ... browsing-topics`, `connectors/check 400`, `sentinel/ping 400`, and the page's own `net::ERR_HTTP2_PING_FAILED` lines should not be treated as userscript failures unless the script's own `[download-retry]` / thrown errors also indicate a problem.

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
