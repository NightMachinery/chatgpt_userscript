# Beware: Timer Bugs in Browser Automation

This userscript runs inside ChatGPT's page, so browser scheduling rules apply. In
backgrounded, hidden, unfocused, battery-saver, or otherwise throttled tabs,
`setTimeout(..., 250)` is not guaranteed to run 250ms later. A callback may run
seconds or minutes late, and a frozen/discarded page may not run JavaScript at all
until it resumes.

## Do not decrement timers by intended sleep slices

Avoid this pattern:

```js
let remainingMs = totalMs;
while (remainingMs > 0) {
  await sleepTimer(Math.min(250, remainingMs));
  remainingMs -= 250;
}
```

That counts how much time we *asked* the browser to sleep, not how much time
actually passed. If Chrome throttles a 250ms timeout to 1 second, a 45-second
wait can stretch to several minutes. If throttling is more aggressive, automation
can appear stuck.

## Use wall-clock deadlines for automation waits

For any wait that should advance by real elapsed time, use the shared sleep
helper instead of custom loops:

```js
await sleepForMs(durationMs, {
  arrayRunController,
  phase: ARRAY_RUN_PHASES.WAITING_GENERATED_IMAGE
});
```

The helper:

- uses a monotonic deadline (`performance.now()` when available);
- checks elapsed time after every wake-up;
- preserves skip/cancel checkpoints for active array runs;
- uses a single timeout when no checkpoint behavior is needed.

This means background timer throttling can delay the next JavaScript wake-up, but
it should not multiply the requested wait by the number of polling slices.

## Polling is only for checkpoints, not for measuring time

Short polling/checkpoint sleeps are acceptable when we need to:

- notice `skipCurrentPrompt()` promptly;
- keep array-run phase state current;
- run recovery-loop checks.

They are not acceptable as the source of truth for elapsed time. Always compare
against a deadline or measured elapsed time after waking.

## Know the difference: wall-clock vs visible-time waits

Most automation waits should use wall-clock elapsed time, including:

- image settle waits;
- retry backoff waits;
- UI recovery action-settle waits;
- inter-prompt sleeps.

Only use visible-time accounting when that is the explicit product behavior. For
example, download filename interception intentionally counts visible elapsed time
because hidden tabs may not surface the same download UI behavior.

## Review checklist for future timer changes

Before adding or changing waits:

1. Prefer `sleepForMs(...)`; do not add new ad hoc `setTimeout` sleep loops.
2. If writing a loop, store an absolute deadline before the loop.
3. After every awaited timeout, recompute remaining time from the current clock.
4. Do not subtract the requested timeout duration from a counter.
5. Decide explicitly whether the wait is wall-clock time or visible-tab time.
6. Preserve skip/cancel checkpoints for active array-run waits.
7. Test at least one long wait by switching away from the tab/window and returning
   after the deadline has passed.

