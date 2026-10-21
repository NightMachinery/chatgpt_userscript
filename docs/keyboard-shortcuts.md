# Keyboard shortcuts

Install `chat_shortcuts.user.js` in Tampermonkey or Violentmonkey, then reload
your chat tabs. This separate script works without `basic.js` or the paste
script. Version 1.0.0 provides these Mac shortcuts, including inside the composer:

- **Cmd+K:** start a new chat.
- **Cmd+Shift+O:** open chat search (the original ChatGPT Cmd+K action).
- **Cmd+S:** also open chat search, replacing the browser's Save Page action
  while a supported chat page has focus.

Ctrl shortcuts, additional Alt/Ctrl modifiers, and Cmd+Shift+S are unchanged.
Browser chrome, such as the address bar, is outside the script's control.
Holding a shortcut down performs the action once per press.

## Sites and action detection

The script runs on ChatGPT (`chatgpt.com` and `chat.openai.com`), Claude
(`claude.ai`), Gemini (`gemini.google.com`), Perplexity (`perplexity.ai` and
`www.perplexity.ai`), and Kimi (`www.kimi.com`). It does not run in frames.

It clicks visible, enabled New chat/New thread and Search chats controls.
On Gemini it also recognizes specific new-chat, search, and sidebar controls
by their `data-test-id` attributes. If the sidebar is collapsed, it tries to
open it and waits up to 1.2 seconds for the requested control. Google's
[chat-history instructions](https://support.google.com/gemini/answer/13666746?hl=en)
describe this Menu, then Search flow.

On ChatGPT, if no control is found, the script sends the original native
shortcut instead. On other sites, new-chat navigation falls back to the site's
start page (`/new` on Claude, `/app` on Gemini, `/` on Perplexity and Kimi).
Search requires an available chat-history search control. A missing control
produces an on-page notice and a console warning; it never substitutes web
search or starts a new chat for a failed search.

Text matching recognizes English action labels and several Chinese labels.
Other interface languages depend on the Gemini selectors or native/URL
fallbacks. Site redesigns and account-specific feature availability can require
updating the selectors or label patterns in `chat_shortcuts.user.js`.

## Compatibility with automation

The swap intercepts physical keyboard events only. Synthetic keyboard events
pass through unchanged, so `basic.js` can still send Cmd+Shift+O from
`openNewChat()` to start new chats. The shortcut script's own ChatGPT native
fallback also bypasses the swap, avoiding recursive remapping.

The long-paste script remains independent and does not handle these shortcuts.

## Validation

Version 1.0.0 passed a JavaScript syntax check and 116 assertions in isolated
headless Chrome fixtures using real keyboard events across all seven matched
hostnames. Checks covered the three shortcuts, composer focus, key repeat,
unrelated modifiers, Gemini controls and delayed sidebar opening, hidden and
disabled controls, URL/native fallbacks, missing-search feedback, frame
exclusion, translated labels, and synthetic-event compatibility.

These checks verify the script's behavior against fixture controls. Signed-in
production controls on the five services have not been verified live.
