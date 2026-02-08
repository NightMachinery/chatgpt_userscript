// ==UserScript==
// @name         ChatGPT Message Helper
// @namespace    https://chatgpt.com/
// @version      1.0.0
// @description  Reliable message sending helpers for ChatGPT web UI changes.
// @match        https://chatgpt.com/*
// @grant        none
// ==/UserScript==

(function () {
  function delay(duration) {
    return new Promise((resolve) => setTimeout(resolve, duration));
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

  async function sendMessageRepeatedly(msg, n, sleep, newChatP) {
    void newChatP;

    const count = n ?? 10;
    const sleepSeconds = sleep ?? 30;
    const sleepDuration = sleepSeconds * 1000;

    for (let i = 0; i < count; i++) {
      await sendMessage(msg);
      console.log(`Message sent (${i + 1}/${count}).`);

      if (i < count - 1) {
        console.log(`Waiting ${sleepSeconds} seconds before the next send...`);
        await delay(sleepDuration);
      }
    }
  }

  function clickDallEDownloadButtons() {
    const buttons = Array.from(
      document.querySelectorAll(
        'button[aria-label="Download this image"], button[aria-label*="Download image" i], button[data-testid*="download" i]'
      )
    ).filter((button) => !button.disabled);

    if (buttons.length === 0) {
      console.log("No DALL·E download buttons found.");
      return;
    }

    console.log(`Found ${buttons.length} DALL·E download buttons. Clicking all.`);
    buttons.forEach((button, index) => {
      console.log(`Clicking button ${index + 1}`);
      button.click();
    });
  }

  // Export helpers so they are callable from devtools console.
  window.delay = delay;
  window.promptSet = promptSet;
  window.clickRegenerate = clickRegenerate;
  window.clickSendButton = clickSendButton;
  window.sendMessage = sendMessage;
  window.sendMessageRepeatedly = sendMessageRepeatedly;
  window.clickDallEDownloadButtons = clickDallEDownloadButtons;

  // Keep these globals so this call style works in console:
  // sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)
  if (!("n" in window)) {
    window.n = undefined;
  }
  if (!("sleep" in window)) {
    window.sleep = undefined;
  }

  console.log(
    '[userscript] Ready. Example: sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)'
  );
})();
