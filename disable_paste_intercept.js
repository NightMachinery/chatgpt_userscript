// ==UserScript==
// @name         Disable Paste Intercept
// @namespace    https://github.com/NightMachinery/chatgpt_userscript
// @version      0.2.0
// @description  Insert pasted text directly into AI chat editors so long text is not converted into a file attachment.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://gemini.google.com/*
// @match        https://perplexity.ai/*
// @match        https://www.perplexity.ai/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(function () {
  "use strict";

  const USERSCRIPT_VERSION = "0.2.0";
  const PASTE_MODE = "chunked"; // "atOnce" | "chunked"
  const CHUNK_SIZE = 10000;
  const CHUNK_DELAY = 50;

  const EDITABLE_SELECTOR = [
    "textarea",
    "input",
    '[contenteditable="true"]',
    '[role="textbox"]'
  ].join(",");
  const TEXT_INPUT_TYPE_PATTERN = /^(text|search|url|tel|password|email|number)$/i;

  function isVisibleElement(element) {
    if (!element || !(element instanceof Element)) {
      return false;
    }
    const style = window.getComputedStyle(element);
    const rect = element.getBoundingClientRect();
    return (
      style.display !== "none" &&
      style.visibility !== "hidden" &&
      rect.width > 0 &&
      rect.height > 0
    );
  }

  function isWritableTextInput(element) {
    if (!(element instanceof HTMLInputElement)) {
      return false;
    }
    return (
      TEXT_INPUT_TYPE_PATTERN.test(element.type || "text") &&
      !element.readOnly &&
      !element.disabled
    );
  }

  function isWritableTextArea(element) {
    return (
      element instanceof HTMLTextAreaElement &&
      !element.readOnly &&
      !element.disabled
    );
  }

  function isWritableRichTextEditor(element) {
    return (
      element instanceof HTMLElement &&
      (
        element.isContentEditable ||
        element.getAttribute("contenteditable") === "true" ||
        element.getAttribute("role") === "textbox"
      )
    );
  }

  function isWritableEditable(element) {
    return (
      isWritableTextInput(element) ||
      isWritableTextArea(element) ||
      isWritableRichTextEditor(element)
    );
  }

  function findVisibleEditorFallback() {
    return Array.from(document.querySelectorAll(EDITABLE_SELECTOR)).find((element) => (
      isWritableEditable(element) && isVisibleElement(element)
    )) || null;
  }

  function findEditableFromPasteTarget(target) {
    if (!target || !(target instanceof Element)) {
      return null;
    }

    let editable = target.closest(EDITABLE_SELECTOR);
    if (!editable || !isWritableEditable(editable)) {
      return null;
    }

    // Some editors keep a hidden textarea/input as a fallback and proxy focus to a
    // visible contenteditable surface. Prefer the visible editor when possible.
    if (!isVisibleElement(editable)) {
      editable = findVisibleEditorFallback() || editable;
    }

    return isWritableEditable(editable) ? editable : null;
  }

  function dispatchInputEvent(element, text) {
    try {
      element.dispatchEvent(new InputEvent("input", {
        bubbles: true,
        cancelable: false,
        inputType: "insertFromPaste",
        data: text
      }));
    } catch (_) {
      element.dispatchEvent(new Event("input", { bubbles: true }));
    }
  }

  function insertIntoPlainTextControl(element, text) {
    element.focus();
    const value = element.value || "";
    const start = Number.isFinite(element.selectionStart) ? element.selectionStart : value.length;
    const end = Number.isFinite(element.selectionEnd) ? element.selectionEnd : start;

    if (typeof element.setRangeText === "function") {
      element.setRangeText(text, start, end, "end");
    } else {
      element.value = `${value.slice(0, start)}${text}${value.slice(end)}`;
      const cursor = start + text.length;
      if (typeof element.setSelectionRange === "function") {
        element.setSelectionRange(cursor, cursor);
      }
    }
    dispatchInputEvent(element, text);
  }

  function insertIntoRichTextEditor(element, text) {
    element.focus();

    try {
      if (document.execCommand("insertText", false, text)) {
        return;
      }
    } catch (_) {
      // Fall back to DOM Range insertion below.
    }

    const selection = window.getSelection();
    if (selection && selection.rangeCount > 0) {
      selection.deleteFromDocument();
      const range = selection.getRangeAt(0);
      const textNode = document.createTextNode(text);
      range.insertNode(textNode);
      range.setStartAfter(textNode);
      range.collapse(true);
      selection.removeAllRanges();
      selection.addRange(range);
    } else {
      element.appendChild(document.createTextNode(text));
    }

    dispatchInputEvent(element, text);
  }

  function insertPlainText(element, text) {
    if (isWritableTextInput(element) || isWritableTextArea(element)) {
      insertIntoPlainTextControl(element, text);
      return;
    }
    insertIntoRichTextEditor(element, text);
  }

  function createProgressBar() {
    const container = document.createElement("div");
    container.style.position = "fixed";
    container.style.top = "0";
    container.style.left = "0";
    container.style.width = "100%";
    container.style.height = "4px";
    container.style.backgroundColor = "#e0e0e0";
    container.style.zIndex = "999999";
    container.style.pointerEvents = "none";
    
    const bar = document.createElement("div");
    bar.style.height = "100%";
    bar.style.width = "0%";
    bar.style.backgroundColor = "#4caf50";
    bar.style.transition = "width 0.1s linear";
    
    container.appendChild(bar);
    document.body.appendChild(container);
    return { container, bar };
  }

  function playCompletionSound() {
    try {
      const audioCtx = new (window.AudioContext || window.webkitAudioContext)();
      const oscillator = audioCtx.createOscillator();
      const gainNode = audioCtx.createGain();
      
      oscillator.type = "sine";
      oscillator.frequency.setValueAtTime(880, audioCtx.currentTime); // A5
      gainNode.gain.setValueAtTime(0.1, audioCtx.currentTime);
      gainNode.gain.exponentialRampToValueAtTime(0.001, audioCtx.currentTime + 0.1);
      
      oscillator.connect(gainNode);
      gainNode.connect(audioCtx.destination);
      
      oscillator.start();
      oscillator.stop(audioCtx.currentTime + 0.1);
    } catch (e) {
      console.error("Failed to play sound", e);
    }
  }

  async function insertPlainTextChunked(element, text) {
    const startTime = Date.now();
    const progress = createProgressBar();
    
    const numChunks = Math.ceil(text.length / CHUNK_SIZE);
    
    for (let i = 0; i < numChunks; i++) {
      const chunk = text.slice(i * CHUNK_SIZE, (i + 1) * CHUNK_SIZE);
      
      insertPlainText(element, chunk);
      
      progress.bar.style.width = `${((i + 1) / numChunks) * 100}%`;
      
      // Yield to the event loop
      await new Promise(resolve => setTimeout(resolve, CHUNK_DELAY));
    }
    
    progress.container.remove();
    
    if (Date.now() - startTime > 10000) {
      playCompletionSound();
    }
  }

  function onPaste(event) {
    const clipboardData = event.clipboardData;
    if (!clipboardData || typeof clipboardData.getData !== "function") {
      return;
    }

    const text = clipboardData.getData("text/plain");
    if (!text) {
      return;
    }

    const editable = findEditableFromPasteTarget(event.target);
    if (!editable) {
      return;
    }

    event.preventDefault();
    event.stopImmediatePropagation();
    
    if (PASTE_MODE === "chunked" && text.length > CHUNK_SIZE) {
      insertPlainTextChunked(editable, text).catch(console.error);
    } else {
      insertPlainText(editable, text);
    }
  }

  window.addEventListener("paste", onPaste, { capture: true });

  window.disablePasteIntercept = Object.freeze({
    version: USERSCRIPT_VERSION
  });
})();