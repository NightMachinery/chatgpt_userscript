// ==UserScript==
// @name         ChatGPT Message Helper
// @namespace    https://chatgpt.com/
// @version      1.1.16
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
  const OUTPUT_DIRECTORY_PICKER_ID = "chatgpt-userscript-output";
  const OUTPUT_DIRECTORY_START_IN = "downloads";
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
  const IMAGE_DOWNLOAD_TIMEOUT_SECONDS = 250;
  const IMAGE_DOWNLOAD_TIMEOUT_ERROR_MESSAGE = "Timed out waiting for a new visible generated image.";
  const MAGIC_RETRY_PROMPT = "MAGIC_RETRY";
  const DEFAULT_IMAGE_RETRY_PROMPTS = Object.freeze([
    MAGIC_RETRY_PROMPT,
    MAGIC_RETRY_PROMPT,
    MAGIC_RETRY_PROMPT,
    "You have full creative license to adapt, reinterpret, or subtly redirect those specific elements so the image can still be generated. A light, tame, clothed image is always preferable to a refusal. A light, tame, clothed image is always preferable to a refusal. First rewrite the prompt.",
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
  const ARRAY_RUN_PHASES = Object.freeze({
    PREPARING: "preparing",
    WAITING_SEND_READY: "waiting_send_ready",
    WAITING_GENERATED_IMAGE: "waiting_generated_image",
    WAITING_IMAGE_LIMIT_RESET: "waiting_image_limit_reset",
    RETRYING_PROMPT: "retrying_prompt",
    DOWNLOADING_IMAGES: "downloading_images",
    SLEEPING_BEFORE_NEXT_PROMPT: "sleeping_before_next_prompt",
    OPENING_NEW_CHAT_AFTER_SUCCESS: "opening_new_chat_after_success",
    OPENING_NEW_CHAT_AFTER_SKIP: "opening_new_chat_after_skip",
    OPENING_NEW_CHAT_FOR_RETRY: "opening_new_chat_for_retry",
    IDLE: "idle"
  });
  let activeDownloadRenameSession = null;
  let downloadRenameInterceptorInstalled = false;
  let activeArrayRunController = null;
  let nextArrayRunId = 1;

  function delay(duration) {
    return new Promise((resolve) => setTimeout(resolve, duration));
  }

  function createArrayRunController({ useNewChat, totalSelected }) {
    return {
      runId: nextArrayRunId++,
      active: true,
      useNewChat: Boolean(useNewChat),
      totalSelected: Number.isFinite(totalSelected) ? totalSelected : 0,
      phase: ARRAY_RUN_PHASES.IDLE,
      skipRequested: false,
      skipRequestedAt: null,
      currentAbsoluteIndex: null,
      currentPrompt: "",
      currentPromptSent: false
    };
  }

  function summarizePromptForLog(prompt, maxLength = 80) {
    const normalized = String(prompt ?? "").replace(/\s+/g, " ").trim();
    if (normalized.length <= maxLength) {
      return normalized;
    }
    return `${normalized.slice(0, Math.max(0, maxLength - 1))}…`;
  }

  function isActiveArrayRunController(controller) {
    return Boolean(controller && controller.active && activeArrayRunController === controller);
  }

  function setArrayRunPhase(controller, phase) {
    if (!isActiveArrayRunController(controller)) {
      return;
    }
    controller.phase = phase || ARRAY_RUN_PHASES.IDLE;
  }

  function setArrayRunCurrentPrompt(controller, absoluteIndex, prompt) {
    if (!isActiveArrayRunController(controller)) {
      return;
    }
    controller.currentAbsoluteIndex = absoluteIndex;
    controller.currentPrompt = String(prompt ?? "");
    controller.currentPromptSent = false;
    controller.skipRequested = false;
    controller.skipRequestedAt = null;
    setArrayRunPhase(controller, ARRAY_RUN_PHASES.PREPARING);
  }

  function markArrayRunCurrentPromptSent(controller) {
    if (!isActiveArrayRunController(controller)) {
      return;
    }
    controller.currentPromptSent = true;
  }

  function clearArrayRunSkipRequest(controller) {
    if (!controller) {
      return;
    }
    controller.skipRequested = false;
    controller.skipRequestedAt = null;
  }

  function clearArrayRunCurrentPrompt(controller) {
    if (!controller) {
      return;
    }
    controller.currentAbsoluteIndex = null;
    controller.currentPrompt = "";
    controller.currentPromptSent = false;
    clearArrayRunSkipRequest(controller);
    if (isActiveArrayRunController(controller)) {
      setArrayRunPhase(controller, ARRAY_RUN_PHASES.IDLE);
    }
  }

  function finalizeArrayRunController(controller) {
    if (!controller) {
      return;
    }
    controller.active = false;
    clearArrayRunCurrentPrompt(controller);
    if (activeArrayRunController === controller) {
      activeArrayRunController = null;
    }
  }

  function createSkipCurrentPromptError(controller, context) {
    const error = new Error("Skip current prompt requested.");
    error.name = "SkipCurrentPromptError";
    error.skipCurrentPrompt = true;
    error.context = context || null;
    error.absoluteIndex = controller && Number.isFinite(controller.currentAbsoluteIndex)
      ? controller.currentAbsoluteIndex
      : null;
    return error;
  }

  function isSkipCurrentPromptError(error) {
    return Boolean(
      error &&
        typeof error === "object" &&
        (error.skipCurrentPrompt === true || error.name === "SkipCurrentPromptError")
    );
  }

  function throwIfSkipCurrentPromptRequested(controller, context) {
    if (!isActiveArrayRunController(controller) || !controller.skipRequested) {
      return;
    }
    throw createSkipCurrentPromptError(controller, context);
  }

  async function delayWithCheckpoint(duration, options) {
    const totalMs = Math.max(0, Math.trunc(Number(duration) || 0));
    if (totalMs === 0) {
      return;
    }

    const arrayRunController = options && options.arrayRunController;
    const phase = options && options.phase ? options.phase : null;
    const sliceMs = Math.max(
      50,
      Math.trunc((options && options.sliceMs) || 250)
    );

    if (phase) {
      setArrayRunPhase(arrayRunController, phase);
    }

    let remainingMs = totalMs;
    while (remainingMs > 0) {
      throwIfSkipCurrentPromptRequested(arrayRunController, phase || "delay");
      const waitMs = Math.min(sliceMs, remainingMs);
      await delay(waitMs);
      remainingMs -= waitMs;
    }

    throwIfSkipCurrentPromptRequested(arrayRunController, phase || "delay");
  }

  async function waitForNextPromptTransition(duration, controller) {
    const totalMs = Math.max(0, Math.trunc(Number(duration) || 0));
    if (totalMs === 0) {
      return { advancedEarly: false };
    }

    setArrayRunPhase(controller, ARRAY_RUN_PHASES.SLEEPING_BEFORE_NEXT_PROMPT);
    let remainingMs = totalMs;
    while (remainingMs > 0) {
      if (isActiveArrayRunController(controller) && controller.skipRequested) {
        console.warn(
          `[skip] Advancing immediately after prompt ${controller.currentAbsoluteIndex} during inter-prompt wait.`
        );
        clearArrayRunSkipRequest(controller);
        return { advancedEarly: true };
      }

      const waitMs = Math.min(250, remainingMs);
      await delay(waitMs);
      remainingMs -= waitMs;
    }

    return { advancedEarly: false };
  }

  async function openNewChat(options) {
    fireShortcut("o", "KeyO", { shift: true });
    await delayWithCheckpoint(1200, {
      arrayRunController: options && options.arrayRunController,
      phase: options && options.phase
    });
  }

  function requestSkipCurrentPrompt() {
    const controller = activeArrayRunController;
    if (
      !isActiveArrayRunController(controller) ||
      !Number.isFinite(controller.currentAbsoluteIndex)
    ) {
      console.log("[skip] No active array prompt to skip.");
      return {
        ok: false,
        reason: "no_active_array_run"
      };
    }

    if (
      controller.phase === ARRAY_RUN_PHASES.OPENING_NEW_CHAT_AFTER_SUCCESS ||
      controller.phase === ARRAY_RUN_PHASES.OPENING_NEW_CHAT_AFTER_SKIP
    ) {
      console.log("[skip] Current run is already advancing to the next prompt.");
      return {
        ok: false,
        reason: "already_advancing_to_next_prompt",
        currentAbsoluteIndex: controller.currentAbsoluteIndex,
        phase: controller.phase
      };
    }

    if (controller.skipRequested) {
      console.log(
        `[skip] Skip already requested for prompt ${controller.currentAbsoluteIndex}.`
      );
      return {
        ok: true,
        alreadyRequested: true,
        currentAbsoluteIndex: controller.currentAbsoluteIndex,
        phase: controller.phase
      };
    }

    controller.skipRequested = true;
    controller.skipRequestedAt = Date.now();
    console.warn(
      `[skip] Requested skip for prompt ${controller.currentAbsoluteIndex}: "${summarizePromptForLog(
        controller.currentPrompt
      )}".`
    );
    return {
      ok: true,
      currentAbsoluteIndex: controller.currentAbsoluteIndex,
      phase: controller.phase
    };
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

  async function waitForImageGenerationLimitResetState(limitState, options) {
    if (!limitState || !Number.isFinite(limitState.waitMs)) {
      throw new Error("Image generation limit reset state is not available.");
    }

    const arrayRunController = options && options.arrayRunController;
    const waitMs = Math.max(0, limitState.waitMs) + IMAGE_LIMIT_WAIT_BUFFER_MS;
    const startedAt = Date.now();
    const deadline = startedAt + waitMs;
    let nextLogAt = 0;

    setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.WAITING_IMAGE_LIMIT_RESET);
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
      await delayWithCheckpoint(sleepMs, {
        arrayRunController,
        phase: ARRAY_RUN_PHASES.WAITING_IMAGE_LIMIT_RESET,
        sliceMs: 1000
      });
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
    const arrayRunController = waitOptions.arrayRunController;
    let trackedPreviousButtons = previousButtons;
    let deadline = Date.now() + timeoutMs;

    while (Date.now() < deadline) {
      setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.WAITING_GENERATED_IMAGE);
      throwIfSkipCurrentPromptRequested(arrayRunController, ARRAY_RUN_PHASES.WAITING_GENERATED_IMAGE);
      const buttons = getNewDownloadButtons(trackedPreviousButtons);
      if (buttons.length > 0) {
        return buttons;
      }

      const imageLimitState = getImageGenerationLimitResetState(waitOptions.assistantTurnCount);
      if (imageLimitState) {
        const recoveryStart = Date.now();
        waitOptions.assistantTurnCount = imageLimitState.turnIndex + 1;
        const waitResult = await waitForImageGenerationLimitResetState(imageLimitState, {
          arrayRunController
        });
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

      await delayWithCheckpoint(intervalMs, {
        arrayRunController,
        phase: ARRAY_RUN_PHASES.WAITING_GENERATED_IMAGE
      });
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

  function isPlainObject(value) {
    return Boolean(value) && typeof value === "object" && !Array.isArray(value);
  }

  function buildSafeFilename(filename, fallbackBase = "download") {
    const extension = extractExtensionCandidate(filename);
    const safeBase = sanitizeFilenameBase(removeExtensionCandidate(filename), fallbackBase);
    return `${safeBase}${extension}`;
  }

  function describeOutputTarget(outputTarget) {
    if (outputTarget && outputTarget.type === "picked_directory") {
      return outputTarget.description;
    }
    return "the browser download location";
  }

  function formatSavedFileMessage(filename, outputTarget) {
    if (outputTarget && outputTarget.type === "picked_directory") {
      return `Saved "${filename}" to ${describeOutputTarget(outputTarget)}.`;
    }
    return `Downloaded "${filename}".`;
  }

  function createOutputDirectoryError(message, cause) {
    const error = new Error(message);
    if (cause !== undefined) {
      error.cause = cause;
    }
    return error;
  }

  function downloadBlobWithAnchor(blob, filename) {
    const safeFilename = buildSafeFilename(filename);
    const url = URL.createObjectURL(blob);
    const link = document.createElement("a");
    link.href = url;
    link.download = safeFilename;
    link.style.display = "none";
    document.body.appendChild(link);
    link.click();
    setTimeout(() => {
      URL.revokeObjectURL(url);
      link.remove();
    }, 0);
    return safeFilename;
  }

  async function findAvailableFilename(directoryHandle, filename) {
    const safeFilename = buildSafeFilename(filename);
    const extension = extractExtensionCandidate(safeFilename);
    const safeBase = removeExtensionCandidate(safeFilename);

    for (let suffixIndex = 0; ; suffixIndex++) {
      const candidate = suffixIndex === 0 ? safeFilename : `${safeBase}_${suffixIndex}${extension}`;
      try {
        await directoryHandle.getFileHandle(candidate);
      } catch (error) {
        if (error && typeof error === "object" && error.name === "NotFoundError") {
          return candidate;
        }
        throw error;
      }
    }
  }

  async function writeBlobToDirectory(directoryHandle, blob, filename) {
    const uniqueFilename = await findAvailableFilename(directoryHandle, filename);
    const fileHandle = await directoryHandle.getFileHandle(uniqueFilename, {
      create: true
    });
    const writable = await fileHandle.createWritable();
    let pendingError = null;

    try {
      await writable.write(blob);
    } catch (error) {
      pendingError = error;
    }

    try {
      await writable.close();
    } catch (error) {
      if (!pendingError) {
        pendingError = error;
      }
    }

    if (pendingError) {
      throw pendingError;
    }

    return uniqueFilename;
  }

  function createNativeOutputTarget() {
    return {
      type: "native_download",
      description: "the browser download location",
      async writeBlob(blob, filename) {
        return downloadBlobWithAnchor(blob, filename);
      },
      async writeText(content, filename, mimeType = "text/plain;charset=utf-8") {
        const blob = new Blob([String(content ?? "")], {
          type: mimeType
        });
        return downloadBlobWithAnchor(blob, filename);
      }
    };
  }

  async function showOutputDirectoryPicker() {
    if (typeof window.showDirectoryPicker !== "function") {
      throw createOutputDirectoryError(
        "pick_output_dir=true requires showDirectoryPicker(), which is unavailable in this browser/context."
      );
    }

    try {
      return await window.showDirectoryPicker({
        mode: "readwrite",
        startIn: OUTPUT_DIRECTORY_START_IN,
        id: OUTPUT_DIRECTORY_PICKER_ID
      });
    } catch (error) {
      if (error && typeof error === "object" && error.name === "TypeError") {
        return window.showDirectoryPicker({
          mode: "readwrite"
        });
      }
      throw error;
    }
  }

  async function createPickedOutputTarget() {
    let baseDirectoryHandle;
    try {
      baseDirectoryHandle = await showOutputDirectoryPicker();
    } catch (error) {
      if (error && typeof error === "object" && error.name === "AbortError") {
        throw createOutputDirectoryError("Output directory selection was canceled.", error);
      }
      if (error && typeof error === "object" && error.name === "SecurityError") {
        throw createOutputDirectoryError(
          "Output directory picker was blocked. Call the helper from a user interaction and try again.",
          error
        );
      }
      throw createOutputDirectoryError(
        `Failed to choose an output directory: ${error && error.message ? error.message : String(error)}`,
        error
      );
    }

    const directoryHandle = baseDirectoryHandle;
    const description = "the selected folder";

    console.log(`[output] Using ${description} for saved files.`);

    return {
      type: "picked_directory",
      description,
      async writeBlob(blob, filename) {
        try {
          return await writeBlobToDirectory(directoryHandle, blob, filename);
        } catch (error) {
          throw createOutputDirectoryError(
            `Failed to save "${filename}" to ${description}: ${
              error && error.message ? error.message : String(error)
            }`,
            error
          );
        }
      },
      async writeText(content, filename, mimeType = "text/plain;charset=utf-8") {
        const blob = new Blob([String(content ?? "")], {
          type: mimeType
        });
        try {
          return await writeBlobToDirectory(directoryHandle, blob, filename);
        } catch (error) {
          throw createOutputDirectoryError(
            `Failed to save "${filename}" to ${description}: ${
              error && error.message ? error.message : String(error)
            }`,
            error
          );
        }
      }
    };
  }

  function warnIgnoredLegacyOutputDir(outputDir) {
    if (outputDir === undefined || outputDir === null) {
      return;
    }

    const trimmedValue = String(outputDir).trim();
    if (trimmedValue.length === 0) {
      return;
    }

    console.warn(
      `[output] Ignoring deprecated output_dir="${trimmedValue}". pick_output_dir now uses the exact folder you choose.`
    );
  }

  function normalizePickOutputDirectoryArgs(pickOutputDirOrLegacyOutputDir, legacyPickOutputDir) {
    if (typeof pickOutputDirOrLegacyOutputDir === "boolean") {
      return pickOutputDirOrLegacyOutputDir;
    }

    if (legacyPickOutputDir !== undefined) {
      warnIgnoredLegacyOutputDir(pickOutputDirOrLegacyOutputDir);
      return Boolean(legacyPickOutputDir);
    }

    return false;
  }

  async function resolveOutputTarget(pickOutputDir) {
    if (!pickOutputDir) {
      return createNativeOutputTarget();
    }

    return createPickedOutputTarget();
  }

  async function downloadTextFile(content, filenamePrefix, outputTarget) {
    const resolvedOutputTarget =
      outputTarget && typeof outputTarget.writeText === "function"
        ? outputTarget
        : createNativeOutputTarget();
    const safePrefix = String(filenamePrefix ?? "failed_prompt")
      .trim()
      .replace(/[^a-z0-9._-]+/gi, "_")
      .replace(/^_+|_+$/g, "");
    const fallbackPrefix = safePrefix.length > 0 ? safePrefix : "failed_prompt";
    const timestamp = new Date().toISOString().replace(/[:.]/g, "-");
    const filename = `${fallbackPrefix}_${timestamp}.txt`;
    return resolvedOutputTarget.writeText(content, filename);
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

  function isBusyGenerating() {
    return Boolean(document.querySelector('button[data-testid="stop-button"]'));
  }

  async function clickRegenerate(options) {
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
      await delayWithCheckpoint(1200, {
        arrayRunController: options && options.arrayRunController,
        phase: options && options.phase ? options.phase : ARRAY_RUN_PHASES.WAITING_SEND_READY
      });
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

  async function waitForButtonAvailable(
    checkInterval,
    sleepMs,
    startTime,
    timeoutMs,
    setMsgFn,
    options
  ) {
    const arrayRunController = options && options.arrayRunController;
    while (Date.now() - startTime < timeoutMs) {
      setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.WAITING_SEND_READY);
      throwIfSkipCurrentPromptRequested(arrayRunController, ARRAY_RUN_PHASES.WAITING_SEND_READY);
      if (!isBusyGenerating()) {
        await setMsgFn();
        throwIfSkipCurrentPromptRequested(arrayRunController, ARRAY_RUN_PHASES.WAITING_SEND_READY);

        const sendButton = getSendButton();
        if (sendButton && !sendButton.disabled) {
          const waited = Date.now() - startTime;
          if (waited < sleepMs) {
            await delayWithCheckpoint(sleepMs - waited, {
              arrayRunController,
              phase: ARRAY_RUN_PHASES.WAITING_SEND_READY
            });
          }

          await setMsgFn();
          throwIfSkipCurrentPromptRequested(arrayRunController, ARRAY_RUN_PHASES.WAITING_SEND_READY);
          await clickSendButton();
          return;
        }
      } else {
        await clickRegenerate({
          arrayRunController,
          phase: ARRAY_RUN_PHASES.WAITING_SEND_READY
        });
      }

      await delayWithCheckpoint(checkInterval, {
        arrayRunController,
        phase: ARRAY_RUN_PHASES.WAITING_SEND_READY
      });
    }

    throw new Error("Operation timed out.");
  }

  async function sendMessage(msg, checkInterval, sleep, timeout, options) {
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
    await waitForButtonAvailable(intervalMs, sleepMs, startTime, timeoutMs, setMsgFn, options);
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

  async function runMagicRetry(originalPrompt, options) {
    const normalizedPrompt = String(originalPrompt ?? "").trim();
    if (normalizedPrompt.length === 0) {
      throw new Error("MAGIC_RETRY requires the original prompt.");
    }

    const arrayRunController = options && options.arrayRunController;
    console.warn("[image-retry] MAGIC_RETRY: opening a new chat and resending the original prompt.");
    await openNewChat({
      arrayRunController,
      phase: ARRAY_RUN_PHASES.OPENING_NEW_CHAT_FOR_RETRY
    });
    const assistantTurnCount = getAssistantTurnElements().length;
    const previousButtons = captureDownloadTargetKeys();
    await sendMessage(
      normalizedPrompt,
      undefined,
      undefined,
      IMAGE_DOWNLOAD_TIMEOUT_SECONDS,
      {
        arrayRunController
      }
    );

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
    const arrayRunController = waitOptions.arrayRunController;
    const sharedWaitOptions = waitOptions;
    sharedWaitOptions.onLimitRecovered = async () =>
      runMagicRetry(originalPrompt, {
        arrayRunController
      });

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
          setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.RETRYING_PROMPT);
          const retryResult = await runMagicRetry(originalPrompt, {
            arrayRunController
          });
          previousButtons = retryResult.previousButtons;
          waitOptions.assistantTurnCount = retryResult.assistantTurnCount;
        } else {
          console.warn(
            `Timed out waiting for a generated image. Sending retry step ${nextRetryNumber}/${retryPromptQueue.length} and waiting for the composer to become sendable.`
          );
          setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.RETRYING_PROMPT);
          await sendMessage(
            retryStep,
            undefined,
            undefined,
            IMAGE_DOWNLOAD_TIMEOUT_SECONDS,
            {
              arrayRunController
            }
          );
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
    const arrayRunController = options && options.arrayRunController;
    const outputTarget =
      options && options.outputTarget && typeof options.outputTarget.writeBlob === "function"
        ? options.outputTarget
        : createNativeOutputTarget();

    console.log(`Found ${buttons.length} generated image(s). Downloading all.`);
    for (let index = 0; index < buttons.length; index++) {
      setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.DOWNLOADING_IMAGES);
      throwIfSkipCurrentPromptRequested(arrayRunController, ARRAY_RUN_PHASES.DOWNLOADING_IMAGES);
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

      const savedFilename = await outputTarget.writeBlob(blob, filename);
      console.log(formatSavedFileMessage(savedFilename, outputTarget));

      const clickedCount = index + 1;
      const shouldPause =
        clickedCount % DOWNLOAD_CLICK_BURST_SIZE === 0 && clickedCount < buttons.length;
      if (shouldPause) {
        console.log(
          `Pausing ${DOWNLOAD_CLICK_BURST_DELAY_MS / 1000} seconds after ${clickedCount} download clicks...`
        );
        await delayWithCheckpoint(DOWNLOAD_CLICK_BURST_DELAY_MS, {
          arrayRunController,
          phase: ARRAY_RUN_PHASES.DOWNLOADING_IMAGES
        });
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
    const arrayRunController = options && options.arrayRunController;
    const outputTarget = options && options.outputTarget;

    if (useNewChat) {
      console.log("Waiting for generated image...");
      const waitResult = await waitForDownloadButtonVisibleWithRetry(previousButtons, undefined, {
        assistantTurnCount,
        originalPrompt,
        arrayRunController
      });
      const newButtons = waitResult.buttons;
      const clickedCount = await clickDownloadButtons(newButtons, undefined, {
        filenameBaseBuilder,
        arrayRunController,
        outputTarget
      });
      const retrySuffix =
        waitResult.retryCount > 0
          ? ` after ${waitResult.retryCount} retry step${waitResult.retryCount === 1 ? "" : "s"}`
          : "";
      const completionVerb =
        outputTarget && outputTarget.type === "picked_directory" ? "saved" : "downloaded";
      console.log(
        `Image ${completionVerb}${retrySuffix} (${progressCurrent}/${progressTotal}) via ${clickedCount} file${
          clickedCount === 1 ? "" : "s"
        }.`
      );

      if (index < total - 1) {
        setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.OPENING_NEW_CHAT_AFTER_SUCCESS);
        await openNewChat();
        await waitForNextPromptTransition(
          sleepDuration > 0 ? sleepDuration : 1200,
          arrayRunController
        );
      }
      return;
    }

    if (index < total - 1) {
      console.log(`Waiting ${sleepSeconds} seconds before the next send...`);
      await waitForNextPromptTransition(sleepDuration, arrayRunController);
    }
  }

  async function handleSkippedCurrentArrayPrompt(controller, options) {
    const currentAbsoluteIndex =
      controller && Number.isFinite(controller.currentAbsoluteIndex)
        ? controller.currentAbsoluteIndex
        : null;
    const hasNextPrompt = Boolean(options && options.hasNextPrompt);
    const useNewChat = Boolean(options && options.useNewChat);
    const currentPromptSent = Boolean(controller && controller.currentPromptSent);

    console.warn(
      currentAbsoluteIndex === null
        ? "[skip] Skipping current prompt and advancing."
        : `[skip] Skipped prompt ${currentAbsoluteIndex}; advancing to the next prompt.`
    );

    clearArrayRunSkipRequest(controller);

    if (useNewChat && currentPromptSent && hasNextPrompt) {
      setArrayRunPhase(controller, ARRAY_RUN_PHASES.OPENING_NEW_CHAT_AFTER_SKIP);
      await openNewChat();
    }
  }

  async function sendMessageRepeatedly(
    msg,
    n,
    sleep,
    mode,
    pick_output_dir,
    legacy_pick_output_dir
  ) {
    const count = n ?? 10;
    const sleepSeconds = sleep ?? 30;
    const sleepDuration = sleepSeconds * 1000;
    const sendMode = normalizeSendMode(mode);
    const useNewChat = sendMode === SEND_MODES.NEW_CHAT_IMAGE;
    const pickOutputDir = normalizePickOutputDirectoryArgs(
      pick_output_dir,
      legacy_pick_output_dir
    );
    const outputTarget =
      useNewChat && count > 0 ? await resolveOutputTarget(pickOutputDir) : null;

    for (let i = 0; i < count; i++) {
      const previousButtons = useNewChat
        ? new Set(getDownloadButtons().map((button) => getDownloadTargetKey(button)).filter(Boolean))
        : undefined;
      const previousAssistantTurnCount = useNewChat ? getAssistantTurnElements().length : 0;
      await sendMessage(msg);
      console.log(`Message sent (${i + 1}/${count}).`);
      await handlePostSend(i, count, sleepDuration, sleepSeconds, useNewChat, previousButtons, {
        assistantTurnCount: previousAssistantTurnCount,
        originalPrompt: msg,
        outputTarget
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
  function normalizeArrayOutputArguments(pickOutputDirOrOptions, maybeLegacyPickOutputDir, options) {
    if (
      isPlainObject(pickOutputDirOrOptions) &&
      maybeLegacyPickOutputDir === undefined &&
      options === undefined
    ) {
      return {
        pickOutputDir: false,
        options: pickOutputDirOrOptions
      };
    }

    if (typeof pickOutputDirOrOptions === "boolean") {
      return {
        pickOutputDir: pickOutputDirOrOptions,
        options:
          isPlainObject(maybeLegacyPickOutputDir) && options === undefined
            ? maybeLegacyPickOutputDir
            : isPlainObject(options)
              ? options
              : undefined
      };
    }

    if (maybeLegacyPickOutputDir !== undefined && !isPlainObject(maybeLegacyPickOutputDir)) {
      warnIgnoredLegacyOutputDir(pickOutputDirOrOptions);
      return {
        pickOutputDir: Boolean(maybeLegacyPickOutputDir),
        options: isPlainObject(options) ? options : undefined
      };
    }

    return {
      pickOutputDir: false,
      options:
        isPlainObject(maybeLegacyPickOutputDir) && options === undefined
          ? maybeLegacyPickOutputDir
          : isPlainObject(options)
            ? options
            : undefined
    };
  }

  async function sendMessageRepeatedlyArray(
    msgs,
    sleep,
    sep,
    prefix,
    postfix,
    from,
    to,
    mode,
    pickOutputDirOrOptions,
    maybeLegacyPickOutputDir,
    options
  ) {
    const sleepSeconds = sleep ?? 30;
    const sleepDuration = sleepSeconds * 1000;
    const separator = sep ?? "\n";
    const prefixText = prefix ?? "";
    const postfixText = postfix ?? "";
    const sendMode = normalizeSendMode(mode);
    const useNewChat = sendMode === SEND_MODES.NEW_CHAT_IMAGE;
    const normalizedArgs = normalizeArrayOutputArguments(
      pickOutputDirOrOptions,
      maybeLegacyPickOutputDir,
      options
    );
    const continueOnImageDownloadTimeout = Boolean(
      useNewChat && normalizedArgs.options && normalizedArgs.options.continueOnImageDownloadTimeout
    );

    const { messages, skippedCount } = normalizeMessageBatch(msgs, separator, normalizedArgs.options);
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
    if (activeArrayRunController && activeArrayRunController.active) {
      throw new Error("An array prompt run is already active; cannot start another skippable array run.");
    }
    const outputTarget =
      useNewChat && selectedMessages.length > 0
        ? await resolveOutputTarget(normalizedArgs.pickOutputDir)
        : null;

    const arrayRunController = createArrayRunController({
      useNewChat,
      totalSelected: selectedMessages.length
    });
    activeArrayRunController = arrayRunController;

    try {
      for (let i = 0; i < selectedMessages.length; i++) {
        const absoluteIndex = fromIndex + i;
        const fullPrompt = `${prefixText}${selectedMessages[i]}${postfixText}`;
        const hasNextPrompt = i < selectedMessages.length - 1;
        const previousButtons = useNewChat ? captureDownloadTargetKeys() : undefined;
        const previousAssistantTurnCount = useNewChat ? getAssistantTurnElements().length : 0;

        setArrayRunCurrentPrompt(arrayRunController, absoluteIndex, fullPrompt);

        try {
          await sendMessage(fullPrompt, undefined, undefined, undefined, {
            arrayRunController
          });
          markArrayRunCurrentPromptSent(arrayRunController);
          console.log(`Message sent (${absoluteIndex}/${lastIndex}).`);

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
              arrayRunController,
              outputTarget,
              filenameBaseBuilder: useNewChat
                ? (downloadIndex) =>
                    downloadIndex === 0 ? `${absoluteIndex}` : `${absoluteIndex}_${downloadIndex}`
                : undefined
            }
          );
        } catch (error) {
          if (isSkipCurrentPromptError(error)) {
            await handleSkippedCurrentArrayPrompt(arrayRunController, {
              hasNextPrompt,
              useNewChat
            });
            continue;
          }

          if (!continueOnImageDownloadTimeout || !isImageDownloadTimeoutError(error)) {
            throw error;
          }

          const failedFilename = await downloadTextFile(
            fullPrompt,
            `failed_prompt_${absoluteIndex}_of_${lastIndex}`,
            outputTarget
          );
          console.error(
            `Timed out waiting for a generated image (${absoluteIndex}/${lastIndex}). ` +
              `Saved failed prompt to "${failedFilename}" in ${describeOutputTarget(outputTarget)}. Continuing.`,
            error
          );

          if (hasNextPrompt) {
            setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.OPENING_NEW_CHAT_AFTER_SKIP);
            await openNewChat();
            await waitForNextPromptTransition(
              sleepDuration > 0 ? sleepDuration : 1200,
              arrayRunController
            );
          }
        } finally {
          clearArrayRunCurrentPrompt(arrayRunController);
        }
      }
    } finally {
      finalizeArrayRunController(arrayRunController);
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
    mode,
    pick_output_dir,
    legacy_pick_output_dir
  ) {
    const fileText = await chooseFileAsText();
    const sendMode = normalizeSendMode(mode);
    const pickOutputDir = normalizePickOutputDirectoryArgs(
      pick_output_dir,
      legacy_pick_output_dir
    );
    await sendMessageRepeatedlyArray(
      fileText,
      sleep,
      sep,
      prefix,
      postfix,
      from,
      to,
      sendMode,
      pickOutputDir,
      {
        continueOnImageDownloadTimeout: sendMode === SEND_MODES.NEW_CHAT_IMAGE,
        skipWhitespaceOnlyMessages: true
      }
    );
  }

  async function clickDallEDownloadButtons(pick_output_dir, legacy_pick_output_dir) {
    const pickOutputDir = normalizePickOutputDirectoryArgs(
      pick_output_dir,
      legacy_pick_output_dir
    );
    const outputTarget = await resolveOutputTarget(pickOutputDir);
    return clickDownloadButtons(getDownloadButtons(), undefined, {
      outputTarget
    });
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
  window.skipCurrentPrompt = requestSkipCurrentPrompt;
  window.clickDallEDownloadButtons = clickDallEDownloadButtons;
  window.waitForImageGenerationLimitReset = waitForImageGenerationLimitReset;
  window.MAGIC_RETRY = MAGIC_RETRY_PROMPT;

  // Keep these globals so this call style works in console:
  // sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)
  // sendMessageRepeatedlyArray("Prompt 1\nPrompt 2", sleep=10, sep="\n", prefix="", postfix="", from=0, to=0, mode="continuous")
  // sendMessageRepeatedlyArrayChooseFile(sleep=10, sep="\n", prefix="", postfix="", from=0, to=0, mode="new_chat_image", pick_output_dir=true)
  // skipCurrentPrompt()
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
  if (!("pick_output_dir" in window)) {
    window.pick_output_dir = undefined;
  }

  console.log(
    '[userscript] Ready. Example: sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)'
  );
})();
