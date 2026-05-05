# Image generation limits

When ChatGPT returns an image generation limit message, `basic.js` detects assistant text that mentions images/image generations, contains `limit resets in`, and includes a parseable duration. The script waits for that duration plus the one-minute buffer, logging progress while it sleeps.

After the wait finishes, recovery depends on whether using a fresh chat would break continuity:

- If the active image prompt is still the original prompt, the script opens a fresh chat before resending it. No retry context would be lost, and a fresh chat avoids stale limit/error state.
- If the active image prompt is a self-contained image retry that does not depend on current-chat context, the script also opens a fresh chat before resending that active prompt.
- If a non-image retry step has created context in the current chat, such as an assistant-written safe prompt rewrite followed by `Generate using the new safe prompt!`, the script stays in the same chat and resends that active image-producing retry prompt. This preserves the rewrite/context that the short retry prompt depends on.

Only retry steps with `image_expected_p !== false` become the active image-producing prompt. Non-image retry steps can create context for the next image-producing retry prompt, but they are not themselves resent after the limit wait.

`MAGIC_RETRY` behavior for ordinary timeouts/refusals is separate: it still opens a fresh chat and resends the original prompt when selected by the retry queue.
