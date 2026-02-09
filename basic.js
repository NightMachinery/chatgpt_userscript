// ==UserScript==
// @name         ChatGPT Message Helper
// @namespace    https://chatgpt.com/
// @version      1.1.3
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
    return document.querySelector(
      '#prompt-textarea[contenteditable="true"], textarea#prompt-textarea, div#prompt-textarea'
    );
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
    const timeoutSeconds = timeout ?? 3600;
    const timeoutMs = timeoutSeconds * 1000;
    const startTime = Date.now();

    while (Date.now() - startTime < timeoutMs) {
      const buttons = getNewDownloadButtons(previousButtons);
      if (buttons.length > 0) {
        return buttons;
      }
      await delay(intervalMs);
    }

    throw new Error("Timed out waiting for a new visible image download button.");
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

  async function clickDownloadButtons(buttons, noButtonsMessage = DOWNLOAD_LOG_MESSAGES.noButtonsFound) {
    if (!Array.isArray(buttons) || buttons.length === 0) {
      console.log(noButtonsMessage);
      return 0;
    }

    console.log(`Found ${buttons.length} image download button(s). Clicking all.`);
    for (let index = 0; index < buttons.length; index++) {
      const button = buttons[index];
      console.log(`Clicking button ${index + 1}`);
      button.click();
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

  async function handlePostSend(index, total, sleepDuration, sleepSeconds, useNewChat, previousButtons) {
    if (useNewChat) {
      console.log("Waiting for image download button...");
      const newButtons = await waitForDownloadButtonVisible(undefined, undefined, previousButtons);
      const clickedCount = await clickDownloadButtons(newButtons);
      console.log(`Image downloaded (${index + 1}/${total}) via ${clickedCount} click(s).`);

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

  async function sendMessageRepeatedlyArray(msgs, sleep, sep, prefix, postfix, from, to, mode) {
    const sleepSeconds = sleep ?? 30;
    const sleepDuration = sleepSeconds * 1000;
    const separator = sep ?? "\n";
    const prefixText = prefix ?? "";
    const postfixText = postfix ?? "";
    const sendMode = normalizeSendMode(mode);
    const useNewChat = sendMode === SEND_MODES.NEW_CHAT_IMAGE;

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

    for (let i = 0; i < selectedMessages.length; i++) {
      const previousButtons = useNewChat ? new Set(getDownloadButtons()) : undefined;
      await sendMessage(`${prefixText}${selectedMessages[i]}${postfixText}`);
      console.log(`Message sent (${i + 1}/${selectedMessages.length}).`);
      await handlePostSend(
        i,
        selectedMessages.length,
        sleepDuration,
        sleepSeconds,
        useNewChat,
        previousButtons
      );
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
    await sendMessageRepeatedlyArray(fileText, sleep, sep, prefix, postfix, from, to, mode);
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
