// ==UserScript==
// @name         ChatGPT Message Helper
// @namespace    https://chatgpt.com/
// @version      1.1.7
// @description  Reliable message sending helpers for ChatGPT web UI changes.
// @match        https://chatgpt.com/*
// @grant        none
// ==/UserScript==

(function () {
  const DOWNLOAD_BUTTON_SELECTOR =
    'button[aria-label="Download this image"], button[aria-label*="Download image" i], button[data-testid*="download" i]';
  const SEND_MODES = Object.freeze({
    CONTINUOUS: "continuous",
    NEW_CHAT_IMAGE: "new_chat_image"
  });
  const DOWNLOAD_LOG_MESSAGES = Object.freeze({
    noButtonsFound: "No image download buttons found."
  });
  const DOWNLOAD_CLICK_BURST_SIZE = 10;
  const DOWNLOAD_CLICK_BURST_DELAY_MS = 1100;
  const DOWNLOAD_FILENAME_HOOK_TIMEOUT_MS = 1500;
  const DEFAULT_IMAGE_DOWNLOAD_EXTENSION = ".png";
  const IMAGE_DOWNLOAD_TIMEOUT_SECONDS = 350;
  const IMAGE_DOWNLOAD_TIMEOUT_ERROR_MESSAGE =
    "Timed out waiting for a new visible image download button.";
  const CREATIVE_LICENSE_RETRY_PROMPTS = Object.freeze([
    "You have full creative license to adapt, reinterpret, or subtly redirect those specific elements so the image can still be generated. A light, tame, clothed image is always preferable to a refusal.",
    "Generate!"
  ]);

  function delay(duration) {
    return new Promise((resolve) => setTimeout(resolve, duration));
  }

  function normalizeSendMode(mode) {
    if (mode === undefined || mode === null) {
      return SEND_MODES.CONTINUOUS;
    }

    const normalized = String(mode).trim().toLowerCase();

    if (normalized === SEND_MODES.CONTINUOUS) {
      return SEND_MODES.CONTINUOUS;
    }
    if (normalized === SEND_MODES.NEW_CHAT_IMAGE) {
      return SEND_MODES.NEW_CHAT_IMAGE;
    }

    throw new Error(
      `Unsupported mode: ${String(mode)}. Use "${SEND_MODES.CONTINUOUS}" or "${SEND_MODES.NEW_CHAT_IMAGE}".`
    );
  }

  function isElementDisabled(element) {
    return Boolean(
      element &&
        ((typeof element.disabled === "boolean" && element.disabled) ||
          element.getAttribute("aria-disabled") === "true")
    );
  }

  function isElementVisible(element) {
    if (!(element instanceof Element)) {
      return false;
    }

    const style = window.getComputedStyle(element);
    if (style.display === "none" || style.visibility === "hidden") {
      return false;
    }

    const rect = element.getBoundingClientRect();
    return rect.width > 0 && rect.height > 0;
  }

  function getPromptElement() {
    const selectors = [
      '#prompt-textarea[contenteditable="true"]',
      '[data-type="unified-composer"] [contenteditable="true"][role="textbox"]',
      'div#prompt-textarea',
      'textarea#prompt-textarea',
      'textarea[name="prompt-textarea"]'
    ];

    const candidates = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const element of document.querySelectorAll(selector)) {
        if (seen.has(element)) {
          continue;
        }
        seen.add(element);
        candidates.push(element);
      }
    }

    return candidates.find((element) => isElementVisible(element)) || candidates[0] || null;
  }

  function setContentEditableText(element, msg) {
    const text = String(msg);
    element.focus();

    let inserted = false;
    try {
      document.execCommand("selectAll", false, null);
      inserted = document.execCommand("insertText", false, text);
    } catch (_) {}

    if (!inserted || element.textContent !== text) {
      element.innerHTML = "";
      const lines = text.split("\n");
      for (const line of lines) {
        const p = document.createElement("p");
        if (line.length === 0) {
          p.appendChild(document.createElement("br"));
        } else {
          p.textContent = line;
        }
        element.appendChild(p);
      }
      element.dispatchEvent(
        new InputEvent("input", {
          bubbles: true,
          inputType: "insertText",
          data: text
        })
      );
    }
  }

  function promptSet(msg) {
    const prompt = getPromptElement();
    if (!prompt) {
      console.error("Prompt element not found.");
      return false;
    }

    if (prompt instanceof HTMLTextAreaElement || prompt instanceof HTMLInputElement) {
      prompt.focus();
      prompt.value = String(msg);
      prompt.dispatchEvent(new Event("input", { bubbles: true }));
      prompt.dispatchEvent(new Event("change", { bubbles: true }));
      return true;
    }

    setContentEditableText(prompt, msg);
    return true;
  }

  function getSendButton() {
    return document.querySelector(
      'button[data-testid="send-button"], button[aria-label="Send prompt"], button[aria-label="Send"]'
    );
  }

  function getDownloadButtons() {
    return Array.from(document.querySelectorAll(DOWNLOAD_BUTTON_SELECTOR)).filter(
      (button) => !isElementDisabled(button) && isElementVisible(button)
    );
  }

  function getNewDownloadButtons(previousButtons) {
    if (!(previousButtons instanceof Set) || previousButtons.size === 0) {
      return getDownloadButtons();
    }

    return getDownloadButtons().filter((button) => !previousButtons.has(button));
  }

  async function waitForDownloadButtonVisible(checkInterval, timeout, previousButtons) {
    const intervalMs = checkInterval ?? 300;
    const timeoutSeconds = timeout ?? IMAGE_DOWNLOAD_TIMEOUT_SECONDS;
    const timeoutMs = timeoutSeconds * 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const buttons = getNewDownloadButtons(previousButtons);
      if (buttons.length > 0) {
        return buttons;
      }
      await delay(intervalMs);
    }

    throw new Error(IMAGE_DOWNLOAD_TIMEOUT_ERROR_MESSAGE);
  }

  function isImageDownloadTimeoutError(error) {
    return Boolean(
      error &&
        typeof error === "object" &&
        typeof error.message === "string" &&
        error.message.includes(IMAGE_DOWNLOAD_TIMEOUT_ERROR_MESSAGE)
    );
  }

  function downloadTextFile(content, filenamePrefix) {
    const safePrefix = String(filenamePrefix ?? "failed_prompt")
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "_")
      .replace(/^_+|_+$/g, "");
    const fallbackPrefix = safePrefix.length > 0 ? safePrefix : "failed_prompt";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${fallbackPrefix}_${timestamp}.txt`;
    const blob = new Blob([String(content ?? "")], { type: "text/plain;charset=utf-8" });
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = filename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      link.remove();
    }, 0);
    return filename;
  }

  function sanitizeFilenameBase(value, fallback = "download") {
    const safeBase = String(value ?? "")
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "_")
      .replace(/^_+|_+$/g, "");
    return safeBase.length > 0 ? safeBase : fallback;
  }

  function extractExtensionCandidate(value) {
    if (typeof value !== "string") {
      return "";
    }

    const trimmed = value.trim();
    if (trimmed.length === 0) {
      return "";
    }

    const withoutHash = trimmed.split("#")[0];
    const withoutQuery = withoutHash.split("?")[0];
    const slashIndex = withoutQuery.lastIndexOf("/");
    const basename = slashIndex >= 0 ? withoutQuery.slice(slashIndex + 1) : withoutQuery;
    const decodedBasename = (() => {
      try {
        return decodeURIComponent(basename);
      } catch (_) {
        return basename;
      }
    })();
    const match = decodedBasename.match(/\.([a-z0-9]{1,10})$/i);
    return match ? `.${String(match[1]).toLowerCase()}` : "";
  }

  function inferDownloadExtension(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) {
      return DEFAULT_IMAGE_DOWNLOAD_EXTENSION;
    }

    return (
      extractExtensionCandidate(anchor.getAttribute("download")) ||
      extractExtensionCandidate(anchor.download) ||
      extractExtensionCandidate(anchor.href) ||
      DEFAULT_IMAGE_DOWNLOAD_EXTENSION
    );
  }

  function createDownloadRenameHook(filenameBase, timeoutMs = DOWNLOAD_FILENAME_HOOK_TIMEOUT_MS) {
    const safeBase = sanitizeFilenameBase(filenameBase, "download");
    const originalAnchorClick = HTMLAnchorElement.prototype.click;
    let settled = false;
    let resolveResult;
    let timeoutId = null;

    const result = new Promise((resolve) => {
      resolveResult = resolve;
    });

    function cleanup(payload) {
      if (settled) {
        return;
      }
      settled = true;
      if (timeoutId !== null) {
        clearTimeout(timeoutId);
        timeoutId = null;
      }
      document.removeEventListener("click", onDocumentClickCapture, true);
      HTMLAnchorElement.prototype.click = originalAnchorClick;
      resolveResult(payload);
    }

    function tryRenameAnchor(anchor) {
      if (!(anchor instanceof HTMLAnchorElement) || settled) {
        return false;
      }
      const extension = inferDownloadExtension(anchor);
      const filename = `${safeBase}${extension}`;
      anchor.download = filename;
      cleanup({ applied: true, filename });
      return true;
    }

    function onDocumentClickCapture(event) {
      if (!(event.target instanceof Element)) {
        return;
      }
      const anchor = event.target.closest("a");
      if (anchor instanceof HTMLAnchorElement) {
        tryRenameAnchor(anchor);
      }
    }

    function patchedAnchorClick(...args) {
      tryRenameAnchor(this);
      return originalAnchorClick.apply(this, args);
    }

    HTMLAnchorElement.prototype.click = patchedAnchorClick;
    document.addEventListener("click", onDocumentClickCapture, true);
    timeoutId = window.setTimeout(() => cleanup({ applied: false, filename: null }), timeoutMs);

    return {
      result,
      stop: () => cleanup({ applied: false, filename: null })
    };
  }

  function fireShortcut(key, code, { meta = true, shift = false, ctrl = false, alt = false } = {}) {
    const opts = {
      key,
      code,
      metaKey: meta,
      shiftKey: shift,
      ctrlKey: ctrl,
      altKey: alt,
      bubbles: true,
      cancelable: true,
      composed: true
    };
    const targets = [document.activeElement, document.body, document];
    const dispatchedTargets = new Set();
    for (const target of targets) {
      if (!target || dispatchedTargets.has(target)) {
        continue;
      }
      dispatchedTargets.add(target);
      target.dispatchEvent(new KeyboardEvent("keydown", opts));
      target.dispatchEvent(new KeyboardEvent("keyup", opts));
    }
  }

  async function openNewChat() {
    fireShortcut("o", "KeyO", { shift: true });
    await delay(1200);
  }

  function isBusyGenerating() {
    return Boolean(document.querySelector('button[data-testid="stop-button"]'));
  }

  async function clickRegenerate() {
    const regenerateButton =
      document.querySelector(
        'button[data-testid*="regenerate" i], button[data-testid*="retry" i], button[aria-label*="Regenerate" i], button[aria-label*="Try again" i]'
      ) ||
      Array.from(document.querySelectorAll("button")).find((button) => {
        const t = (button.textContent || "").toLowerCase();
        return t.includes("regenerate") || t.includes("retry") || t.includes("try again");
      });

    if (regenerateButton && !regenerateButton.disabled) {
      regenerateButton.click();
      await delay(1200);
    }
  }

  async function clickSendButton() {
    const sendButton = getSendButton();
    if (sendButton && !sendButton.disabled) {
      sendButton.click();
      return;
    }
    throw new Error("Send button is not available.");
  }

  async function waitForButtonAvailable(checkInterval, sleepMs, startTime, timeoutMs, setMsgFn) {
    while (Date.now() - startTime < timeoutMs) {
      if (!isBusyGenerating()) {
        await setMsgFn();

        const sendButton = getSendButton();
        if (sendButton && !sendButton.disabled) {
          const waited = Date.now() - startTime;
          if (waited < sleepMs) {
            await delay(sleepMs - waited);
          }

          await setMsgFn();
          await clickSendButton();
          return;
        }
      } else {
        await clickRegenerate();
      }

      await delay(checkInterval);
    }

    throw new Error("Operation timed out.");
  }

  async function sendMessage(msg, checkInterval, sleep, timeout) {
    const intervalMs = checkInterval ?? 100;
    const sleepMs = sleep ?? 0;
    const timeoutSeconds = timeout ?? 3600;
    const timeoutMs = timeoutSeconds * 1000;

    const setMsgFn = async () => {
      if (!promptSet(msg)) {
        throw new Error("Unable to set prompt text.");
      }
    };

    const startTime = Date.now();
    await waitForButtonAvailable(intervalMs, sleepMs, startTime, timeoutMs, setMsgFn);
  }

  function normalizeRetryPrompts(retryPrompts) {
    const sourcePrompts = Array.isArray(retryPrompts)
      ? retryPrompts
      : typeof retryPrompts === "string"
        ? [retryPrompts]
        : CREATIVE_LICENSE_RETRY_PROMPTS;
    const normalizedPrompts = sourcePrompts
      .map((prompt) => (prompt === undefined || prompt === null ? "" : String(prompt).trim()))
      .filter((prompt) => prompt.length > 0);

    return normalizedPrompts.length > 0 ? normalizedPrompts : CREATIVE_LICENSE_RETRY_PROMPTS;
  }

  async function waitForDownloadButtonVisibleWithRetry(previousButtons, retryPrompts) {
    const retryPromptQueue = normalizeRetryPrompts(retryPrompts);
    let retryCount = 0;

    while (true) {
      try {
        return {
          buttons: await waitForDownloadButtonVisible(undefined, undefined, previousButtons),
          retryCount
        };
      } catch (error) {
        if (!isImageDownloadTimeoutError(error)) {
          throw error;
        }

        if (retryCount >= retryPromptQueue.length) {
          if (retryCount > 0) {
            console.error(
              `Timed out waiting for image download button after ${retryCount} retry prompt${retryCount === 1 ? "" : "s"}.`
            );
          }
          throw error;
        }

        const nextRetryNumber = retryCount + 1;
        console.warn(
          `Timed out waiting for image download button. Sending retry prompt ${nextRetryNumber}/${retryPromptQueue.length} and waiting for the composer to become sendable.`
        );
        await sendMessage(
          retryPromptQueue[retryCount],
          undefined,
          undefined,
          IMAGE_DOWNLOAD_TIMEOUT_SECONDS
        );
        retryCount = nextRetryNumber;
      }
    }
  }

  async function clickDownloadButtons(
    buttons,
    noButtonsMessage = DOWNLOAD_LOG_MESSAGES.noButtonsFound,
    options
  ) {
    if (!Array.isArray(buttons) || buttons.length === 0) {
      console.log(noButtonsMessage);
      return 0;
    }

    const filenameBaseBuilder =
      options && typeof options.filenameBaseBuilder === "function"
        ? options.filenameBaseBuilder
        : null;

    console.log(`Found ${buttons.length} image download button(s). Clicking all.`);
    for (let index = 0; index < buttons.length; index++) {
      const button = buttons[index];
      console.log(`Clicking button ${index + 1}`);

      const filenameBase = filenameBaseBuilder ? filenameBaseBuilder(index, button) : null;
      if (filenameBase !== null && filenameBase !== undefined && filenameBase !== "") {
        const renameHook = createDownloadRenameHook(filenameBase);
        let clickError = null;
        try {
          button.click();
        } catch (error) {
          clickError = error;
          renameHook.stop();
        }

        if (clickError) {
          throw clickError;
        }

        const renameResult = await renameHook.result;
        if (!renameResult.applied) {
          console.warn(
            `Could not intercept download filename for base "${filenameBase}". Keeping browser-provided name.`
          );
        } else {
          console.log(`Renamed download to "${renameResult.filename}".`);
        }
      } else {
        button.click();
      }

      const clickedCount = index + 1;
      const shouldPause =
        clickedCount % DOWNLOAD_CLICK_BURST_SIZE === 0 && clickedCount < buttons.length;
      if (shouldPause) {
        console.log(
          `Pausing ${DOWNLOAD_CLICK_BURST_DELAY_MS / 1000} seconds after ${clickedCount} download clicks...`
        );
        await delay(DOWNLOAD_CLICK_BURST_DELAY_MS);
      }
    }
    return buttons.length;
  }

  async function handlePostSend(
    index,
    total,
    sleepDuration,
    sleepSeconds,
    useNewChat,
    previousButtons,
    options
  ) {
    const progressCurrent =
      options && Number.isFinite(options.progressCurrent) ? options.progressCurrent : index + 1;
    const progressTotal = options && Number.isFinite(options.progressTotal) ? options.progressTotal : total;
    const filenameBaseBuilder =
      options && typeof options.filenameBaseBuilder === "function"
        ? options.filenameBaseBuilder
        : undefined;

    if (useNewChat) {
      console.log("Waiting for image download button...");
      const waitResult = await waitForDownloadButtonVisibleWithRetry(previousButtons);
      const newButtons = waitResult.buttons;
      const clickedCount = await clickDownloadButtons(newButtons, undefined, {
        filenameBaseBuilder
      });
      const retrySuffix =
        waitResult.retryCount > 0
          ? ` after ${waitResult.retryCount} retry prompt${waitResult.retryCount === 1 ? "" : "s"}`
          : "";
      console.log(
        `Image downloaded${retrySuffix} (${progressCurrent}/${progressTotal}) via ${clickedCount} click(s).`
      );

      if (index < total - 1) {
        await openNewChat();
        await delay(sleepDuration > 0 ? sleepDuration : 1200);
      }
      return;
    }

    if (index < total - 1) {
      console.log(`Waiting ${sleepSeconds} seconds before the next send...`);
      await delay(sleepDuration);
    }
  }

  async function sendMessageRepeatedly(msg, n, sleep, mode) {
    const count = n ?? 10;
    const sleepSeconds = sleep ?? 30;
    const sleepDuration = sleepSeconds * 1000;
    const sendMode = normalizeSendMode(mode);
    const useNewChat = sendMode === SEND_MODES.NEW_CHAT_IMAGE;

    for (let i = 0; i < count; i++) {
      const previousButtons = useNewChat ? new Set(getDownloadButtons()) : undefined;
      await sendMessage(msg);
      console.log(`Message sent (${i + 1}/${count}).`);
      await handlePostSend(i, count, sleepDuration, sleepSeconds, useNewChat, previousButtons);
    }
  }

  function toInteger(value, fallback) {
    if (value === undefined || value === null) {
      return fallback;
    }
    const n = Number(value);
    if (!Number.isFinite(n)) {
      throw new Error(`Expected an integer-compatible value, got: ${String(value)}`);
    }
    return Math.trunc(n);
  }

  function clamp(value, min, max) {
    if (value < min) {
      return min;
    }
    if (value > max) {
      return max;
    }
    return value;
  }

  function normalizeIndex(index, length, zeroMeansLength) {
    if (zeroMeansLength && index === 0) {
      return length;
    }
    if (index < 0) {
      return length + index;
    }
    return index;
  }

  // options:
  // - continueOnImageDownloadTimeout: in new_chat_image mode only, save the failed prompt
  //   to a .txt file and continue to the next item after the final timeout instead of throwing.
  async function sendMessageRepeatedlyArray(msgs, sleep, sep, prefix, postfix, from, to, mode, options) {
    const sleepSeconds = sleep ?? 30;
    const sleepDuration = sleepSeconds * 1000;
    const separator = sep ?? "\n";
    const prefixText = prefix ?? "";
    const postfixText = postfix ?? "";
    const sendMode = normalizeSendMode(mode);
    const useNewChat = sendMode === SEND_MODES.NEW_CHAT_IMAGE;
    const continueOnImageDownloadTimeout = Boolean(
      useNewChat && options && options.continueOnImageDownloadTimeout
    );

    let messages;
    if (Array.isArray(msgs)) {
      messages = msgs.map((msg) => String(msg));
    } else if (typeof msgs === "string") {
      messages = msgs.split(separator);
    } else {
      throw new Error("Expected msgs to be an array of strings or a string.");
    }

    if (messages.length === 0) {
      console.log("No messages to send.");
      return;
    }

    const fromIndexRaw = toInteger(from, 0);
    const toIndexRaw = toInteger(to, 0);
    const fromIndex = clamp(normalizeIndex(fromIndexRaw, messages.length, false), 0, messages.length);
    const toIndexExclusive = clamp(normalizeIndex(toIndexRaw, messages.length, true), 0, messages.length);

    if (fromIndex >= toIndexExclusive) {
      console.log(`No messages to send for range from=${fromIndexRaw}, to=${toIndexRaw}.`);
      return;
    }

    const selectedMessages = messages.slice(fromIndex, toIndexExclusive);
    const lastIndex = toIndexExclusive - 1;

    for (let i = 0; i < selectedMessages.length; i++) {
      const absoluteIndex = fromIndex + i;
      const fullPrompt = `${prefixText}${selectedMessages[i]}${postfixText}`;
      const previousButtons = useNewChat ? new Set(getDownloadButtons()) : undefined;
      await sendMessage(fullPrompt);
      console.log(`Message sent (${absoluteIndex}/${lastIndex}).`);

      try {
        await handlePostSend(
          i,
          selectedMessages.length,
          sleepDuration,
          sleepSeconds,
          useNewChat,
          previousButtons,
          {
            progressCurrent: absoluteIndex,
            progressTotal: lastIndex,
            filenameBaseBuilder: useNewChat
              ? (downloadIndex) =>
                  downloadIndex === 0 ? `${absoluteIndex}` : `${absoluteIndex}_${downloadIndex}`
              : undefined
          }
        );
      } catch (error) {
        if (!continueOnImageDownloadTimeout || !isImageDownloadTimeoutError(error)) {
          throw error;
        }

        const failedFilename = downloadTextFile(
          fullPrompt,
          `failed_prompt_${absoluteIndex}_of_${lastIndex}`
        );
        console.error(
          `Timed out waiting for image download button (${absoluteIndex}/${lastIndex}). ` +
            `Saved failed prompt to "${failedFilename}". Continuing.`,
          error
        );

        if (i < selectedMessages.length - 1) {
          await openNewChat();
          await delay(sleepDuration > 0 ? sleepDuration : 1200);
        }
      }
    }
  }

  async function chooseFileAsText() {
    return new Promise((resolve, reject) => {
      const input = document.createElement("input");
      input.type = "file";
      const textFileAccept = [
        "text/*",
        "application/json",
        "application/ld+json",
        "application/xml",
        "application/x-yaml",
        "application/yaml",
        ".md",
        ".markdown",
        ".txt",
        ".csv",
        ".tsv",
        ".json",
        ".jsonl",
        ".xml",
        ".yml",
        ".yaml",
        ".toml",
        ".ini",
        ".cfg",
        ".conf",
        ".log"
      ].join(",");
      input.accept = textFileAccept;
      input.style.display = "none";
      document.body.appendChild(input);

      let settled = false;
      const cleanup = () => {
        input.removeEventListener("change", onChange);
        input.removeEventListener("cancel", onCancel);
        window.removeEventListener("focus", onFocus);
        input.remove();
      };

      const settleResolve = (value) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        resolve(value);
      };

      const settleReject = (error) => {
        if (settled) {
          return;
        }
        settled = true;
        cleanup();
        reject(error instanceof Error ? error : new Error(String(error)));
      };

      const onChange = async () => {
        const file = input.files && input.files[0];
        if (!file) {
          settleReject(new Error("No file selected."));
          return;
        }

        try {
          const text = await file.text();
          settleResolve(text);
        } catch (error) {
          settleReject(error);
        }
      };

      const onCancel = () => {
        settleReject(new Error("File selection was canceled."));
      };

      const onFocus = () => {
        setTimeout(() => {
          if (settled) {
            return;
          }
          if (!input.files || input.files.length === 0) {
            settleReject(new Error("File selection was canceled."));
          }
        }, 0);
      };

      input.addEventListener("change", onChange);
      input.addEventListener("cancel", onCancel);
      window.addEventListener("focus", onFocus);
      input.click();
    });
  }

  async function sendMessageRepeatedlyArrayChooseFile(
    sleep,
    sep,
    prefix,
    postfix,
    from,
    to,
    mode
  ) {
    const fileText = await chooseFileAsText();
    const sendMode = normalizeSendMode(mode);
    await sendMessageRepeatedlyArray(fileText, sleep, sep, prefix, postfix, from, to, sendMode, {
      continueOnImageDownloadTimeout: sendMode === SEND_MODES.NEW_CHAT_IMAGE
    });
  }

  async function clickDallEDownloadButtons() {
    return clickDownloadButtons(getDownloadButtons());
  }

  // Export helpers so they are callable from devtools console.
  window.delay = delay;
  window.fireShortcut = fireShortcut;
  window.sendModes = SEND_MODES;
  window.promptSet = promptSet;
  window.clickRegenerate = clickRegenerate;
  window.clickSendButton = clickSendButton;
  window.openNewChat = openNewChat;
  window.sendMessage = sendMessage;
  window.sendMessageRepeatedly = sendMessageRepeatedly;
  window.sendMessageRepeatedlyArray = sendMessageRepeatedlyArray;
  window.sendMessageRepeatedlyArrayChooseFile = sendMessageRepeatedlyArrayChooseFile;
  window.clickDallEDownloadButtons = clickDallEDownloadButtons;

  // Keep these globals so this call style works in console:
  // sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)
  // sendMessageRepeatedlyArray("Prompt 1\nPrompt 2", sleep=10, sep="\n", prefix="", postfix="", from=0, to=0, mode="continuous")
  // sendMessageRepeatedlyArrayChooseFile(sleep=10, sep="\n", prefix="", postfix="", from=0, to=0, mode="new_chat_image")
  if (!("n" in window)) {
    window.n = undefined;
  }
  if (!("sleep" in window)) {
    window.sleep = undefined;
  }
  if (!("sep" in window)) {
    window.sep = undefined;
  }
  if (!("prefix" in window)) {
    window.prefix = undefined;
  }
  if (!("postfix" in window)) {
    window.postfix = undefined;
  }
  if (!("from" in window)) {
    window.from = undefined;
  }
  if (!("to" in window)) {
    window.to = undefined;
  }
  if (!("mode" in window)) {
    window.mode = undefined;
  }

  console.log(
    '[userscript] Ready. Example: sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)'
  );
})();
