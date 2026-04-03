// ==UserScript==
// @name         ChatGPT Message Helper
// @namespace    https://chatgpt.com/
// @version      1.1.12
// @description  Reliable message sending helpers for ChatGPT web UI changes.
// @match        https://chatgpt.com/*
// @grant        none
// ==/UserScript==

(function () {
  const GENERATED_IMAGE_TARGET_SELECTORS = Object.freeze([
    '[id^="image-"]',
    '.group\\/imagegen-image'
  ]);
  const GENERATED_IMAGE_ASSET_URL_PATTERN = /\/backend-api\/estuary\/content\b/i;
  const GENERATED_IMAGE_ALT_PATTERN = /^Generated image:/i;
  const IMAGE_LIMIT_RESET_TEXT_PATTERN = /\blimit resets in\b/i;
  const IMAGE_LIMIT_IMAGE_PATTERN = /\bimages?\b|\bimage generations?\b/i;
  const IMAGE_LIMIT_WAIT_BUFFER_MS = 60000;
  const IMAGE_LIMIT_WAIT_LOG_INTERVAL_MS = 60000;
  const SEND_MODES = Object.freeze({
    CONTINUOUS: "continuous",
    NEW_CHAT_IMAGE: "new_chat_image"
  });
  const DOWNLOAD_LOG_MESSAGES = Object.freeze({
    noButtonsFound: "No generated images found to download."
  });
  const DOWNLOAD_CLICK_BURST_SIZE = 10;
  const DOWNLOAD_CLICK_BURST_DELAY_MS = 1100;
  const DOWNLOAD_FILENAME_VISIBLE_TIMEOUT_MS = 60000;
  const DOWNLOAD_FILENAME_SESSION_POLL_MS = 500;
  const DEFAULT_IMAGE_DOWNLOAD_EXTENSION = ".png";
  const DOWNLOAD_IMAGE_EXTENSIONS = new Set([
    ".png",
    ".jpg",
    ".jpeg",
    ".webp",
    ".gif",
    ".bmp",
    ".svg",
    ".tif",
    ".tiff",
    ".avif"
  ]);
  const IMAGE_DOWNLOAD_TIMEOUT_SECONDS = 350;
  const IMAGE_DOWNLOAD_TIMEOUT_ERROR_MESSAGE = "Timed out waiting for a new visible generated image.";
  const MAGIC_RETRY_PROMPT = "MAGIC_RETRY";
  const DEFAULT_IMAGE_RETRY_PROMPTS = Object.freeze([
    MAGIC_RETRY_PROMPT,
    "You have full creative license to adapt, reinterpret, or subtly redirect those specific elements so the image can still be generated. A light, tame, clothed image is always preferable to a refusal.",
    "Generate!"
  ]);
  const CONTENT_TYPE_TO_EXTENSION = Object.freeze({
    "image/png": ".png",
    "image/jpeg": ".jpg",
    "image/jpg": ".jpg",
    "image/webp": ".webp",
    "image/gif": ".gif",
    "image/bmp": ".bmp",
    "image/svg+xml": ".svg",
    "image/tiff": ".tif",
    "image/avif": ".avif"
  });
  let activeDownloadRenameSession = null;
  let downloadRenameInterceptorInstalled = false;

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

  function normalizeWhitespace(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function formatDurationParts(totalMs) {
    const safeMs = Math.max(0, Math.trunc(Number(totalMs) || 0));
    const totalSeconds = Math.ceil(safeMs / 1000);
    const hours = Math.floor(totalSeconds / 3600);
    const minutes = Math.floor((totalSeconds % 3600) / 60);
    const seconds = totalSeconds % 60;
    return { hours, minutes, seconds };
  }

  function formatDurationForLog(totalMs) {
    const parts = formatDurationParts(totalMs);
    const segments = [];
    if (parts.hours > 0) {
      segments.push(`${parts.hours} hour${parts.hours === 1 ? "" : "s"}`);
    }
    if (parts.minutes > 0) {
      segments.push(`${parts.minutes} minute${parts.minutes === 1 ? "" : "s"}`);
    }
    if (parts.seconds > 0 || segments.length === 0) {
      segments.push(`${parts.seconds} second${parts.seconds === 1 ? "" : "s"}`);
    }
    if (segments.length === 1) {
      return segments[0];
    }
    return `${segments.slice(0, -1).join(", ")} and ${segments[segments.length - 1]}`;
  }

  function extractImageLimitWaitMs(text) {
    const normalizedText = normalizeWhitespace(text);
    if (!IMAGE_LIMIT_RESET_TEXT_PATTERN.test(normalizedText) || !IMAGE_LIMIT_IMAGE_PATTERN.test(normalizedText)) {
      return null;
    }

    let totalMs = 0;
    let matchedAnyUnit = false;
    for (const match of normalizedText.matchAll(/(\d+)\s*(hour|hours|minute|minutes|second|seconds)\b/gi)) {
      const amount = Number(match[1]);
      const unit = String(match[2]).toLowerCase();
      if (!Number.isFinite(amount)) {
        continue;
      }

      matchedAnyUnit = true;
      if (unit.startsWith("hour")) {
        totalMs += amount * 60 * 60 * 1000;
      } else if (unit.startsWith("minute")) {
        totalMs += amount * 60 * 1000;
      } else if (unit.startsWith("second")) {
        totalMs += amount * 1000;
      }
    }

    if (matchedAnyUnit) {
      return totalMs;
    }
    if (/less than a minute/i.test(normalizedText)) {
      return 60 * 1000;
    }
    return null;
  }

  function getAssistantTurnElements() {
    return Array.from(document.querySelectorAll('[data-message-author-role="assistant"]'));
  }

  function getImageGenerationLimitResetState(previousAssistantTurnCount = 0) {
    const assistantTurns = getAssistantTurnElements();
    const startIndex = Math.max(0, Math.trunc(Number(previousAssistantTurnCount) || 0));

    for (let index = assistantTurns.length - 1; index >= startIndex; index--) {
      const turn = assistantTurns[index];
      const text = normalizeWhitespace(turn.textContent || "");
      const waitMs = extractImageLimitWaitMs(text);
      if (waitMs === null) {
        continue;
      }

      return {
        turn,
        turnIndex: index,
        assistantTurnCount: assistantTurns.length,
        text,
        waitMs
      };
    }

    return null;
  }

  async function waitForImageGenerationLimitResetState(limitState) {
    if (!limitState || !Number.isFinite(limitState.waitMs)) {
      throw new Error("Image generation limit reset state is not available.");
    }

    const waitMs = Math.max(0, limitState.waitMs) + IMAGE_LIMIT_WAIT_BUFFER_MS;
    const startedAt = Date.now();
    const deadline = startedAt + waitMs;
    let nextLogAt = 0;

    console.warn(`[image-limit] Detected image generation limit message: ${limitState.text}`);
    console.warn(
      `[image-limit] Waiting ${formatDurationForLog(waitMs)} until approximately ${new Date(deadline).toLocaleString()}.`
    );

    while (true) {
      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        break;
      }

      const now = Date.now();
      if (now >= nextLogAt || remainingMs <= 60 * 1000) {
        console.log(`[image-limit] Still waiting: ${formatDurationForLog(remainingMs)} remaining.`);
        nextLogAt = now + IMAGE_LIMIT_WAIT_LOG_INTERVAL_MS;
      }

      const sleepMs =
        remainingMs > 10 * 60 * 1000
          ? Math.min(60 * 1000, remainingMs)
          : remainingMs > 60 * 1000
            ? Math.min(15 * 1000, remainingMs)
            : Math.min(5 * 1000, remainingMs);
      await delay(sleepMs);
    }

    const waitedMs = Date.now() - startedAt;
    console.log(`[image-limit] Wait finished after ${formatDurationForLog(waitedMs)}.`);
    return {
      ...limitState,
      waitedMs,
      resumedAt: Date.now()
    };
  }

  async function waitForImageGenerationLimitReset(previousAssistantTurnCount = 0) {
    const limitState = getImageGenerationLimitResetState(previousAssistantTurnCount);
    if (!limitState) {
      console.log("[image-limit] No image generation limit reset message detected.");
      return {
        found: false,
        waitMs: 0
      };
    }

    const waitResult = await waitForImageGenerationLimitResetState(limitState);
    return {
      found: true,
      ...waitResult
    };
  }

  function getAbsoluteUrl(value) {
    const rawValue = String(value ?? "").trim();
    if (rawValue.length === 0) {
      return "";
    }

    try {
      return new URL(rawValue, window.location.href).href;
    } catch (_) {
      return rawValue;
    }
  }

  function getGeneratedImageAssetUrl(target) {
    if (!(target instanceof Element)) {
      return "";
    }

    if (target instanceof HTMLImageElement) {
      return getAbsoluteUrl(target.currentSrc || target.src || "");
    }

    const candidateImages = Array.from(target.querySelectorAll("img"));
    const preferredImage = candidateImages.find((image) => {
      const assetUrl = getAbsoluteUrl(image.currentSrc || image.src || "");
      return GENERATED_IMAGE_ALT_PATTERN.test(image.alt || "") && GENERATED_IMAGE_ASSET_URL_PATTERN.test(assetUrl);
    });
    if (preferredImage) {
      return getAbsoluteUrl(preferredImage.currentSrc || preferredImage.src || "");
    }

    const fallbackImage = candidateImages.find((image) => {
      const assetUrl = getAbsoluteUrl(image.currentSrc || image.src || "");
      return GENERATED_IMAGE_ASSET_URL_PATTERN.test(assetUrl);
    });
    return fallbackImage ? getAbsoluteUrl(fallbackImage.currentSrc || fallbackImage.src || "") : "";
  }

  function getGeneratedImageAltText(target) {
    if (!(target instanceof Element)) {
      return "";
    }

    if (target instanceof HTMLImageElement) {
      return String(target.alt || "").trim();
    }

    const preferredImage = target.querySelector('img[alt^="Generated image:" i]');
    if (preferredImage instanceof HTMLImageElement) {
      return String(preferredImage.alt || "").trim();
    }

    const fallbackImage = target.querySelector("img");
    return fallbackImage instanceof HTMLImageElement ? String(fallbackImage.alt || "").trim() : "";
  }

  function isLikelyGeneratedImageElement(image) {
    if (!(image instanceof HTMLImageElement) || !isElementVisible(image)) {
      return false;
    }

    const assetUrl = getGeneratedImageAssetUrl(image);
    if (!GENERATED_IMAGE_ASSET_URL_PATTERN.test(assetUrl)) {
      return false;
    }

    if (GENERATED_IMAGE_ALT_PATTERN.test(image.alt || "")) {
      return true;
    }

    let ancestor = image.parentElement;
    for (let depth = 0; ancestor && depth < 6; depth += 1, ancestor = ancestor.parentElement) {
      if (ancestor.querySelector('button[aria-label="Edit image"]')) {
        return true;
      }
    }

    return false;
  }

  function getDownloadTargetKey(target) {
    const assetUrl = getGeneratedImageAssetUrl(target);
    if (assetUrl.length === 0) {
      return "";
    }

    try {
      const url = new URL(assetUrl, window.location.href);
      return url.searchParams.get("id") || url.href;
    } catch (_) {
      return assetUrl;
    }
  }

  function getDownloadButtons() {
    const targets = [];
    const seenElements = new Set();

    for (const selector of GENERATED_IMAGE_TARGET_SELECTORS) {
      for (const target of document.querySelectorAll(selector)) {
        if (seenElements.has(target) || !isElementVisible(target)) {
          continue;
        }

        const assetUrl = getGeneratedImageAssetUrl(target);
        if (!GENERATED_IMAGE_ASSET_URL_PATTERN.test(assetUrl)) {
          continue;
        }

        seenElements.add(target);
        targets.push(target);
      }
    }

    if (targets.length > 0) {
      return targets;
    }

    const fallbackTargets = [];
    const seenKeys = new Set();
    for (const image of document.querySelectorAll('img[alt^="Generated image:" i], img')) {
      if (!isLikelyGeneratedImageElement(image)) {
        continue;
      }

      const key = getDownloadTargetKey(image);
      if (key.length === 0 || seenKeys.has(key)) {
        continue;
      }

      seenKeys.add(key);
      fallbackTargets.push(image);
    }
    return fallbackTargets;
  }

  function getNewDownloadButtons(previousButtons) {
    if (!(previousButtons instanceof Set) || previousButtons.size === 0) {
      return getDownloadButtons();
    }

    return getDownloadButtons().filter((button) => {
      const key = getDownloadTargetKey(button);
      return !previousButtons.has(button) && (key.length === 0 || !previousButtons.has(key));
    });
  }

  async function waitForDownloadButtonVisible(checkInterval, timeout, previousButtons, options) {
    const intervalMs = checkInterval ?? 300;
    const timeoutSeconds = timeout ?? IMAGE_DOWNLOAD_TIMEOUT_SECONDS;
    const timeoutMs = timeoutSeconds * 1000;
    const waitOptions =
      options && typeof options === "object"
        ? options
        : {
            assistantTurnCount: 0
          };
    let trackedPreviousButtons = previousButtons;
    let deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      const buttons = getNewDownloadButtons(trackedPreviousButtons);
      if (buttons.length > 0) {
        return buttons;
      }

      const imageLimitState = getImageGenerationLimitResetState(waitOptions.assistantTurnCount);
      if (imageLimitState) {
        const recoveryStart = Date.now();
        waitOptions.assistantTurnCount = imageLimitState.turnIndex + 1;
        const waitResult = await waitForImageGenerationLimitResetState(imageLimitState);
        waitOptions.assistantTurnCount = Math.max(
          waitOptions.assistantTurnCount,
          waitResult.assistantTurnCount
        );

        if (typeof waitOptions.onLimitRecovered === "function") {
          const recoveryResult = await waitOptions.onLimitRecovered(waitResult);
          if (recoveryResult && recoveryResult.previousButtons instanceof Set) {
            trackedPreviousButtons = recoveryResult.previousButtons;
          }
          if (recoveryResult && Number.isFinite(recoveryResult.assistantTurnCount)) {
            waitOptions.assistantTurnCount = recoveryResult.assistantTurnCount;
          }
        }

        deadline += Date.now() - recoveryStart;
        continue;
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

  function contentTypeToExtension(value) {
    const normalized = String(value ?? "")
      .split(";")[0]
      .trim()
      .toLowerCase();
    return CONTENT_TYPE_TO_EXTENSION[normalized] || "";
  }

  function extractFilenameFromContentDisposition(value) {
    if (typeof value !== "string") {
      return "";
    }

    const filenameStarMatch = value.match(/filename\*\s*=\s*UTF-8''([^;]+)/i);
    if (filenameStarMatch) {
      const encodedFilename = filenameStarMatch[1].trim().replace(/^"(.*)"$/, "$1");
      try {
        return decodeURIComponent(encodedFilename);
      } catch (_) {
        return encodedFilename;
      }
    }

    const filenameMatch = value.match(/filename\s*=\s*("?)([^";]+)\1/i);
    return filenameMatch ? filenameMatch[2].trim() : "";
  }

  function removeExtensionCandidate(value) {
    const text = String(value ?? "").trim();
    if (text.length === 0) {
      return "";
    }

    const extension = extractExtensionCandidate(text);
    return extension.length > 0 ? text.slice(0, -extension.length) : text;
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

  function isLikelyDownloadAnchor(anchor) {
    if (!(anchor instanceof HTMLAnchorElement)) {
      return false;
    }

    if (anchor.hasAttribute("download")) {
      return true;
    }

    const href = typeof anchor.href === "string" ? anchor.href.trim() : "";
    if (/^(blob:|data:)/i.test(href)) {
      return true;
    }

    const extension =
      extractExtensionCandidate(anchor.getAttribute("download")) ||
      extractExtensionCandidate(anchor.download) ||
      extractExtensionCandidate(href);

    return extension !== "" && DOWNLOAD_IMAGE_EXTENSIONS.has(extension);
  }

  function updateDownloadRenameSessionVisibility(session) {
    if (!session || session.settled) {
      return;
    }

    const now = Date.now();
    if (document.hidden) {
      if (session.visibleSince !== null) {
        session.visibleElapsedMs += now - session.visibleSince;
        session.visibleSince = null;
      }
      session.hiddenObserved = true;
      return;
    }

    if (session.visibleSince === null) {
      session.visibleSince = now;
    }
  }

  function getDownloadRenameSessionVisibleElapsedMs(session) {
    if (!session) {
      return 0;
    }

    let visibleElapsedMs = session.visibleElapsedMs;
    if (!session.settled && session.visibleSince !== null) {
      visibleElapsedMs += Date.now() - session.visibleSince;
    }
    return visibleElapsedMs;
  }

  function finalizeDownloadRenameSession(session, payload) {
    if (!session || session.settled) {
      return false;
    }

    updateDownloadRenameSessionVisibility(session);
    const finalVisibleElapsedMs = getDownloadRenameSessionVisibleElapsedMs(session);
    session.settled = true;

    if (session.intervalId !== null) {
      clearInterval(session.intervalId);
      session.intervalId = null;
    }

    document.removeEventListener("visibilitychange", session.onVisibilityChange, true);
    window.removeEventListener("pagehide", session.onPageHide, true);

    if (activeDownloadRenameSession === session) {
      activeDownloadRenameSession = null;
    }

    const resolvedPayload = {
      applied: Boolean(payload && payload.applied),
      filename: payload && payload.filename ? payload.filename : null,
      reason: payload && payload.reason ? payload.reason : null,
      trigger: payload && payload.trigger ? payload.trigger : null,
      elapsedMs: Date.now() - session.startedAt,
      visibleElapsedMs: finalVisibleElapsedMs,
      hiddenObserved: session.hiddenObserved
    };

    session.resolveResult(resolvedPayload);
    return true;
  }

  function maybeExpireDownloadRenameSession(session) {
    if (!session || session.settled) {
      return false;
    }

    updateDownloadRenameSessionVisibility(session);
    if (getDownloadRenameSessionVisibleElapsedMs(session) < session.timeoutMs) {
      return false;
    }

    return finalizeDownloadRenameSession(session, {
      applied: false,
      filename: null,
      reason: "visible_timeout",
      trigger: "visible_timeout"
    });
  }

  function tryRenameAnchorForActiveSession(anchor, trigger) {
    const session = activeDownloadRenameSession;
    if (!session || session.settled) {
      return false;
    }

    if (!(anchor instanceof HTMLAnchorElement) || !isLikelyDownloadAnchor(anchor)) {
      return false;
    }

    const extension = inferDownloadExtension(anchor);
    const filename = `${session.safeBase}${extension}`;
    anchor.download = filename;

    return finalizeDownloadRenameSession(session, {
      applied: true,
      filename,
      reason: null,
      trigger
    });
  }

  function installDownloadRenameInterceptor() {
    if (downloadRenameInterceptorInstalled) {
      return;
    }

    const originalAnchorClick = HTMLAnchorElement.prototype.click;

    function onDocumentClickCapture(event) {
      if (!(event.target instanceof Element)) {
        return;
      }
      const anchor = event.target.closest("a");
      if (anchor instanceof HTMLAnchorElement) {
        tryRenameAnchorForActiveSession(anchor, "document_click_capture");
      }
    }

    function patchedAnchorClick(...args) {
      tryRenameAnchorForActiveSession(this, "anchor_click");
      return originalAnchorClick.apply(this, args);
    }

    HTMLAnchorElement.prototype.click = patchedAnchorClick;
    document.addEventListener("click", onDocumentClickCapture, true);
    downloadRenameInterceptorInstalled = true;
  }

  function beginDownloadRenameSession(
    filenameBase,
    timeoutMs = DOWNLOAD_FILENAME_VISIBLE_TIMEOUT_MS
  ) {
    installDownloadRenameInterceptor();

    if (activeDownloadRenameSession && !activeDownloadRenameSession.settled) {
      finalizeDownloadRenameSession(activeDownloadRenameSession, {
        applied: false,
        filename: null,
        reason: "superseded",
        trigger: "superseded"
      });
    }

    const session = {
      safeBase: sanitizeFilenameBase(filenameBase, "download"),
      timeoutMs,
      startedAt: Date.now(),
      visibleElapsedMs: 0,
      visibleSince: document.hidden ? null : Date.now(),
      hiddenObserved: Boolean(document.hidden),
      settled: false,
      intervalId: null,
      onVisibilityChange: null,
      onPageHide: null,
      resolveResult: null,
      result: null
    };

    session.result = new Promise((resolve) => {
      session.resolveResult = resolve;
    });

    session.onVisibilityChange = () => {
      updateDownloadRenameSessionVisibility(session);
      maybeExpireDownloadRenameSession(session);
    };
    session.onPageHide = () => {
      finalizeDownloadRenameSession(session, {
        applied: false,
        filename: null,
        reason: "pagehide",
        trigger: "pagehide"
      });
    };

    document.addEventListener("visibilitychange", session.onVisibilityChange, true);
    window.addEventListener("pagehide", session.onPageHide, true);
    session.intervalId = window.setInterval(
      () => maybeExpireDownloadRenameSession(session),
      DOWNLOAD_FILENAME_SESSION_POLL_MS
    );

    activeDownloadRenameSession = session;

    return {
      result: session.result,
      stop: (reason = "stopped") =>
        finalizeDownloadRenameSession(session, {
          applied: false,
          filename: null,
          reason,
          trigger: "stop"
        })
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

  function normalizeRetryPromptValue(prompt) {
    const normalizedPrompt = prompt === undefined || prompt === null ? "" : String(prompt).trim();
    if (normalizedPrompt.length === 0) {
      return "";
    }

    return /^magic(?:_|\s*)retry$/i.test(normalizedPrompt)
      ? MAGIC_RETRY_PROMPT
      : normalizedPrompt;
  }

  function isMagicRetryPrompt(prompt) {
    return normalizeRetryPromptValue(prompt) === MAGIC_RETRY_PROMPT;
  }

  function captureDownloadTargetKeys() {
    return new Set(getDownloadButtons().map((button) => getDownloadTargetKey(button)).filter(Boolean));
  }

  async function runMagicRetry(originalPrompt) {
    const normalizedPrompt = String(originalPrompt ?? "").trim();
    if (normalizedPrompt.length === 0) {
      throw new Error("MAGIC_RETRY requires the original prompt.");
    }

    console.warn("[image-retry] MAGIC_RETRY: opening a new chat and resending the original prompt.");
    await openNewChat();
    const assistantTurnCount = getAssistantTurnElements().length;
    const previousButtons = captureDownloadTargetKeys();
    await sendMessage(normalizedPrompt, undefined, undefined, IMAGE_DOWNLOAD_TIMEOUT_SECONDS);

    return {
      assistantTurnCount,
      previousButtons
    };
  }

  function normalizeRetryPrompts(retryPrompts) {
    const sourcePrompts = Array.isArray(retryPrompts)
      ? retryPrompts
      : typeof retryPrompts === "string"
        ? [retryPrompts]
        : DEFAULT_IMAGE_RETRY_PROMPTS;
    const normalizedPrompts = sourcePrompts
      .map((prompt) => normalizeRetryPromptValue(prompt))
      .filter((prompt) => prompt.length > 0);

    return normalizedPrompts.length > 0 ? normalizedPrompts : DEFAULT_IMAGE_RETRY_PROMPTS;
  }

  function normalizeMessageBatch(msgs, separator, options) {
    let messages;
    if (Array.isArray(msgs)) {
      messages = msgs.map((msg) => String(msg));
    } else if (typeof msgs === "string") {
      messages = msgs.split(separator);
    } else {
      throw new Error("Expected msgs to be an array of strings or a string.");
    }

    if (!(options && options.skipWhitespaceOnlyMessages)) {
      return {
        messages,
        skippedCount: 0
      };
    }

    const filteredMessages = messages.filter((message) => message.trim().length > 0);
    return {
      messages: filteredMessages,
      skippedCount: messages.length - filteredMessages.length
    };
  }

  async function waitForDownloadButtonVisibleWithRetry(previousButtons, retryPrompts, options) {
    const retryPromptQueue = normalizeRetryPrompts(retryPrompts);
    let retryCount = 0;
    const waitOptions =
      options && typeof options === "object"
        ? options
        : {
            assistantTurnCount: 0
          };
    const originalPrompt =
      waitOptions && waitOptions.originalPrompt !== undefined && waitOptions.originalPrompt !== null
        ? String(waitOptions.originalPrompt)
        : "";
    const sharedWaitOptions = waitOptions;
    sharedWaitOptions.onLimitRecovered = async () => runMagicRetry(originalPrompt);

    while (true) {
      try {
        return {
          buttons: await waitForDownloadButtonVisible(undefined, undefined, previousButtons, sharedWaitOptions),
          retryCount
        };
      } catch (error) {
        if (!isImageDownloadTimeoutError(error)) {
          throw error;
        }

        if (retryCount >= retryPromptQueue.length) {
          if (retryCount > 0) {
            console.error(
              `Timed out waiting for a generated image after ${retryCount} retry step${retryCount === 1 ? "" : "s"}.`
            );
          }
          throw error;
        }

        const retryStep = retryPromptQueue[retryCount];
        const nextRetryNumber = retryCount + 1;
        if (isMagicRetryPrompt(retryStep)) {
          console.warn(
            `Timed out waiting for a generated image. Running retry step ${nextRetryNumber}/${retryPromptQueue.length}: MAGIC_RETRY.`
          );
          const retryResult = await runMagicRetry(originalPrompt);
          previousButtons = retryResult.previousButtons;
          waitOptions.assistantTurnCount = retryResult.assistantTurnCount;
        } else {
          console.warn(
            `Timed out waiting for a generated image. Sending retry step ${nextRetryNumber}/${retryPromptQueue.length} and waiting for the composer to become sendable.`
          );
          await sendMessage(retryStep, undefined, undefined, IMAGE_DOWNLOAD_TIMEOUT_SECONDS);
          waitOptions.assistantTurnCount = getAssistantTurnElements().length;
        }
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

    console.log(`Found ${buttons.length} generated image(s). Downloading all.`);
    for (let index = 0; index < buttons.length; index++) {
      const button = buttons[index];
      console.log(`Downloading generated image ${index + 1}`);

      const filenameBase = filenameBaseBuilder ? filenameBaseBuilder(index, button) : null;
      const assetUrl = getGeneratedImageAssetUrl(button);
      if (!GENERATED_IMAGE_ASSET_URL_PATTERN.test(assetUrl)) {
        throw new Error(`Generated image asset URL not found for target ${index + 1}.`);
      }

      const response = await fetch(assetUrl, { credentials: "include" });
      if (!response.ok) {
        throw new Error(
          `Failed to fetch generated image ${index + 1}: ${response.status} ${response.statusText}`
        );
      }

      const blob = await response.blob();
      const contentDisposition = response.headers.get("content-disposition");
      const originalFilename = extractFilenameFromContentDisposition(contentDisposition);
      const extension =
        extractExtensionCandidate(originalFilename) ||
        contentTypeToExtension(response.headers.get("content-type")) ||
        contentTypeToExtension(blob.type) ||
        extractExtensionCandidate(assetUrl) ||
        DEFAULT_IMAGE_DOWNLOAD_EXTENSION;

      let filename;
      if (filenameBase !== null && filenameBase !== undefined && filenameBase !== "") {
        filename = `${sanitizeFilenameBase(removeExtensionCandidate(filenameBase), "download")}${extension}`;
      } else {
        const sanitizedOriginalFilename = sanitizeFilenameBase(originalFilename, "");
        if (sanitizedOriginalFilename.length > 0) {
          filename = extractExtensionCandidate(sanitizedOriginalFilename)
            ? sanitizedOriginalFilename
            : `${sanitizedOriginalFilename}${extension}`;
        } else {
          const altText = getGeneratedImageAltText(button).replace(GENERATED_IMAGE_ALT_PATTERN, "").trim();
          const fallbackBase = sanitizeFilenameBase(removeExtensionCandidate(altText), "generated_image");
          filename = `${fallbackBase}${extension}`;
        }
      }

      const objectUrl = URL.createObjectURL(blob);
      const link = document.createElement("a");
      link.href = objectUrl;
      link.download = filename;
      link.style.display = "none";
      document.body.appendChild(link);
      link.click();
      setTimeout(() => {
        URL.revokeObjectURL(objectUrl);
        link.remove();
      }, 0);
      console.log(`Downloaded "${filename}".`);

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
    const assistantTurnCount =
      options && Number.isFinite(options.assistantTurnCount) ? options.assistantTurnCount : 0;
    const originalPrompt =
      options && options.originalPrompt !== undefined && options.originalPrompt !== null
        ? String(options.originalPrompt)
        : "";

    if (useNewChat) {
      console.log("Waiting for generated image...");
      const waitResult = await waitForDownloadButtonVisibleWithRetry(previousButtons, undefined, {
        assistantTurnCount,
        originalPrompt
      });
      const newButtons = waitResult.buttons;
      const clickedCount = await clickDownloadButtons(newButtons, undefined, {
        filenameBaseBuilder
      });
      const retrySuffix =
        waitResult.retryCount > 0
          ? ` after ${waitResult.retryCount} retry step${waitResult.retryCount === 1 ? "" : "s"}`
          : "";
      console.log(
        `Image downloaded${retrySuffix} (${progressCurrent}/${progressTotal}) via ${clickedCount} download(s).`
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
      const previousButtons = useNewChat
        ? new Set(getDownloadButtons().map((button) => getDownloadTargetKey(button)).filter(Boolean))
        : undefined;
      const previousAssistantTurnCount = useNewChat ? getAssistantTurnElements().length : 0;
      await sendMessage(msg);
      console.log(`Message sent (${i + 1}/${count}).`);
      await handlePostSend(i, count, sleepDuration, sleepSeconds, useNewChat, previousButtons, {
        assistantTurnCount: previousAssistantTurnCount,
        originalPrompt: msg
      });
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

    const { messages, skippedCount } = normalizeMessageBatch(msgs, separator, options);
    if (skippedCount > 0) {
      console.log(
        `Skipped ${skippedCount} whitespace-only prompt${skippedCount === 1 ? "" : "s"} while loading.`
      );
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
      const previousButtons = useNewChat
        ? new Set(getDownloadButtons().map((button) => getDownloadTargetKey(button)).filter(Boolean))
        : undefined;
      const previousAssistantTurnCount = useNewChat ? getAssistantTurnElements().length : 0;
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
            assistantTurnCount: previousAssistantTurnCount,
            originalPrompt: fullPrompt,
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
          `Timed out waiting for a generated image (${absoluteIndex}/${lastIndex}). ` +
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
      continueOnImageDownloadTimeout: sendMode === SEND_MODES.NEW_CHAT_IMAGE,
      skipWhitespaceOnlyMessages: true
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
  window.waitForImageGenerationLimitReset = waitForImageGenerationLimitReset;
  window.MAGIC_RETRY = MAGIC_RETRY_PROMPT;

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
