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

  async function sendMessageRepeatedlyArray(msgs, sleep, sep, prefix, postfix) {
    const sleepSeconds = sleep ?? 30;
    const sleepDuration = sleepSeconds * 1000;
    const separator = sep ?? "\n";
    const prefixText = prefix ?? "";
    const postfixText = postfix ?? "";

    let messages;
    if (Array.isArray(msgs)) {
      messages = msgs.map((msg) => String(msg));
    } else if (typeof msgs === "string") {
      messages = msgs.split(separator);
    } else {
      throw new Error("Expected msgs to be an array of strings or a string.");
    }

    for (let i = 0; i < messages.length; i++) {
      await sendMessage(`${prefixText}${messages[i]}${postfixText}`);
      console.log(`Message sent (${i + 1}/${messages.length}).`);

      if (i < messages.length - 1) {
        console.log(`Waiting ${sleepSeconds} seconds before the next send...`);
        await delay(sleepDuration);
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

  async function sendMessageRepeatedlyArrayChooseFile(sleep, sep, prefix, postfix) {
    const fileText = await chooseFileAsText();
    await sendMessageRepeatedlyArray(fileText, sleep, sep, prefix, postfix);
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
  window.sendMessageRepeatedlyArray = sendMessageRepeatedlyArray;
  window.sendMessageRepeatedlyArrayChooseFile = sendMessageRepeatedlyArrayChooseFile;
  window.clickDallEDownloadButtons = clickDallEDownloadButtons;

  // Keep these globals so this call style works in console:
  // sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)
  // sendMessageRepeatedlyArray("Prompt 1\nPrompt 2", sleep=10, sep="\n", prefix="", postfix="")
  // sendMessageRepeatedlyArrayChooseFile(sleep=10, sep="\n", prefix="", postfix="")
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

  console.log(
    '[userscript] Ready. Example: sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)'
  );
})();
