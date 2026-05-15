# Reload Resume for Array Runs

`basic.js` can recover from a full ChatGPT page reload during an active
`sendMessageRepeatedlyArray(...)` or `sendMessageRepeatedlyArrayChooseFile(...)`
run.

The running JavaScript stack cannot survive `window.location.reload()`. Before
reloading, the userscript stores a resume record in IndexedDB for the
`https://chatgpt.com` origin. IndexedDB is shared across ChatGPT tabs, so startup
auto-resume is gated by the tab-local `#auto_resume` URL hash.

## Console API

- `chatResume()`: manually resume the saved array run from the current tab,
  regardless of whether the URL currently has `#auto_resume`.
- `refreshPageAndResume()` / `reloadAndResume()`: save the active array run,
  add `#auto_resume`, reload the page, then auto-resume after injection.
- `refreshNext()`: during an active `new_chat_image` array run, queue a refresh
  before the next fresh-chat action. The runner saves state, adds `#auto_resume`,
  reloads, and then resumes from that fresh-chat step.
- `getArrayRunResumeState()`: inspect the saved resume record.
- `clearArrayRunResumeState()`: delete the saved resume record and prevent
  auto-resume.
- `clearState()`: print the saved prompt file, output directory, and progress
  summary, then clear all saved userscript state.
- `MAGIC_REFRESH_RETRY`: retry-queue sentinel that saves state, reloads, and
  resumes by redoing the active image prompt in a fresh chat.

## Resume Behavior

- The active prompt policy is `redo_active`: after reload, `new_chat_image` mode
  opens a fresh chat and resends the active prompt.
- Normal ChatGPT tabs do not auto-resume even if saved state exists. Auto-resume
  happens only when the URL hash includes `auto_resume`, or when `chatResume()`
  is called manually.
- Active array runs add `#auto_resume` to the current tab so manual refreshes of
  that tab resume automatically. Normal completion and state-clearing helpers
  remove the hash.
- `refreshNext()` is deferred. It does not reload immediately; it reloads when the
  run is about to call `openNewChat(...)` next. After a successful prompt, that
  checkpoint points at the next selected prompt rather than redoing the completed
  one.
- Completed runs clear their resume record.
- `MAGIC_REFRESH_RETRY` is marked consumed before reload. If the post-reload
  attempt also fails, the retry loop continues with the next retry prompt instead
  of refreshing repeatedly.
- The original console Promise is lost during navigation. Progress continues in
  the newly injected script instance and is visible in the console logs.

## Stored State

The resume record stores the selected prompt list after prefix/postfix expansion,
the prompt source file name when available, the selected-entry cursor, send mode,
sleep duration, retry options, output mode, and the active prompt metadata.

For `pick_output_dir=true`, the script tries to store the File System Access
directory handle in IndexedDB. If the browser cannot clone the handle or the
permission is gone after reload, the resumed run asks for the output folder again.
