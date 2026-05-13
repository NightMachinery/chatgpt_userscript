# Reload Resume for Array Runs

`basic.js` can recover from a full ChatGPT page reload during an active
`sendMessageRepeatedlyArray(...)` or `sendMessageRepeatedlyArrayChooseFile(...)`
run.

The running JavaScript stack cannot survive `window.location.reload()`. Before
reloading, the userscript stores a resume record in IndexedDB for the
`https://chatgpt.com` origin. When the userscript is injected again, it reads
that record and restarts the array runner from the active selected prompt.

## Console API

- `refreshPageAndResume()` / `reloadAndResume()`: save the active array run,
  reload the page, then auto-resume after injection.
- `getArrayRunResumeState()`: inspect the saved resume record.
- `clearArrayRunResumeState()`: delete the saved resume record and prevent
  auto-resume.
- `MAGIC_REFRESH_RETRY`: retry-queue sentinel that saves state, reloads, and
  resumes by redoing the active image prompt in a fresh chat.

## Resume Behavior

- The active prompt policy is `redo_active`: after reload, `new_chat_image` mode
  opens a fresh chat and resends the active prompt.
- Completed runs clear their resume record.
- `MAGIC_REFRESH_RETRY` is marked consumed before reload. If the post-reload
  attempt also fails, the retry loop continues with the next retry prompt instead
  of refreshing repeatedly.
- The original console Promise is lost during navigation. Progress continues in
  the newly injected script instance and is visible in the console logs.

## Stored State

The resume record stores the selected prompt list after prefix/postfix expansion,
the selected-entry cursor, send mode, sleep duration, retry options, output mode,
and the active prompt metadata.

For `pick_output_dir=true`, the script tries to store the File System Access
directory handle in IndexedDB. If the browser cannot clone the handle or the
permission is gone after reload, the resumed run asks for the output folder again.
