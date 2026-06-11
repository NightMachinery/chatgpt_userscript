# Reload Resume for Array Runs

`basic.js` can recover from a full ChatGPT page reload during an active
`sendMessageRepeatedlyArray(...)` or `sendMessageRepeatedlyArrayChooseFile(...)`
run.

The running JavaScript stack cannot survive `window.location.reload()`. Before
reloading, the userscript stores a resume record in IndexedDB for the
`https://chatgpt.com` origin. IndexedDB is shared across ChatGPT tabs, so each
resumable run has a stable job ID and startup auto-resume is gated by the
tab-local `#auto_resume=<job_id>` URL hash.

## Console API

- `chatResume(job_id?)`: manually resume a saved array run from the current tab,
  regardless of whether the URL currently has `#auto_resume`.
- `refreshPageAndResume()` / `reloadAndResume()`: save the active array run,
  add `#auto_resume=<job_id>`, reload the page, then auto-resume after injection.
- `refreshNext()`: during an active `new_chat_image` array run, queue a refresh
  before the next fresh-chat action. The runner saves state, adds
  `#auto_resume=<job_id>`, reloads, and then resumes from that fresh-chat step.
- `getArrayRunResumeState(job_id?)`: inspect the saved resume record.
- `clearArrayRunResumeState(job_id?)`: delete the saved resume record and prevent
  auto-resume.
- `clearState()`: print the saved prompt file, output directory, and progress
  summary, then clear all saved userscript state.
- `MAGIC_REFRESH_RETRY`: retry-queue sentinel that saves state, reloads, and
  resumes by redoing the active image prompt in a fresh chat.
- UI recovery refresh retry: during an active resumable array run, stuck
  composer/send/new-chat recovery reloads after 10 failed recovery cycles and
  resumes the active prompt.

## Resume Behavior

- The active prompt policy is `redo_active`: after reload, `new_chat_image` mode
  opens a fresh chat and resends the active prompt.
- Normal ChatGPT tabs do not auto-resume even if saved state exists. Auto-resume
  happens only when the URL hash includes `auto_resume`, or when
  `chatResume(job_id?)` is called manually.
- Active array runs add `#auto_resume=<job_id>` to the current tab so manual
  refreshes of that tab resume the matching job automatically. Bare
  `#auto_resume` and no-argument helpers use the current URL job ID when present,
  otherwise the most recently updated pending job.
- Resume refresh URLs remove ChatGPT's `prompt` query parameter before reload
  while preserving other query parameters and the `#auto_resume` hash. This
  keeps very long prompt-prefill URLs from being requested again during recovery.
- `refreshNext()` is deferred. It does not reload immediately; it reloads when the
  run is about to call `openNewChat(...)` next. After a successful prompt, that
  checkpoint points at the next selected prompt rather than redoing the completed
  one.
- Completed runs clear their resume record.
- `MAGIC_REFRESH_RETRY` is marked consumed before reload. If the post-reload
  attempt also fails, the retry loop continues with the next retry prompt instead
  of refreshing repeatedly.
- UI recovery refresh retry is cycle-based, not wall-clock based. After 10
  failed UI recovery cycles, active resumable array runs save state with reason
  `ui_recovery_refresh_retry`, add `#auto_resume=<job_id>`, reload, and redo the
  active prompt. Non-resumable/manual sends do not auto-refresh because the
  JavaScript stack would be lost.
- The original console Promise is lost during navigation. Progress continues in
  the newly injected script instance and is visible in the console logs.

## Stored State

Each resume record is stored under its job ID and stores the selected prompt list
after prefix/postfix expansion, the prompt source file name when available, the
selected-entry cursor, send mode, sleep duration, retry options, output mode, and
the active prompt metadata. Completion and targeted clear operations delete only
that job's record; `clearState()` clears the whole resume store.

For `pick_output_dir=true`, the script tries to store the File System Access
directory handle in IndexedDB. If the browser cannot clone the handle or the
permission is gone after reload, the resumed run asks for the output folder again.
