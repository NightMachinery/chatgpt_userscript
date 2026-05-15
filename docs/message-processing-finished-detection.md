# Message Processing Finished Detection

`basic.js` uses two related readiness checks:

- `window.isComposerReady()` returns true when ChatGPT is not actively generating, no visible dialog is blocking the page, and the composer input is visible. This means the page is ready for typing or pasting another prompt.
- `window.isSendButtonReady()` returns true when ChatGPT is not actively generating, no visible dialog is blocking the page, and the send button exists and is enabled. This means the current composer contents can be submitted now.

The practical difference is that composer readiness is about the input surface, while send-button readiness is about submit eligibility. For example, after a turn is finished on a blank composer, `isComposerReady()` can be true while `isSendButtonReady()` is false because there is nothing to send.

Image mode uses composer readiness as the current-message-finished signal. It still starts detecting generated image targets as soon as they appear and keeps collecting newly visible targets while the assistant turn continues. After the composer becomes ready, it waits `IMAGE_POST_DETECTION_SETTLE_MS` (currently 5 seconds) and rescans before downloading. This keeps early image detection active for cases where a generated image appears briefly and is later redacted, while avoiding the older long fixed settle delay.
