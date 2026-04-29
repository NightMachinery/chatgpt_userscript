# Disable paste interception

Some AI chat sites intercept large plain-text pastes and turn them into file
attachments instead of leaving the text in the message editor.

## MCP validation on ChatGPT

On ChatGPT, a synthetic paste of a 120,052-character random string into the
composer was intercepted by the site:

- the paste event was canceled by upstream page code;
- the composer stayed empty;
- ChatGPT created a file chip named `PASTE_INTERCEPT_TEST..`.

Installing a capture-phase paste handler before the page handler avoided that
conversion:

- the same 120,052-character string appeared in the visible composer;
- the text began with `PASTE_INTERCEPT_TEST_START_` and ended with
  `_PASTE_INTERCEPT_TEST_END`;
- no file chip was created.

## Behavior

`disable_paste_intercept.js` listens for paste events on common AI chat sites.
When the clipboard includes `text/plain` and the target is an editable text
field, it stops the site handler and inserts the plain text directly at the
current selection. Clipboard content without plain text, such as file-only or
image-only paste data, is left for the site to handle normally.
