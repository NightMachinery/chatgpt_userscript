// ==UserScript==
// @name         ChatGPT Message Helper
// @namespace    https://chatgpt.com/
// @version      1.1.52
// @description  Reliable message sending helpers for ChatGPT web UI changes.
// @match        https://chatgpt.com/*
// @grant        none
// ==/UserScript==

(function () {
  const USERSCRIPT_VERSION = "1.1.52";
  const IMAGE_DOWNLOAD_TIMEOUT_SECONDS = 500;
  const IMAGE_DOWNLOAD_TIMEOUT_ERROR_MESSAGE = "Timed out waiting for a new visible generated image.";
  const IMAGE_RETRY_BUTTON_COUNT = 3;
  const IMAGE_RETRY_PROMPT_SEND_SLEEP_MS = 10000;
  const ENABLE_IMAGE_REFUSAL_FAST_RETRY = true;
  const IMAGE_POST_DETECTION_SETTLE_MS = 90000;
  const GENERATED_IMAGE_TARGET_SELECTORS = Object.freeze([
    '[id^="image-"]',
    '.group\\/imagegen-image'
  ]);
  const GENERATED_IMAGE_ASSET_URL_PATTERN = /\/backend-api\/estuary\/content\b/i;
  const GENERATED_IMAGE_ALT_PATTERN = /^Generated image:/i;
  const IMAGE_LIMIT_RESET_TEXT_PATTERN = /\blimit resets in\b/i;
  const IMAGE_LIMIT_IMAGE_PATTERN = /\bimages?\b|\bimage generations?\b/i;
  const IMAGE_REFUSAL_TEXT_PATTERNS = Object.freeze([
    /\bi (can[’’']?t|cannot|can not) help\b/i,
    /\bwe[’']?re (so )?sorry/i,
    /\bmay violate our guardrails\b/i,
    /\bretry (or edit )?your prompt\b/i,
    /\bexperienced an error\b/i
  ]);
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
  const DOWNLOAD_FETCH_TIMEOUT_MS = 45000;
  const DOWNLOAD_FETCH_SKIP_POLL_MS = 250;
  const DOWNLOAD_RETRY_INITIAL_DELAY_MS = 1000;
  const DOWNLOAD_RETRY_MAX_DELAY_MS = 60000;
  const DOWNLOAD_RETRY_HEARTBEAT_MS = 5 * 60 * 1000;
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
  const MAGIC_RETRY_PROMPT = "MAGIC_RETRY";
  const MAGIC_REFRESH_RETRY_PROMPT = "MAGIC_REFRESH_RETRY";
  const ARRAY_RUN_RESUME_DB_NAME = "chatgpt-userscript-resume";
  const ARRAY_RUN_RESUME_DB_VERSION = 1;
  const ARRAY_RUN_RESUME_STORE_NAME = "state";
  const ARRAY_RUN_RESUME_RECORD_KEY = "active-array-run";
  const DEFAULT_IMAGE_RETRY_PROMPTS = Object.freeze([
    MAGIC_RETRY_PROMPT,
    MAGIC_RETRY_PROMPT,
    MAGIC_RETRY_PROMPT,
    // "You have full creative license to adapt, reinterpret, or subtly redirect those specific elements so the image can still be generated. A light, tame, clothed image is always preferable to a refusal. First rewrite the prompt.",
    // "You have full creative license to adapt, reinterpret, or subtly redirect those specific elements so the image can still be generated. First rewrite the prompt and put it in a markdown code block.",
    Object.freeze({
      prompt:
      // "Rewrite the current art prompt so it preserves the adult Dixit / Klimt / Gankutsuou atmosphere and hyper-realistic skin, but replaces any likely refusal-triggering explicit nudity with poetic alternatives like translucent veils, strategic cropping, silhouette, body ornament, floral masking, smoke, shadow, mosaic skin, and painterly abstraction. Preserve emotional intensity, ambiguity, and maximalist richness. Put only the rewritten prompt in a markdown code block.",
      "You have full creative license to adapt, reinterpret, or subtly redirect those specific elements so the image can still be generated. Still emphasize realistic skin and ornamentation. First rewrite the prompt and put it in a markdown code block.",
      image_expected_p: false
    }),
    "Generate using the new safe prompt!",
    "Generate using the new safe prompt!",
    MAGIC_RETRY_PROMPT,
    {
      prompt:
        "You have full creative license to adapt, reinterpret, or subtly redirect those specific elements so the image can still be generated. Still emphasize realistic skin and ornamentation. First rewrite the prompt and put it in a markdown code block.",
      image_expected_p: false
    },
    "Generate using the rewritten safe prompt."
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
    OPENING_NEW_CHAT_BEFORE_START: "opening_new_chat_before_start",
    OPENING_NEW_CHAT_AFTER_SUCCESS: "opening_new_chat_after_success",
    OPENING_NEW_CHAT_AFTER_SKIP: "opening_new_chat_after_skip",
    OPENING_NEW_CHAT_FOR_RETRY: "opening_new_chat_for_retry",
    IDLE: "idle"
  });
  const UI_RECOVERY_HEARTBEAT_MS = 60 * 1000;
  const UI_RECOVERY_POLL_MS = 250;
  const UI_RECOVERY_ACTION_SETTLE_MS = 1200;
  const NEW_CHAT_RECOVERY_TIMEOUT_MS = 60000;
  const NEW_CHAT_POST_OPEN_VERIFICATION_DELAY_MS = 3000;
  const SAFE_DIALOG_CONFIRM_LABEL_PATTERNS = Object.freeze([
    /^leave$/i,
    /^discard$/i,
    /^discard changes$/i,
    /^leave without saving$/i,
    /^continue without saving$/i,
    /^start new chat$/i
  ]);
  const SAFE_DIALOG_DISMISS_LABEL_PATTERNS = Object.freeze([
    /^cancel$/i,
    /^close$/i,
    /^dismiss$/i,
    /^not now$/i,
    /^stay$/i,
    /^keep editing$/i,
    /^go back$/i
  ]);
  let activeDownloadRenameSession = null;
  let downloadRenameInterceptorInstalled = false;
  let activeArrayRunController = null;
  let nextArrayRunId = 1;
  let arrayRunAutoResumeStarted = false;

  function openArrayRunResumeDb() {
    return new Promise((resolve, reject) => {
      if (!window.indexedDB) {
        reject(new Error("IndexedDB is not available in this browser context."));
        return;
      }

      const request = window.indexedDB.open(ARRAY_RUN_RESUME_DB_NAME, ARRAY_RUN_RESUME_DB_VERSION);
      request.onupgradeneeded = () => {
        const db = request.result;
        if (!db.objectStoreNames.contains(ARRAY_RUN_RESUME_STORE_NAME)) {
          db.createObjectStore(ARRAY_RUN_RESUME_STORE_NAME);
        }
      };
      request.onsuccess = () => resolve(request.result);
      request.onerror = () => reject(request.error || new Error("Failed to open resume IndexedDB."));
    });
  }

  async function readArrayRunResumeRecord() {
    try {
      const db = await openArrayRunResumeDb();
      return await new Promise((resolve, reject) => {
        const transaction = db.transaction(ARRAY_RUN_RESUME_STORE_NAME, "readonly");
        const request = transaction.objectStore(ARRAY_RUN_RESUME_STORE_NAME).get(ARRAY_RUN_RESUME_RECORD_KEY);
        request.onsuccess = () => resolve(request.result || null);
        request.onerror = () => {
          db.close();
          reject(request.error || new Error("Failed to read resume state."));
        };
        transaction.oncomplete = () => db.close();
        transaction.onerror = () => db.close();
      });
    } catch (error) {
      console.warn(`[resume] Failed to read resume state: ${formatErrorForLog(error)}`, error);
      return null;
    }
  }

  async function writeArrayRunResumeRecord(record) {
    const safeRecord = {
      ...(record || {}),
      schemaVersion: 1,
      userscriptVersion: USERSCRIPT_VERSION,
      updatedAt: Date.now()
    };
    const db = await openArrayRunResumeDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(ARRAY_RUN_RESUME_STORE_NAME, "readwrite");
      try {
        transaction.objectStore(ARRAY_RUN_RESUME_STORE_NAME).put(safeRecord, ARRAY_RUN_RESUME_RECORD_KEY);
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error("Failed to write resume state."));
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error || new Error("Resume state write aborted."));
      };
    });
    return safeRecord;
  }

  async function deleteArrayRunResumeRecord() {
    const db = await openArrayRunResumeDb();
    await new Promise((resolve, reject) => {
      const transaction = db.transaction(ARRAY_RUN_RESUME_STORE_NAME, "readwrite");
      try {
        transaction.objectStore(ARRAY_RUN_RESUME_STORE_NAME).delete(ARRAY_RUN_RESUME_RECORD_KEY);
      } catch (error) {
        db.close();
        reject(error);
        return;
      }
      transaction.oncomplete = () => {
        db.close();
        resolve();
      };
      transaction.onerror = () => {
        db.close();
        reject(transaction.error || new Error("Failed to clear resume state."));
      };
      transaction.onabort = () => {
        db.close();
        reject(transaction.error || new Error("Resume state clear aborted."));
      };
    });
  }

  async function discardArrayRunResumeRecord() {
    try {
      await deleteArrayRunResumeRecord();
    } catch (error) {
      console.warn(`[resume] Failed to clear saved resume state: ${formatErrorForLog(error)}`, error);
    }
  }

  function getMonotonicNowMs() {
    if (
      window.performance &&
      typeof window.performance.now === "function"
    ) {
      return window.performance.now();
    }
    return Date.now();
  }

  function sleepTimer(ms) {
    return new Promise((resolve) => window.setTimeout(resolve, ms));
  }

  function createArrayRunController({ useNewChat, totalSelected }) {
    return {
      runId: nextArrayRunId++,
      active: true,
      useNewChat: Boolean(useNewChat),
      totalSelected: Number.isFinite(totalSelected) ? totalSelected : 0,
      resumeRecord: null,
      selectedEntryIndex: 0,
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

  async function sleepForMs(duration, options) {
    const totalMs = Math.max(0, Math.trunc(Number(duration) || 0));
    if (totalMs === 0) {
      return;
    }

    const arrayRunController = options && options.arrayRunController;
    const phase = options && options.phase ? options.phase : null;
    const onCheckpoint =
      options && typeof options.onCheckpoint === "function" ? options.onCheckpoint : null;
    const skipCheckEnabled = !options || options.skipCheck !== false;
    const sliceMs = Math.max(
      50,
      Math.trunc((options && options.sliceMs) || 250)
    );

    if (phase) {
      setArrayRunPhase(arrayRunController, phase);
    }

    if (!onCheckpoint && !isActiveArrayRunController(arrayRunController)) {
      await sleepTimer(totalMs);
      return;
    }

    const startedAt = getMonotonicNowMs();
    const deadline = startedAt + totalMs;

    while (true) {
      const now = getMonotonicNowMs();
      const remainingMs = deadline - now;
      if (remainingMs <= 0) {
        break;
      }

      if (onCheckpoint) {
        const checkpointResult = await onCheckpoint({
          elapsedMs: now - startedAt,
          remainingMs,
          totalMs,
          phase
        });
        if (checkpointResult && checkpointResult.done) {
          return checkpointResult.value;
        }
      }

      if (skipCheckEnabled) {
        throwIfSkipCurrentPromptRequested(arrayRunController, phase || "sleep");
      }

      const waitMs = Math.min(sliceMs, remainingMs);
      await sleepTimer(waitMs);
    }

    if (onCheckpoint) {
      const checkpointResult = await onCheckpoint({
        elapsedMs: totalMs,
        remainingMs: 0,
        totalMs,
        phase
      });
      if (checkpointResult && checkpointResult.done) {
        return checkpointResult.value;
      }
    }

    if (skipCheckEnabled) {
      throwIfSkipCurrentPromptRequested(arrayRunController, phase || "sleep");
    }
  }

  async function waitForNextPromptTransition(duration, controller) {
    const totalMs = Math.max(0, Math.trunc(Number(duration) || 0));
    if (totalMs === 0) {
      return { advancedEarly: false };
    }

    const result = await sleepForMs(totalMs, {
      arrayRunController: controller,
      phase: ARRAY_RUN_PHASES.SLEEPING_BEFORE_NEXT_PROMPT,
      skipCheck: false,
      onCheckpoint: () => {
        if (isActiveArrayRunController(controller) && controller.skipRequested) {
          console.warn(
            `[skip] Advancing immediately after prompt ${controller.currentAbsoluteIndex} during inter-prompt wait.`
          );
          clearArrayRunSkipRequest(controller);
          return {
            done: true,
            value: { advancedEarly: true }
          };
        }
        return null;
      }
    });

    return result || { advancedEarly: false };
  }

  function collectElementsBySelectors(selectors, options) {
    const root =
      options && options.root && typeof options.root.querySelectorAll === "function"
        ? options.root
        : document;
    const includeHidden = Boolean(options && options.includeHidden);
    const candidates = [];
    const seen = new Set();
    for (const selector of selectors) {
      for (const element of root.querySelectorAll(selector)) {
        if (seen.has(element) || (!includeHidden && !isElementVisible(element))) {
          continue;
        }
        seen.add(element);
        candidates.push(element);
      }
    }
    return candidates;
  }

  function getCurrentPathname() {
    try {
      return new URL(window.location.href).pathname;
    } catch (_) {
      return String(window.location.pathname || "");
    }
  }

  function getElementActionLabel(element) {
    if (!(element instanceof Element)) {
      return "";
    }

    if (element instanceof HTMLInputElement) {
      const inputLabel = normalizeWhitespace(
        element.getAttribute("aria-label") || element.title || element.value || ""
      );
      if (inputLabel.length > 0) {
        return inputLabel;
      }
    }

    return normalizeWhitespace(
      element.getAttribute("aria-label") ||
        element.getAttribute("title") ||
        element.textContent ||
        ""
    );
  }

  function getElementTextForDiagnostic(element) {
    if (!(element instanceof Element)) {
      return "";
    }
    return normalizeWhitespace(element.textContent || "");
  }

  function getVisibleDialogElements() {
    return collectElementsBySelectors(
      [
        '[role="dialog"]',
        '[role="alertdialog"]',
        '[aria-modal="true"]'
      ],
      {
        includeHidden: false
      }
    );
  }

  function getDialogActionElements(dialog) {
    if (!(dialog instanceof Element)) {
      return [];
    }
    return collectElementsBySelectors(
      [
        "button",
        '[role="button"]',
        "a[href]",
        'input[type="button"]',
        'input[type="submit"]'
      ],
      {
        root: dialog,
        includeHidden: false
      }
    );
  }

  function findActionElementByLabel(elements, labelPatterns) {
    const patterns = Array.isArray(labelPatterns) ? labelPatterns : [];
    return elements.find((element) => {
      if (isElementDisabled(element)) {
        return false;
      }
      const label = getElementActionLabel(element);
      return label.length > 0 && patterns.some((pattern) => pattern.test(label));
    }) || null;
  }

  function getVisibleDialogSummaries() {
    return getVisibleDialogElements().map((dialog) => ({
      text: summarizePromptForLog(getElementTextForDiagnostic(dialog), 160),
      buttons: getDialogActionElements(dialog).map((element) => getElementActionLabel(element)).filter(Boolean)
    }));
  }

  async function resolveVisibleDialog(options) {
    const preferConfirmNavigation = Boolean(options && options.preferConfirmNavigation);
    const arrayRunController = options && options.arrayRunController;
    const phase = options && options.phase;
    const dialogs = getVisibleDialogElements();
    for (const dialog of dialogs) {
      const actions = getDialogActionElements(dialog);
      const prioritizedTargets = preferConfirmNavigation
        ? [
            {
              type: "confirm_navigation",
              target: findActionElementByLabel(actions, SAFE_DIALOG_CONFIRM_LABEL_PATTERNS)
            },
            {
              type: "dismiss",
              target: findActionElementByLabel(actions, SAFE_DIALOG_DISMISS_LABEL_PATTERNS)
            }
          ]
        : [
            {
              type: "dismiss",
              target: findActionElementByLabel(actions, SAFE_DIALOG_DISMISS_LABEL_PATTERNS)
            }
          ];

      for (const candidate of prioritizedTargets) {
        if (!(candidate.target instanceof Element)) {
          continue;
        }
        const label = getElementActionLabel(candidate.target);
        console.warn(`[ui-recovery] Clicking dialog action "${label}" (${candidate.type}).`);
        candidate.target.click();
        await sleepForMs(UI_RECOVERY_ACTION_SETTLE_MS, {
          arrayRunController,
          phase
        });
        return {
          handled: true,
          actionType: candidate.type,
          label,
          dialogText: summarizePromptForLog(getElementTextForDiagnostic(dialog), 160)
        };
      }
    }

    return {
      handled: false,
      dialogCount: dialogs.length
    };
  }

  function getConversationTurnElements(options) {
    return collectElementsBySelectors(
      [
        '#thread [data-testid^="conversation-turn-"]',
        '#thread [data-turn-id][data-turn]',
        '[data-testid^="conversation-turn-"]',
        '[data-turn-id][data-turn]'
      ],
      {
        includeHidden: Boolean(options && options.includeHidden)
      }
    );
  }

  function getVisibleConversationTurnElements() {
    return getConversationTurnElements({
      includeHidden: false
    });
  }

  function getUserTurnElements() {
    return collectElementsBySelectors(
      [
        '[data-message-author-role="user"]',
        '[data-turn="user"]'
      ],
      {
        includeHidden: true
      }
    );
  }

  function getAssistantTurnElements() {
    return collectElementsBySelectors(
      [
        '[data-message-author-role="assistant"]',
        '[data-turn="assistant"]'
      ],
      {
        includeHidden: true
      }
    );
  }

  function getPromptElement() {
    const selectors = [
      '#prompt-textarea[contenteditable="true"]',
      '[data-type="unified-composer"] [contenteditable="true"][role="textbox"]',
      'div#prompt-textarea',
      'textarea#prompt-textarea',
      'textarea[name="prompt-textarea"]'
    ];

    const candidates = collectElementsBySelectors(selectors, {
      includeHidden: true
    });

    return candidates.find((element) => isElementVisible(element)) || candidates[0] || null;
  }

  function getPromptText(prompt) {
    const target = prompt || getPromptElement();
    if (!target) {
      return "";
    }

    if (target instanceof HTMLTextAreaElement || target instanceof HTMLInputElement) {
      return String(target.value || "");
    }

    return String(target.textContent || "");
  }

  function getComposerContainer(prompt) {
    const target = prompt || getPromptElement();
    if (!(target instanceof Element)) {
      return null;
    }

    return (
      target.closest('[data-type="unified-composer"]') ||
      target.closest(".composer-parent") ||
      target.closest("form") ||
      target.parentElement
    );
  }

  function isPromptBlank(prompt) {
    return normalizeWhitespace(getPromptText(prompt)).length === 0;
  }

  function getStopButton() {
    const stopButtons = collectElementsBySelectors(
      [
        'button[data-testid="stop-button"]',
        'button[aria-label*="Stop" i]'
      ],
      {
        includeHidden: false
      }
    );
    return stopButtons[0] || null;
  }

  function getSendButton() {
    const prompt = getPromptElement();
    const composerContainer = getComposerContainer(prompt);
    const selectors = [
      'button[data-testid="send-button"]',
      'button[aria-label="Send prompt"]',
      'button[aria-label="Send"]',
      'button[aria-label*="Send" i]'
    ];

    const searchRoots = [composerContainer, document].filter(
      (root, index, roots) => root && roots.indexOf(root) === index
    );
    for (const root of searchRoots) {
      const candidates = collectElementsBySelectors(selectors, {
        root,
        includeHidden: false
      });
      if (candidates.length > 0) {
        return candidates[0];
      }
    }

    return (
      collectElementsBySelectors(["button"], {
        includeHidden: false
      }).find((button) => /^send$/i.test(getElementActionLabel(button))) || null
    );
  }

  function findNewChatControl() {
    const dedicatedCandidates = collectElementsBySelectors(
      [
        'button[aria-label*="new chat" i]',
        'a[aria-label*="new chat" i]',
        'button[data-testid*="new-chat" i]',
        'a[data-testid*="new-chat" i]'
      ],
      {
        includeHidden: false
      }
    );
    const dedicatedMatch = dedicatedCandidates.find((element) => /\bnew chat\b/i.test(getElementActionLabel(element)));
    if (dedicatedMatch) {
      return dedicatedMatch;
    }

    return (
      collectElementsBySelectors(
        [
          "button",
          "a[href]",
          '[role="button"]'
        ],
        {
          includeHidden: false
        }
      ).find((element) => /\bnew chat\b/i.test(getElementActionLabel(element))) || null
    );
  }

  function captureChatSurfaceState() {
    const prompt = getPromptElement();
    return {
      url: String(window.location.href || ""),
      path: getCurrentPathname(),
      conversationTurnCount: getConversationTurnElements({
        includeHidden: true
      }).length,
      visibleConversationTurnCount: getVisibleConversationTurnElements().length,
      assistantTurnCount: getAssistantTurnElements().length,
      userTurnCount: getUserTurnElements().length,
      promptVisible: Boolean(prompt && isElementVisible(prompt)),
      promptBlank: isPromptBlank(prompt),
      promptText: getPromptText(prompt)
    };
  }

  function isFreshChatReady(previousState) {
    const currentState = captureChatSurfaceState();
    if (!currentState.promptVisible || !currentState.promptBlank || isBusyGenerating()) {
      return false;
    }
    if (getVisibleDialogElements().length > 0) {
      return false;
    }

    if (currentState.visibleConversationTurnCount === 0) {
      return true;
    }

    return Boolean(
      previousState &&
      currentState.path !== previousState.path &&
      currentState.promptBlank &&
      currentState.visibleConversationTurnCount === 0
    );
  }

  async function verifyFreshChatReady(previousState, options) {
    if (!isFreshChatReady(previousState)) {
      return false;
    }

    const arrayRunController = options && options.arrayRunController;
    const phase = options && options.phase;
    await sleepForMs(NEW_CHAT_POST_OPEN_VERIFICATION_DELAY_MS, {
      arrayRunController,
      phase
    });

    const verifiedState = captureChatSurfaceState();
    if (verifiedState.visibleConversationTurnCount === 0 && isFreshChatReady(previousState)) {
      return true;
    }

    console.warn(
      `[new-chat] Fresh chat verification failed after ${formatDurationForLog(NEW_CHAT_POST_OPEN_VERIFICATION_DELAY_MS)}; visible old messages remain. Retrying.`,
      verifiedState
    );
    return false;
  }

  function buildUiRecoveryState(options) {
    const prompt = getPromptElement();
    const sendButton = getSendButton();
    const stopButton = getStopButton();
    const promptText = getPromptText(prompt);
    return {
      operation: options && options.operation ? options.operation : "",
      phase: options && options.phase ? options.phase : "",
      promptIndex:
        options && Number.isFinite(options.promptIndex) ? options.promptIndex : null,
      cycleCount:
        options && Number.isFinite(options.cycleCount) ? options.cycleCount : 0,
      url: String(window.location.href || ""),
      path: getCurrentPathname(),
      busyGenerating: Boolean(stopButton),
      stopButtonLabel: stopButton ? getElementActionLabel(stopButton) : "",
      promptFound: Boolean(prompt),
      promptTag: prompt ? prompt.tagName : "",
      promptVisible: Boolean(prompt && isElementVisible(prompt)),
      promptBlank: isPromptBlank(prompt),
      promptLength: promptText.length,
      promptPreview: summarizePromptForLog(promptText, 160),
      sendButtonFound: Boolean(sendButton),
      sendButtonVisible: Boolean(sendButton && isElementVisible(sendButton)),
      sendButtonDisabled: Boolean(sendButton && isElementDisabled(sendButton)),
      sendButtonLabel: sendButton ? getElementActionLabel(sendButton) : "",
      assistantTurnCount: getAssistantTurnElements().length,
      userTurnCount: getUserTurnElements().length,
      conversationTurnCount: getConversationTurnElements({
        includeHidden: true
      }).length,
      visibleConversationTurnCount: getVisibleConversationTurnElements().length,
      visibleDialogs: getVisibleDialogSummaries()
    };
  }

  function buildUiRecoveryDiagnosticContent(details) {
    const state = details && details.state ? details.state : {};
    const visibleDialogs = Array.isArray(state.visibleDialogs) ? state.visibleDialogs : [];
    const lines = [
      `timestamp: ${new Date().toISOString()}`,
      `operation: ${state.operation || ""}`,
      `phase: ${state.phase || ""}`,
      `prompt_index: ${state.promptIndex !== null && state.promptIndex !== undefined ? state.promptIndex : ""}`,
      `cycle_count: ${state.cycleCount || 0}`,
      `url: ${state.url || ""}`,
      `path: ${state.path || ""}`,
      `busy_generating: ${state.busyGenerating ? "true" : "false"}`,
      `stop_button_label: ${state.stopButtonLabel || ""}`,
      `prompt_found: ${state.promptFound ? "true" : "false"}`,
      `prompt_tag: ${state.promptTag || ""}`,
      `prompt_visible: ${state.promptVisible ? "true" : "false"}`,
      `prompt_blank: ${state.promptBlank ? "true" : "false"}`,
      `prompt_length: ${state.promptLength || 0}`,
      `prompt_preview: ${state.promptPreview || ""}`,
      `send_button_found: ${state.sendButtonFound ? "true" : "false"}`,
      `send_button_visible: ${state.sendButtonVisible ? "true" : "false"}`,
      `send_button_disabled: ${state.sendButtonDisabled ? "true" : "false"}`,
      `send_button_label: ${state.sendButtonLabel || ""}`,
      `assistant_turn_count: ${state.assistantTurnCount || 0}`,
      `user_turn_count: ${state.userTurnCount || 0}`,
      `conversation_turn_count: ${state.conversationTurnCount || 0}`,
      `visible_conversation_turn_count: ${state.visibleConversationTurnCount || 0}`,
      "visible_dialogs:"
    ];

    if (visibleDialogs.length === 0) {
      lines.push("(none)");
    } else {
      for (const dialog of visibleDialogs) {
        lines.push(`- text: ${dialog && dialog.text ? dialog.text : ""}`);
        lines.push(
          `  buttons: ${dialog && Array.isArray(dialog.buttons) && dialog.buttons.length > 0 ? dialog.buttons.join(" | ") : ""}`
        );
      }
    }

    if (details && details.promptText) {
      lines.push("");
      lines.push("prompt:");
      lines.push(details.promptText);
    }

    return lines.join("\n");
  }

  async function saveUiRecoveryDiagnostic(details) {
    try {
      const filename = await downloadTextFile(
        buildUiRecoveryDiagnosticContent(details),
        `ui_recovery_${details && details.operation ? details.operation : "unknown"}_${
          details && details.promptIndex !== null && details.promptIndex !== undefined ? details.promptIndex : "unknown"
        }`,
        details && details.outputTarget
      );
      console.warn(
        `[ui-recovery] Saved UI recovery diagnostic to "${filename}" in ${describeOutputTarget(details && details.outputTarget)}.`
      );
      return filename;
    } catch (error) {
      console.warn(
        `[ui-recovery] Failed to save UI recovery diagnostic: ${formatErrorForLog(error)}`,
        error
      );
      return null;
    }
  }

  async function recoverCurrentChatSendability(setMsgFn, options) {
    const arrayRunController = options && options.arrayRunController;
    const phase = options && options.phase ? options.phase : ARRAY_RUN_PHASES.WAITING_SEND_READY;
    const dialogResult = await resolveVisibleDialog({
      arrayRunController,
      phase,
      preferConfirmNavigation: false
    });
    if (dialogResult.handled) {
      return true;
    }

    if (isBusyGenerating()) {
      return false;
    }

    const activeElement = document.activeElement;
    if (
      activeElement instanceof HTMLElement &&
      activeElement !== document.body &&
      activeElement !== document.documentElement
    ) {
      try {
        activeElement.blur();
      } catch (_) {}
    }

    await sleepForMs(Math.max(UI_RECOVERY_POLL_MS, 100), {
      arrayRunController,
      phase
    });

    try {
      await setMsgFn();
      return true;
    } catch (error) {
      console.warn(`[ui-recovery] Failed to reapply prompt text: ${formatErrorForLog(error)}`);
      return false;
    }
  }

  async function openNewChat(options) {
    const arrayRunController = options && options.arrayRunController;
    const phase = options && options.phase;
    const outputTarget = options && options.outputTarget;
    const promptText =
      options && options.promptText !== undefined && options.promptText !== null
        ? String(options.promptText)
        : "";
    const promptIndex =
      options && Number.isFinite(options.promptIndex) ? options.promptIndex : null;
    const previousState = captureChatSurfaceState();
    if (
      await verifyFreshChatReady(previousState, {
        arrayRunController,
        phase
      })
    ) {
      return;
    }

    let recoveryCount = 0;
    let nextHeartbeatAt = Date.now() + UI_RECOVERY_HEARTBEAT_MS;
    let diagnosticSaved = false;

    while (true) {
      const cycleStartedAt = Date.now();
      while (Date.now() - cycleStartedAt < NEW_CHAT_RECOVERY_TIMEOUT_MS) {
        throwIfSkipCurrentPromptRequested(arrayRunController, phase || ARRAY_RUN_PHASES.OPENING_NEW_CHAT_FOR_RETRY);
        if (
          await verifyFreshChatReady(previousState, {
            arrayRunController,
            phase
          })
        ) {
          return;
        }

        const dialogResult = await resolveVisibleDialog({
          arrayRunController,
          phase,
          preferConfirmNavigation: true
        });
        if (dialogResult.handled) {
          if (
            await verifyFreshChatReady(previousState, {
              arrayRunController,
              phase
            })
          ) {
            return;
          }
          continue;
        }

        const newChatControl = findNewChatControl();
        if (newChatControl) {
          console.log(`[new-chat] Clicking visible control "${getElementActionLabel(newChatControl)}".`);
          newChatControl.click();
          await sleepForMs(UI_RECOVERY_ACTION_SETTLE_MS, {
            arrayRunController,
            phase
          });
          if (
            await verifyFreshChatReady(previousState, {
              arrayRunController,
              phase
            })
          ) {
            return;
          }
        }

        fireShortcut("o", "KeyO", { shift: true });
        await sleepForMs(UI_RECOVERY_ACTION_SETTLE_MS, {
          arrayRunController,
          phase
        });
        if (
          await verifyFreshChatReady(previousState, {
            arrayRunController,
            phase
          })
        ) {
          return;
        }

        if (Date.now() >= nextHeartbeatAt) {
          console.log("[new-chat] Still waiting for a fresh chat surface to become ready.");
          nextHeartbeatAt = Date.now() + UI_RECOVERY_HEARTBEAT_MS;
        }

        await sleepForMs(UI_RECOVERY_POLL_MS, {
          arrayRunController,
          phase
        });
      }

      recoveryCount += 1;
      const recoveryState = buildUiRecoveryState({
        operation: "open_new_chat",
        phase,
        promptIndex,
        cycleCount: recoveryCount
      });
      console.warn(
        `[new-chat] Fresh chat was not ready after ${formatDurationForLog(NEW_CHAT_RECOVERY_TIMEOUT_MS)}. ` +
          `Continuing recovery cycle ${recoveryCount}.`,
        recoveryState
      );
      if (!diagnosticSaved) {
        diagnosticSaved = Boolean(
          await saveUiRecoveryDiagnostic({
            operation: "open_new_chat",
            promptIndex,
            promptText,
            outputTarget,
            state: recoveryState
          })
        );
      }
    }
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

  function normalizeWhitespace(value) {
    return String(value ?? "")
      .replace(/\s+/g, " ")
      .trim();
  }

  function createImageDownloadTimeoutError() {
    return new Error(IMAGE_DOWNLOAD_TIMEOUT_ERROR_MESSAGE);
  }

  function createImageRefusalDetectedError(refusalState) {
    const error = new Error("Detected an image-generation refusal for the latest assistant response.");
    error.name = "ImageRefusalDetectedError";
    error.imageRefusalDetected = true;
    error.refusalState = refusalState || null;
    return error;
  }

  function isImageRefusalDetectedError(error) {
    return Boolean(
      error &&
        typeof error === "object" &&
        (error.imageRefusalDetected === true || error.name === "ImageRefusalDetectedError")
    );
  }

  function createImageGenerationFailedUiError(failureState) {
    const error = new Error('Detected latest assistant "Image generation failed" UI.');
    error.name = "ImageGenerationFailedUiError";
    error.imageGenerationFailedUi = true;
    error.failureState = failureState || null;
    return error;
  }

  function isImageGenerationFailedUiError(error) {
    return Boolean(
      error &&
        typeof error === "object" &&
        (error.imageGenerationFailedUi === true || error.name === "ImageGenerationFailedUiError")
    );
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

  function isComposerReadyForInput() {
    if (isBusyGenerating()) {
      return false;
    }
    if (getVisibleDialogElements().length > 0) {
      return false;
    }

    const prompt = getPromptElement();
    return Boolean(prompt instanceof Element && isElementVisible(prompt));
  }

  function matchesImageRefusalText(text) {
    const normalizedText = normalizeWhitespace(text);
    return IMAGE_REFUSAL_TEXT_PATTERNS.some((pattern) => pattern.test(normalizedText));
  }

  function getLatestAssistantMessageState(previousAssistantTurnCount = 0) {
    const assistantTurns = getAssistantTurnElements();
    const startIndex = Math.max(0, Math.trunc(Number(previousAssistantTurnCount) || 0));
    if (assistantTurns.length <= startIndex) {
      return {
        assistantTurnCount: assistantTurns.length,
        latestAssistantTurnIndex: null,
        latestAssistantText: "",
        latestAssistantTextMatchedImageRefusalPatterns: false,
        noAssistantMessageDetected: true
      };
    }

    const turnIndex = assistantTurns.length - 1;
    if (turnIndex < startIndex) {
      return {
        assistantTurnCount: assistantTurns.length,
        latestAssistantTurnIndex: null,
        latestAssistantText: "",
        latestAssistantTextMatchedImageRefusalPatterns: false,
        noAssistantMessageDetected: true
      };
    }

    const turn = assistantTurns[turnIndex];
    const text = normalizeWhitespace(turn.textContent || "");
    return {
      turn,
      assistantTurnCount: assistantTurns.length,
      latestAssistantTurnIndex: turnIndex,
      latestAssistantText: text,
      latestAssistantTextMatchedImageRefusalPatterns: text.length > 0 && matchesImageRefusalText(text),
      noAssistantMessageDetected: text.length === 0
    };
  }

  function logReadinessAssistantDebug(kind, options) {
    const details = options && typeof options === "object" ? options : {};
    const latestAssistant = getLatestAssistantMessageState(details.previousAssistantTurnCount);
    console.log(`[ready-debug] ${kind}`, {
      readinessKind: kind,
      operation: details.operation ? String(details.operation) : "",
      phase: details.phase ? String(details.phase) : "",
      promptIndex: Number.isFinite(details.promptIndex) ? details.promptIndex : null,
      url: String(window.location.href || ""),
      path: getCurrentPathname(),
      assistantTurnCount: latestAssistant.assistantTurnCount,
      latestAssistantTurnIndex: latestAssistant.latestAssistantTurnIndex,
      latestAssistantText: latestAssistant.latestAssistantText,
      latestAssistantTextMatchedImageRefusalPatterns:
        latestAssistant.latestAssistantTextMatchedImageRefusalPatterns,
      noAssistantMessageDetected: latestAssistant.noAssistantMessageDetected
    });
  }

  function getLatestImageRefusalState(previousAssistantTurnCount = 0) {
    if (!ENABLE_IMAGE_REFUSAL_FAST_RETRY || !isComposerReadyForInput()) {
      return null;
    }

    const latestAssistant = getLatestAssistantMessageState(previousAssistantTurnCount);
    if (!latestAssistant.turn) {
      return null;
    }

    const turn = latestAssistant.turn;
    const turnIndex = latestAssistant.latestAssistantTurnIndex;
    const text = latestAssistant.latestAssistantText;
    if (text.length === 0 || extractImageLimitWaitMs(text) !== null || !matchesImageRefusalText(text)) {
      return null;
    }

    return {
      turn,
      turnIndex,
      assistantTurnCount: latestAssistant.assistantTurnCount,
      text
    };
  }

  function getLatestImageGenerationFailedUiState(previousAssistantTurnCount = 0) {
    const latestAssistant = getLatestAssistantMessageState(previousAssistantTurnCount);
    if (!latestAssistant.turn) {
      return null;
    }

    const turn = latestAssistant.turn;
    const text = latestAssistant.latestAssistantText;
    if (!/\bimage generation failed\b/i.test(text)) {
      return null;
    }

    const tryAgainButton = Array.from(turn.querySelectorAll("button")).find((button) => {
      if (!isElementVisible(button) || isElementDisabled(button)) {
        return false;
      }

      const label = normalizeWhitespace(
        button.getAttribute("aria-label") || button.innerText || button.textContent || ""
      );
      return /^try again$/i.test(label);
    });
    if (!tryAgainButton) {
      return null;
    }

    return {
      turn,
      turnIndex: latestAssistant.latestAssistantTurnIndex,
      assistantTurnCount: latestAssistant.assistantTurnCount,
      text,
      button: tryAgainButton
    };
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
      await sleepForMs(sleepMs, {
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

  function isLikelyGeneratedImageElement(image, options) {
    const includeHidden = Boolean(options && options.includeHidden);
    if (!(image instanceof HTMLImageElement) || (!includeHidden && !isElementVisible(image))) {
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

  function getDownloadButtons(options) {
    const includeHidden = Boolean(options && options.includeHidden);
    const targets = [];
    const seenElements = new Set();

    for (const selector of GENERATED_IMAGE_TARGET_SELECTORS) {
      for (const target of document.querySelectorAll(selector)) {
        if (seenElements.has(target) || (!includeHidden && !isElementVisible(target))) {
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
      if (!isLikelyGeneratedImageElement(image, {
        includeHidden
      })) {
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
    let imageRetryButtonClickCount = 0;

    while (Date.now() < deadline) {
      setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.WAITING_GENERATED_IMAGE);
      throwIfSkipCurrentPromptRequested(arrayRunController, ARRAY_RUN_PHASES.WAITING_GENERATED_IMAGE);
      const buttons = getNewDownloadButtons(trackedPreviousButtons);
      if (buttons.length > 0) {
        console.log(
          `[image-detect] Found ${buttons.length} generated image${
            buttons.length === 1 ? "" : "s"
          }; waiting ${formatDurationForLog(IMAGE_POST_DETECTION_SETTLE_MS)} before downloading.`
        );
        await sleepForMs(IMAGE_POST_DETECTION_SETTLE_MS, {
          arrayRunController,
          phase: ARRAY_RUN_PHASES.WAITING_GENERATED_IMAGE
        });
        const settledButtons = getNewDownloadButtons(trackedPreviousButtons);
        const combinedButtons = [];
        const seenKeys = new Set();
        const seenElements = new Set();
        for (const candidate of [...buttons, ...settledButtons]) {
          if (!(candidate instanceof Element) || seenElements.has(candidate)) {
            continue;
          }
          const key = getDownloadTargetKey(candidate);
          if (key && seenKeys.has(key)) {
            continue;
          }
          seenElements.add(candidate);
          if (key) {
            seenKeys.add(key);
          }
          combinedButtons.push(candidate);
        }
        if (combinedButtons.length > buttons.length) {
          console.log(`[image-detect] Found ${combinedButtons.length} generated images after settle wait.`);
        }
        return combinedButtons;
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

      const refusalState = getLatestImageRefusalState(waitOptions.assistantTurnCount);
      if (refusalState) {
        throw createImageRefusalDetectedError(refusalState);
      }

      const imageGenerationFailedUiState = getLatestImageGenerationFailedUiState(
        waitOptions.assistantTurnCount
      );
      if (imageGenerationFailedUiState) {
        if (imageRetryButtonClickCount >= IMAGE_RETRY_BUTTON_COUNT) {
          throw createImageGenerationFailedUiError({
            ...imageGenerationFailedUiState,
            retryButtonClickCount: imageRetryButtonClickCount
          });
        }

        imageRetryButtonClickCount += 1;
        console.warn("[image-retry-ui] Detected latest assistant \"Image generation failed\" UI.", {
          retryButtonClickCount: imageRetryButtonClickCount,
          retryButtonCountLimit: IMAGE_RETRY_BUTTON_COUNT,
          assistantTurnCount: imageGenerationFailedUiState.assistantTurnCount,
          assistantTurnIndex: imageGenerationFailedUiState.turnIndex,
          assistantText: imageGenerationFailedUiState.text
        });
        console.warn(
          `[image-retry-ui] Clicking in-turn "Try again" button ` +
            `${imageRetryButtonClickCount}/${IMAGE_RETRY_BUTTON_COUNT}.`
        );
        imageGenerationFailedUiState.button.click();
        console.log(
          `[image-retry-ui] Clicked in-turn "Try again" button ` +
            `${imageRetryButtonClickCount}/${IMAGE_RETRY_BUTTON_COUNT}.`
        );
        await sleepForMs(UI_RECOVERY_ACTION_SETTLE_MS, {
          arrayRunController,
          phase: ARRAY_RUN_PHASES.WAITING_GENERATED_IMAGE
        });
        deadline = Date.now() + timeoutMs;
        continue;
      }

      await sleepForMs(intervalMs, {
        arrayRunController,
        phase: ARRAY_RUN_PHASES.WAITING_GENERATED_IMAGE
      });
    }

    throw createImageDownloadTimeoutError();
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

  function formatErrorForLog(error) {
    if (error instanceof Error) {
      return error.message || error.name || "Unknown error";
    }
    return String(error ?? "Unknown error");
  }

  function formatErrorForDiagnostic(error) {
    if (error instanceof Error) {
      return error.stack || `${error.name}: ${error.message}`;
    }

    try {
      return typeof error === "string" ? error : JSON.stringify(error, null, 2);
    } catch (_) {
      return String(error ?? "Unknown error");
    }
  }

  function getDownloadRetryDelayMs(retryCount) {
    const safeRetryCount = Math.max(1, Math.trunc(Number(retryCount) || 1));
    return Math.min(
      DOWNLOAD_RETRY_MAX_DELAY_MS,
      DOWNLOAD_RETRY_INITIAL_DELAY_MS * (2 ** Math.max(0, safeRetryCount - 1))
    );
  }

  function getGeneratedImageTargetLabel(downloadIndex) {
    return Number.isFinite(downloadIndex) ? `generated image ${downloadIndex + 1}` : "generated image";
  }

  function resolveGeneratedImageTargetForRetry(targetKey, fallbackTarget) {
    if (typeof targetKey === "string" && targetKey.length > 0) {
      const matchingTarget = getDownloadButtons({
        includeHidden: true
      }).find((candidate) => getDownloadTargetKey(candidate) === targetKey);
      if (matchingTarget) {
        return matchingTarget;
      }
    }

    if (fallbackTarget instanceof Element) {
      const assetUrl = getGeneratedImageAssetUrl(fallbackTarget);
      if (GENERATED_IMAGE_ASSET_URL_PATTERN.test(assetUrl)) {
        return fallbackTarget;
      }
    }

    return null;
  }

  function createGeneratedImageDownloadAttemptTimeoutError(assetUrl) {
    const error = new Error(
      `Timed out fetching generated image asset after ${Math.round(DOWNLOAD_FETCH_TIMEOUT_MS / 1000)} seconds: ${assetUrl}`
    );
    error.generatedImageDownloadAttemptTimeout = true;
    return error;
  }

  function buildSkippedDownloadDiagnosticContent(details) {
    const lines = [
      `timestamp: ${new Date().toISOString()}`,
      `prompt_index: ${details && details.promptIndex !== null ? details.promptIndex : ""}`,
      `image_index: ${details && details.downloadIndex !== null ? details.downloadIndex : ""}`,
      `retry_count: ${details && Number.isFinite(details.retryCount) ? details.retryCount : 0}`,
      `target_key: ${details && details.targetKey ? details.targetKey : ""}`,
      `last_asset_url: ${details && details.assetUrl ? details.assetUrl : ""}`,
      "last_error:",
      formatErrorForDiagnostic(details && details.lastError ? details.lastError : "No recorded error."),
      "",
      "prompt:",
      details && details.promptText ? details.promptText : ""
    ];
    return lines.join("\n");
  }

  async function saveSkippedDownloadDiagnostic(details) {
    try {
      const filename = await downloadTextFile(
        buildSkippedDownloadDiagnosticContent(details),
        `skipped_download_prompt_${details && details.promptIndex !== null ? details.promptIndex : "unknown"}_image_${details && details.downloadIndex !== null ? details.downloadIndex : "unknown"}`,
        details && details.outputTarget
      );
      console.warn(
        `[download-retry] Saved skip diagnostic to "${filename}" in ${describeOutputTarget(details && details.outputTarget)}.`
      );
      return filename;
    } catch (error) {
      console.warn(
        `[download-retry] Failed to save skip diagnostic: ${formatErrorForLog(error)}`,
        error
      );
      return null;
    }
  }

  async function fetchGeneratedImageBlobAttempt(assetUrl, options) {
    const arrayRunController = options && options.arrayRunController;
    const abortController = new AbortController();
    let abortReason = null;
    const abortFetch = (reason, error) => {
      if (abortReason !== null || abortController.signal.aborted) {
        return;
      }

      abortReason = {
        reason,
        error
      };

      try {
        abortController.abort(error);
      } catch (_) {
        abortController.abort();
      }
    };

    const timeoutId = window.setTimeout(() => {
      abortFetch("timeout", createGeneratedImageDownloadAttemptTimeoutError(assetUrl));
    }, DOWNLOAD_FETCH_TIMEOUT_MS);
    const skipIntervalId = isActiveArrayRunController(arrayRunController)
      ? window.setInterval(() => {
          if (arrayRunController.skipRequested) {
            abortFetch(
              "skip",
              createSkipCurrentPromptError(arrayRunController, ARRAY_RUN_PHASES.DOWNLOADING_IMAGES)
            );
          }
        }, DOWNLOAD_FETCH_SKIP_POLL_MS)
      : null;

    try {
      const response = await fetch(assetUrl, {
        credentials: "include",
        cache: "no-store",
        signal: abortController.signal
      });
      if (abortReason && abortReason.error) {
        throw abortReason.error;
      }
      if (!response.ok) {
        throw new Error(`Failed to fetch generated image asset: ${response.status} ${response.statusText}`);
      }

      const blob = await response.blob();
      if (abortReason && abortReason.error) {
        throw abortReason.error;
      }

      return {
        response,
        blob
      };
    } catch (error) {
      if (abortReason && abortReason.error) {
        throw abortReason.error;
      }

      if (error && typeof error === "object" && error.name === "AbortError" && abortReason && abortReason.error) {
        throw abortReason.error;
      }

      throw error;
    } finally {
      clearTimeout(timeoutId);
      if (skipIntervalId !== null) {
        clearInterval(skipIntervalId);
      }
    }
  }

  async function fetchGeneratedImageBlobWithRetry(target, options) {
    const arrayRunController = options && options.arrayRunController;
    const promptText =
      options && options.promptText !== undefined && options.promptText !== null
        ? String(options.promptText)
        : "";
    const promptIndex = options && Number.isFinite(options.promptIndex) ? options.promptIndex : null;
    const downloadIndex = options && Number.isFinite(options.downloadIndex) ? options.downloadIndex : null;
    const outputTarget = options && options.outputTarget;
    const targetLabel = getGeneratedImageTargetLabel(downloadIndex);
    const targetKey =
      options && typeof options.targetKey === "string" && options.targetKey.length > 0
        ? options.targetKey
        : getDownloadTargetKey(target);
    let resolvedTarget = target;
    let retryCount = 0;
    let attemptCount = 0;
    let lastError = null;
    let lastAssetUrl = getGeneratedImageAssetUrl(target);
    let nextHeartbeatAt = Date.now() + DOWNLOAD_RETRY_HEARTBEAT_MS;
    let skipDiagnosticSaved = false;

    const saveSkipDiagnosticOnce = async (error) => {
      if (skipDiagnosticSaved) {
        return;
      }
      skipDiagnosticSaved = true;
      await saveSkippedDownloadDiagnostic({
        promptText,
        promptIndex,
        downloadIndex,
        retryCount,
        targetKey,
        assetUrl: lastAssetUrl,
        lastError: error || lastError,
        outputTarget
      });
    };

    while (true) {
      try {
        throwIfSkipCurrentPromptRequested(arrayRunController, ARRAY_RUN_PHASES.DOWNLOADING_IMAGES);
        attemptCount += 1;
        resolvedTarget = resolveGeneratedImageTargetForRetry(targetKey, resolvedTarget || target);
        if (!resolvedTarget) {
          throw new Error(
            targetKey
              ? `Generated image target is not currently available for key "${targetKey}".`
              : "Generated image target is not currently available."
          );
        }

        const assetUrl = getGeneratedImageAssetUrl(resolvedTarget);
        if (!GENERATED_IMAGE_ASSET_URL_PATTERN.test(assetUrl)) {
          throw new Error(`Generated image asset URL not found for ${targetLabel}.`);
        }
        lastAssetUrl = assetUrl;

        const { response, blob } = await fetchGeneratedImageBlobAttempt(assetUrl, {
          arrayRunController
        });
        return {
          response,
          blob,
          assetUrl,
          retryCount,
          attemptCount,
          targetKey
        };
      } catch (error) {
        if (isSkipCurrentPromptError(error)) {
          await saveSkipDiagnosticOnce(error);
          throw error;
        }

        lastError = error;
        retryCount += 1;
        const delayMs = getDownloadRetryDelayMs(retryCount);
        console.warn(
          `[download-retry] ${targetLabel} fetch attempt ${attemptCount} failed: ${formatErrorForLog(error)}. ` +
            `Retrying in ${formatDurationForLog(delayMs)}.`
        );
        if (Date.now() >= nextHeartbeatAt) {
          console.log(
            `[download-retry] Still retrying ${targetLabel} after ${retryCount} failed attempt${retryCount === 1 ? "" : "s"}. ` +
              `Last asset URL: ${lastAssetUrl || "(missing)"}. Last error: ${formatErrorForLog(lastError)}.`
          );
          nextHeartbeatAt = Date.now() + DOWNLOAD_RETRY_HEARTBEAT_MS;
        }

        try {
          await sleepForMs(delayMs, {
            arrayRunController,
            phase: ARRAY_RUN_PHASES.DOWNLOADING_IMAGES
          });
        } catch (delayError) {
          if (isSkipCurrentPromptError(delayError)) {
            await saveSkipDiagnosticOnce(lastError || delayError);
          }
          throw delayError;
        }
      }
    }
  }

  function createOutputDirectoryError(message, cause) {
    const error = new Error(message);
    if (cause !== undefined) {
      error.cause = cause;
    }
    return error;
  }

  function createNamedError(name, message) {
    const error = new Error(message);
    error.name = name;
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

  function isOutputDirectoryUserActivationKnown() {
    return Boolean(
      typeof navigator !== "undefined" &&
        navigator &&
        navigator.userActivation &&
        typeof navigator.userActivation.isActive === "boolean"
    );
  }

  function isOutputDirectoryUserActivationActive() {
    return Boolean(
      typeof navigator !== "undefined" &&
        navigator &&
        navigator.userActivation &&
        navigator.userActivation.isActive === true
    );
  }

  function createOutputDirectoryActivationPrompt() {
    const overlay = document.createElement("div");
    overlay.setAttribute("role", "dialog");
    overlay.setAttribute("aria-modal", "true");
    overlay.style.position = "fixed";
    overlay.style.inset = "0";
    overlay.style.zIndex = "2147483647";
    overlay.style.display = "flex";
    overlay.style.alignItems = "center";
    overlay.style.justifyContent = "center";
    overlay.style.background = "rgba(0, 0, 0, 0.45)";
    overlay.style.fontFamily =
      'ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif';

    const panel = document.createElement("div");
    panel.style.maxWidth = "420px";
    panel.style.margin = "16px";
    panel.style.padding = "18px";
    panel.style.borderRadius = "14px";
    panel.style.boxShadow = "0 20px 60px rgba(0, 0, 0, 0.35)";
    panel.style.background = "#fff";
    panel.style.color = "#111827";

    const title = document.createElement("div");
    title.textContent = "Choose output folder";
    title.style.fontSize = "18px";
    title.style.fontWeight = "700";
    title.style.marginBottom = "8px";

    const message = document.createElement("div");
    message.textContent =
      "The browser requires a real click before opening the save-directory dialog. The helper is paused until you choose a folder.";
    message.style.fontSize = "14px";
    message.style.lineHeight = "1.45";
    message.style.marginBottom = "14px";

    const status = document.createElement("div");
    status.textContent = "";
    status.style.minHeight = "20px";
    status.style.fontSize = "13px";
    status.style.color = "#4b5563";
    status.style.marginBottom = "12px";

    const actions = document.createElement("div");
    actions.style.display = "flex";
    actions.style.gap = "8px";
    actions.style.justifyContent = "flex-end";

    const chooseButton = document.createElement("button");
    chooseButton.type = "button";
    chooseButton.textContent = "Choose output folder";
    chooseButton.style.border = "0";
    chooseButton.style.borderRadius = "10px";
    chooseButton.style.padding = "10px 14px";
    chooseButton.style.background = "#111827";
    chooseButton.style.color = "#fff";
    chooseButton.style.cursor = "pointer";
    chooseButton.style.fontWeight = "600";

    const cancelButton = document.createElement("button");
    cancelButton.type = "button";
    cancelButton.textContent = "Cancel";
    cancelButton.style.border = "1px solid #d1d5db";
    cancelButton.style.borderRadius = "10px";
    cancelButton.style.padding = "10px 14px";
    cancelButton.style.background = "#fff";
    cancelButton.style.color = "#111827";
    cancelButton.style.cursor = "pointer";

    actions.append(cancelButton, chooseButton);
    panel.append(title, message, status, actions);
    overlay.append(panel);

    return { overlay, chooseButton, cancelButton, status };
  }

  function waitForOutputDirectoryUserGesture() {
    return new Promise((resolve, reject) => {
      const prompt = createOutputDirectoryActivationPrompt();
      let settled = false;

      const cleanup = () => {
        prompt.chooseButton.removeEventListener("click", onChoose);
        prompt.cancelButton.removeEventListener("click", onCancel);
        prompt.overlay.remove();
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
        reject(error);
      };

      const onChoose = () => {
        prompt.chooseButton.disabled = true;
        prompt.cancelButton.disabled = true;
        prompt.chooseButton.style.cursor = "wait";
        prompt.cancelButton.style.cursor = "wait";
        prompt.status.textContent = "Opening browser folder picker...";

        const pickerPromise = showOutputDirectoryPicker();
        pickerPromise.then(settleResolve, settleReject);
      };

      const onCancel = () => {
        settleReject(
          createNamedError(
            "AbortError",
            "Output directory selection was canceled before opening the folder picker."
          )
        );
      };

      prompt.chooseButton.addEventListener("click", onChoose);
      prompt.cancelButton.addEventListener("click", onCancel);
      document.body.appendChild(prompt.overlay);
      prompt.chooseButton.focus();
    });
  }

  async function chooseOutputDirectoryHandle() {
    if (!isOutputDirectoryUserActivationKnown() || isOutputDirectoryUserActivationActive()) {
      try {
        return await showOutputDirectoryPicker();
      } catch (error) {
        if (!(error && typeof error === "object" && error.name === "SecurityError")) {
          throw error;
        }
      }
    }

    console.log(
      "[output] Waiting for a click to open the output directory picker; browser user activation is required."
    );
    return waitForOutputDirectoryUserGesture();
  }

  async function createPickedOutputTarget() {
    let baseDirectoryHandle;
    try {
      baseDirectoryHandle = await chooseOutputDirectoryHandle();
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
    return createPickedOutputTargetFromHandle(directoryHandle);
  }

  async function ensureDirectoryHandlePermission(directoryHandle) {
    if (
      !directoryHandle ||
      typeof directoryHandle.queryPermission !== "function" ||
      typeof directoryHandle.requestPermission !== "function"
    ) {
      return true;
    }

    const descriptor = { mode: "readwrite" };
    try {
      if ((await directoryHandle.queryPermission(descriptor)) === "granted") {
        return true;
      }
      return (await directoryHandle.requestPermission(descriptor)) === "granted";
    } catch (error) {
      console.warn(`[output] Failed to confirm picked-folder permission: ${formatErrorForLog(error)}`);
      return false;
    }
  }

  async function createPickedOutputTargetFromHandle(directoryHandle) {
    if (!(await ensureDirectoryHandlePermission(directoryHandle))) {
      throw createOutputDirectoryError("Picked output directory permission was not granted after reload.");
    }

    const description = "the selected folder";

    console.log(`[output] Using ${description} for saved files.`);

    return {
      type: "picked_directory",
      description,
      directoryHandle,
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
    return Boolean(getStopButton());
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
      await sleepForMs(1200, {
        arrayRunController: options && options.arrayRunController,
        phase: options && options.phase ? options.phase : ARRAY_RUN_PHASES.WAITING_SEND_READY
      });
    }
  }

  async function clickSendButton() {
    const sendButton = getSendButton();
    if (sendButton && !isElementDisabled(sendButton)) {
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
    const phase =
      options && options.phase ? options.phase : ARRAY_RUN_PHASES.WAITING_SEND_READY;
    const outputTarget = options && options.outputTarget;
    const promptText =
      options && options.promptText !== undefined && options.promptText !== null
        ? String(options.promptText)
        : "";
    const promptIndex =
      options && Number.isFinite(options.promptIndex) ? options.promptIndex : null;
    const operation =
      options && options.operationLabel ? String(options.operationLabel) : "send_message";
    const previousAssistantTurnCount =
      options && Number.isFinite(options.previousAssistantTurnCount)
        ? options.previousAssistantTurnCount
        : 0;
    const recoveryTimeoutMs = Math.min(timeoutMs, NEW_CHAT_RECOVERY_TIMEOUT_MS);
    let recoveryCount = 0;
    let cycleStartedAt = Date.now();
    let nextHeartbeatAt = Date.now() + UI_RECOVERY_HEARTBEAT_MS;
    let diagnosticSaved = false;

    while (true) {
      setArrayRunPhase(arrayRunController, phase);
      throwIfSkipCurrentPromptRequested(arrayRunController, phase);

      if (!isBusyGenerating()) {
        const dialogResult = await resolveVisibleDialog({
          arrayRunController,
          phase,
          preferConfirmNavigation: false
        });
        if (!dialogResult.handled) {
          await setMsgFn();
          throwIfSkipCurrentPromptRequested(arrayRunController, phase);

          const sendButton = getSendButton();
          if (sendButton && !isElementDisabled(sendButton)) {
            const waited = Date.now() - startTime;
            if (waited < sleepMs) {
              await sleepForMs(sleepMs - waited, {
                arrayRunController,
                phase
              });
            }

            await setMsgFn();
            throwIfSkipCurrentPromptRequested(arrayRunController, phase);
            logReadinessAssistantDebug("send_ready", {
              operation,
              phase,
              promptIndex,
              previousAssistantTurnCount
            });
            await clickSendButton();
            return;
          }
        }
      } else {
        await clickRegenerate({
          arrayRunController,
          phase
        });
      }

      if (Date.now() >= nextHeartbeatAt) {
        console.log(
          `[ui-recovery] Still waiting for send readiness (${operation}).`,
          buildUiRecoveryState({
            operation,
            phase,
            promptIndex,
            cycleCount: recoveryCount
          })
        );
        nextHeartbeatAt = Date.now() + UI_RECOVERY_HEARTBEAT_MS;
      }

      if (Date.now() - cycleStartedAt >= recoveryTimeoutMs) {
        recoveryCount += 1;
        const recoveryState = buildUiRecoveryState({
          operation,
          phase,
          promptIndex,
          cycleCount: recoveryCount
        });
        console.warn(
          `[ui-recovery] ${operation} timed out waiting for send readiness after ${formatDurationForLog(recoveryTimeoutMs)}. ` +
            `Continuing recovery cycle ${recoveryCount}.`,
          recoveryState
        );
        if (!diagnosticSaved) {
          diagnosticSaved = Boolean(
            await saveUiRecoveryDiagnostic({
              operation,
              promptIndex,
              promptText,
              outputTarget,
              state: recoveryState
            })
          );
        }
        await recoverCurrentChatSendability(setMsgFn, {
          arrayRunController,
          phase
        });
        cycleStartedAt = Date.now();
      }

      await sleepForMs(checkInterval, {
        arrayRunController,
        phase
      });
    }
  }

  async function waitForSendReady(
    checkInterval,
    timeout,
    options
  ) {
    const intervalMs = checkInterval ?? 100;
    const timeoutSeconds = timeout ?? 3600;
    const timeoutMs = timeoutSeconds * 1000;
    const arrayRunController = options && options.arrayRunController;
    const phase =
      options && options.phase ? options.phase : ARRAY_RUN_PHASES.WAITING_SEND_READY;
    const outputTarget = options && options.outputTarget;
    const promptText =
      options && options.promptText !== undefined && options.promptText !== null
        ? String(options.promptText)
        : "";
    const promptIndex =
      options && Number.isFinite(options.promptIndex) ? options.promptIndex : null;
    const operation =
      options && options.operationLabel ? String(options.operationLabel) : "wait_send_ready";
    const previousAssistantTurnCount =
      options && Number.isFinite(options.previousAssistantTurnCount)
        ? options.previousAssistantTurnCount
        : 0;
    const recoveryTimeoutMs = Math.min(timeoutMs, NEW_CHAT_RECOVERY_TIMEOUT_MS);
    const startTime = Date.now();
    let recoveryCount = 0;
    let cycleStartedAt = Date.now();
    let nextHeartbeatAt = Date.now() + UI_RECOVERY_HEARTBEAT_MS;
    let diagnosticSaved = false;

    while (true) {
      setArrayRunPhase(arrayRunController, phase);
      throwIfSkipCurrentPromptRequested(arrayRunController, phase);

      if (!isBusyGenerating()) {
        const dialogResult = await resolveVisibleDialog({
          arrayRunController,
          phase,
          preferConfirmNavigation: false
        });
        if (!dialogResult.handled) {
          const sendButton = getSendButton();
          if (sendButton && !isElementDisabled(sendButton)) {
            logReadinessAssistantDebug("send_ready", {
              operation,
              phase,
              promptIndex,
              previousAssistantTurnCount
            });
            return;
          }
        }
      }

      if (Date.now() >= startTime + timeoutMs) {
        throw new Error("Timed out waiting for the composer to become sendable.");
      }

      if (Date.now() >= nextHeartbeatAt) {
        console.log(
          `[ui-recovery] Still waiting for send readiness (${operation}).`,
          buildUiRecoveryState({
            operation,
            phase,
            promptIndex,
            cycleCount: recoveryCount
          })
        );
        nextHeartbeatAt = Date.now() + UI_RECOVERY_HEARTBEAT_MS;
      }

      if (Date.now() - cycleStartedAt >= recoveryTimeoutMs) {
        recoveryCount += 1;
        const recoveryState = buildUiRecoveryState({
          operation,
          phase,
          promptIndex,
          cycleCount: recoveryCount
        });
        console.warn(
          `[ui-recovery] ${operation} timed out waiting for send readiness after ${formatDurationForLog(recoveryTimeoutMs)}. ` +
            `Continuing recovery cycle ${recoveryCount}.`,
          recoveryState
        );
        if (!diagnosticSaved) {
          diagnosticSaved = Boolean(
            await saveUiRecoveryDiagnostic({
              operation,
              promptIndex,
              promptText,
              outputTarget,
              state: recoveryState
            })
          );
        }
        await recoverCurrentChatSendability(async () => {}, {
          arrayRunController,
          phase
        });
        cycleStartedAt = Date.now();
      }

      await sleepForMs(intervalMs, {
        arrayRunController,
        phase
      });
    }
  }

  async function waitForComposerReadyForInput(
    checkInterval,
    timeout,
    options
  ) {
    const intervalMs = checkInterval ?? 100;
    const timeoutSeconds = timeout ?? 3600;
    const timeoutMs = timeoutSeconds * 1000;
    const arrayRunController = options && options.arrayRunController;
    const phase =
      options && options.phase ? options.phase : ARRAY_RUN_PHASES.WAITING_SEND_READY;
    const outputTarget = options && options.outputTarget;
    const promptText =
      options && options.promptText !== undefined && options.promptText !== null
        ? String(options.promptText)
        : "";
    const promptIndex =
      options && Number.isFinite(options.promptIndex) ? options.promptIndex : null;
    const operation =
      options && options.operationLabel ? String(options.operationLabel) : "wait_composer_ready";
    const previousAssistantTurnCount =
      options && Number.isFinite(options.previousAssistantTurnCount)
        ? options.previousAssistantTurnCount
        : 0;
    const recoveryTimeoutMs = Math.min(timeoutMs, NEW_CHAT_RECOVERY_TIMEOUT_MS);
    const startTime = Date.now();
    let recoveryCount = 0;
    let cycleStartedAt = Date.now();
    let nextHeartbeatAt = Date.now() + UI_RECOVERY_HEARTBEAT_MS;
    let diagnosticSaved = false;

    while (true) {
      setArrayRunPhase(arrayRunController, phase);
      throwIfSkipCurrentPromptRequested(arrayRunController, phase);

      const dialogResult = await resolveVisibleDialog({
        arrayRunController,
        phase,
        preferConfirmNavigation: false
      });
      if (!dialogResult.handled && isComposerReadyForInput()) {
        logReadinessAssistantDebug("composer_ready", {
          operation,
          phase,
          promptIndex,
          previousAssistantTurnCount
        });
        return;
      }

      if (Date.now() >= startTime + timeoutMs) {
        throw new Error("Timed out waiting for the composer to become ready for input.");
      }

      if (Date.now() >= nextHeartbeatAt) {
        console.log(
          `[ui-recovery] Still waiting for composer readiness (${operation}).`,
          buildUiRecoveryState({
            operation,
            phase,
            promptIndex,
            cycleCount: recoveryCount
          })
        );
        nextHeartbeatAt = Date.now() + UI_RECOVERY_HEARTBEAT_MS;
      }

      if (Date.now() - cycleStartedAt >= recoveryTimeoutMs) {
        recoveryCount += 1;
        const recoveryState = buildUiRecoveryState({
          operation,
          phase,
          promptIndex,
          cycleCount: recoveryCount
        });
        console.warn(
          `[ui-recovery] ${operation} timed out waiting for composer readiness after ${formatDurationForLog(recoveryTimeoutMs)}. ` +
            `Continuing recovery cycle ${recoveryCount}.`,
          recoveryState
        );
        if (!diagnosticSaved) {
          diagnosticSaved = Boolean(
            await saveUiRecoveryDiagnostic({
              operation,
              promptIndex,
              promptText,
              outputTarget,
              state: recoveryState
            })
          );
        }
        await recoverCurrentChatSendability(async () => {}, {
          arrayRunController,
          phase
        });
        cycleStartedAt = Date.now();
      }

      await sleepForMs(intervalMs, {
        arrayRunController,
        phase
      });
    }
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

    if (/^magic(?:_|\s*)retry$/i.test(normalizedPrompt)) {
      return MAGIC_RETRY_PROMPT;
    }
    if (/^magic(?:_|\s*)refresh(?:_|\s*)retry$/i.test(normalizedPrompt)) {
      return MAGIC_REFRESH_RETRY_PROMPT;
    }
    return normalizedPrompt;
  }

  function normalizeRetryPromptStep(step) {
    if (typeof step === "string") {
      const normalizedPrompt = normalizeRetryPromptValue(step);
      if (normalizedPrompt.length === 0) {
        return null;
      }
      return {
        prompt: normalizedPrompt,
        image_expected_p: true
      };
    }

    if (!isPlainObject(step)) {
      return null;
    }

    const normalizedPrompt = normalizeRetryPromptValue(step.prompt);
    if (normalizedPrompt.length === 0) {
      return null;
    }

    return {
      prompt: normalizedPrompt,
      image_expected_p: step.image_expected_p !== false
    };
  }

  function isMagicRetryPrompt(prompt) {
    return normalizeRetryPromptValue(prompt) === MAGIC_RETRY_PROMPT;
  }

  function isMagicRefreshRetryPrompt(prompt) {
    return normalizeRetryPromptValue(prompt) === MAGIC_REFRESH_RETRY_PROMPT;
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
    const outputTarget = options && options.outputTarget;
    const promptIndex = options && Number.isFinite(options.promptIndex) ? options.promptIndex : null;
    console.warn("[image-retry] MAGIC_RETRY: opening a new chat and resending the original prompt.");
    await openNewChat({
      arrayRunController,
      phase: ARRAY_RUN_PHASES.OPENING_NEW_CHAT_FOR_RETRY,
      outputTarget,
      promptText: normalizedPrompt,
      promptIndex
    });
    const assistantTurnCount = getAssistantTurnElements().length;
    const previousButtons = captureDownloadTargetKeys();
    await sendMessage(
      normalizedPrompt,
      undefined,
      undefined,
      IMAGE_DOWNLOAD_TIMEOUT_SECONDS,
      {
        arrayRunController,
        outputTarget,
        promptText: normalizedPrompt,
        promptIndex,
        operationLabel: "magic_retry_send",
        previousAssistantTurnCount: assistantTurnCount
      }
    );

    return {
      assistantTurnCount,
      previousButtons
    };
  }

  async function runFreshChatLimitRecovery(prompt, options) {
    const normalizedPrompt = String(prompt ?? "").trim();
    if (normalizedPrompt.length === 0) {
      throw new Error("Image limit recovery requires a prompt to resend.");
    }

    const arrayRunController = options && options.arrayRunController;
    const outputTarget = options && options.outputTarget;
    const promptIndex = options && Number.isFinite(options.promptIndex) ? options.promptIndex : null;
    console.warn(
      "[image-limit] Limit wait finished without current-chat context dependency; opening a fresh chat and resending the active image prompt.",
      {
        promptIndex,
        prompt: summarizePromptForLog(normalizedPrompt)
      }
    );
    await openNewChat({
      arrayRunController,
      phase: ARRAY_RUN_PHASES.OPENING_NEW_CHAT_FOR_RETRY,
      outputTarget,
      promptText: normalizedPrompt,
      promptIndex
    });
    const assistantTurnCount = getAssistantTurnElements().length;
    const previousButtons = captureDownloadTargetKeys();
    await sendMessage(
      normalizedPrompt,
      undefined,
      undefined,
      IMAGE_DOWNLOAD_TIMEOUT_SECONDS,
      {
        arrayRunController,
        outputTarget,
        promptText: normalizedPrompt,
        promptIndex,
        operationLabel: "image_limit_recovery_fresh_chat_send",
        previousAssistantTurnCount: assistantTurnCount
      }
    );

    return {
      assistantTurnCount,
      previousButtons
    };
  }

  async function runLimitRecovery(activePrompt, options) {
    const normalizedPrompt = String(activePrompt ?? "").trim();
    if (normalizedPrompt.length === 0) {
      throw new Error("Image limit recovery requires a prompt to resend.");
    }

    const arrayRunController = options && options.arrayRunController;
    const outputTarget = options && options.outputTarget;
    const promptIndex = options && Number.isFinite(options.promptIndex) ? options.promptIndex : null;
    const requiresCurrentChatContext = Boolean(options && options.requiresCurrentChatContext);

    if (!requiresCurrentChatContext) {
      return runFreshChatLimitRecovery(normalizedPrompt, {
        arrayRunController,
        outputTarget,
        promptIndex
      });
    }

    const assistantTurnCount = getAssistantTurnElements().length;
    const previousButtons = captureDownloadTargetKeys();
    console.warn(
      "[image-limit] Limit wait finished after context-dependent retries; staying in the current chat and resending the active image prompt.",
      {
        promptIndex,
        assistantTurnCount,
        prompt: summarizePromptForLog(normalizedPrompt)
      }
    );
    setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.RETRYING_PROMPT);
    await sendMessage(
      normalizedPrompt,
      undefined,
      undefined,
      IMAGE_DOWNLOAD_TIMEOUT_SECONDS,
      {
        arrayRunController,
        outputTarget,
        promptText: normalizedPrompt,
        promptIndex,
        operationLabel: "image_limit_recovery_send",
        previousAssistantTurnCount: assistantTurnCount
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
      .map((prompt) => normalizeRetryPromptStep(prompt))
      .filter(Boolean);

    return normalizedPrompts.length > 0
      ? normalizedPrompts
      : DEFAULT_IMAGE_RETRY_PROMPTS.map((prompt) => normalizeRetryPromptStep(prompt)).filter(Boolean);
  }

  function logImageRetryOptionsForArrayRun(imageRetryPrompts) {
    if (imageRetryPrompts === undefined) {
      console.log("[image-retry] Using default retry options.");
      return;
    }

    console.log("[image-retry] Using custom retry options.", {
      imageRetryPrompts: normalizeRetryPrompts(imageRetryPrompts)
    });
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

  function sanitizeArrayRunOptionsForResume(options) {
    if (!isPlainObject(options)) {
      return undefined;
    }

    const sanitized = {};
    if (options.continueOnImageDownloadTimeout !== undefined) {
      sanitized.continueOnImageDownloadTimeout = Boolean(options.continueOnImageDownloadTimeout);
    }
    if (options.skipWhitespaceOnlyMessages !== undefined) {
      sanitized.skipWhitespaceOnlyMessages = Boolean(options.skipWhitespaceOnlyMessages);
    }
    const retryPrompts = options.imageRetryPrompts ?? options.retryPrompts;
    if (retryPrompts !== undefined) {
      sanitized.imageRetryPrompts = normalizeRetryPrompts(retryPrompts).map((step) => ({
        prompt: step.prompt,
        image_expected_p: step.image_expected_p
      }));
    }
    return Object.keys(sanitized).length > 0 ? sanitized : undefined;
  }

  function buildArrayRunResumeRecord(config, controller, details) {
    const selectedEntryIndex = Number.isFinite(details && details.selectedEntryIndex)
      ? details.selectedEntryIndex
      : Number.isFinite(controller && controller.selectedEntryIndex)
        ? controller.selectedEntryIndex
        : 0;
    const currentEntry = Array.isArray(config.selectedEntries)
      ? config.selectedEntries[selectedEntryIndex]
      : null;
    return {
      status: "pending",
      reason: details && details.reason ? String(details.reason) : "array_run_progress",
      url: String(window.location.href || ""),
      selectedEntryIndex,
      activePromptPolicy: "redo_active",
      currentAbsoluteIndex:
        currentEntry && Number.isFinite(currentEntry.absoluteIndex) ? currentEntry.absoluteIndex : null,
      currentPrompt:
        currentEntry && currentEntry.fullPrompt !== undefined ? String(currentEntry.fullPrompt) : "",
      currentPromptSent: Boolean(details && details.currentPromptSent),
      initialImageRetryCount:
        details && Number.isFinite(details.initialImageRetryCount)
          ? Math.max(0, Math.trunc(details.initialImageRetryCount))
          : 0,
      runConfig: {
        selectedEntries: config.selectedEntries,
        sleepSeconds: config.sleepSeconds,
        sendMode: config.sendMode,
        useNewChat: config.useNewChat,
        pickOutputDir: config.pickOutputDir,
        outputDirectoryHandle: config.outputDirectoryHandle || null,
        options: sanitizeArrayRunOptionsForResume(config.options)
      }
    };
  }

  async function saveArrayRunResumeCheckpoint(config, controller, details) {
    if (!controller || !controller.resumeEnabled) {
      return null;
    }

    const record = buildArrayRunResumeRecord(config, controller, details);
    try {
      controller.resumeRecord = await writeArrayRunResumeRecord(record);
      return controller.resumeRecord;
    } catch (error) {
      if (
        record.runConfig &&
        record.runConfig.outputDirectoryHandle &&
        error &&
        typeof error === "object" &&
        (error.name === "DataCloneError" || /clone/i.test(String(error.message || "")))
      ) {
        console.warn("[resume] Could not persist the output directory handle; resume will ask for the folder again.");
        record.runConfig.outputDirectoryHandle = null;
        controller.resumeRecord = await writeArrayRunResumeRecord(record);
        return controller.resumeRecord;
      }
      console.warn(`[resume] Failed to save array-run checkpoint: ${formatErrorForLog(error)}`, error);
      return null;
    }
  }

  async function clearArrayRunResumeState() {
    await deleteArrayRunResumeRecord();
    console.log("[resume] Cleared saved array-run resume state.");
    return {
      ok: true
    };
  }

  async function getArrayRunResumeState() {
    return readArrayRunResumeRecord();
  }

  async function triggerArrayRunReloadResume(reason, details) {
    const controller = activeArrayRunController;
    if (!isActiveArrayRunController(controller) || !controller.runConfig) {
      throw new Error("No active array run is available to resume after reload.");
    }

    const selectedEntryIndex = Number.isFinite(details && details.selectedEntryIndex)
      ? details.selectedEntryIndex
      : controller.selectedEntryIndex;
    await saveArrayRunResumeCheckpoint(controller.runConfig, controller, {
      reason,
      selectedEntryIndex,
      currentPromptSent: Boolean(controller.currentPromptSent),
      initialImageRetryCount:
        details && Number.isFinite(details.initialImageRetryCount)
          ? details.initialImageRetryCount
          : 0
    });
    console.warn(`[resume] Saved array-run state for ${reason}; reloading the page now.`);
    window.location.reload();
    await new Promise(() => {});
  }

  async function refreshPageAndResume(options) {
    const activePromptPolicy =
      options && options.activePromptPolicy !== undefined
        ? String(options.activePromptPolicy)
        : "redo_active";
    if (activePromptPolicy !== "redo_active") {
      throw new Error('Only activePromptPolicy="redo_active" is supported.');
    }
    return triggerArrayRunReloadResume("manual_refresh", {
      initialImageRetryCount: 0
    });
  }

  async function waitForDownloadButtonVisibleWithRetry(previousButtons, retryPrompts, options) {
    const retryPromptQueue = normalizeRetryPrompts(retryPrompts);
    const waitOptions =
      options && typeof options === "object"
        ? options
        : {
            assistantTurnCount: 0
          };
    let retryCount = Number.isFinite(waitOptions.initialRetryCount)
      ? Math.max(0, Math.trunc(waitOptions.initialRetryCount))
      : 0;
    const originalPrompt =
      waitOptions && waitOptions.originalPrompt !== undefined && waitOptions.originalPrompt !== null
        ? String(waitOptions.originalPrompt)
        : "";
    const arrayRunController = waitOptions.arrayRunController;
    const outputTarget = waitOptions.outputTarget;
    const promptIndex = Number.isFinite(waitOptions.promptIndex) ? waitOptions.promptIndex : null;
    const sharedWaitOptions = waitOptions;
    let activeImagePrompt = originalPrompt;
    let activeImagePromptRequiresContext = false;
    let nextImagePromptRequiresContext = false;
    sharedWaitOptions.onLimitRecovered = async () =>
      runLimitRecovery(activeImagePrompt, {
        requiresCurrentChatContext: activeImagePromptRequiresContext,
        arrayRunController,
        outputTarget,
        promptIndex
      });

    while (true) {
      try {
        return {
          buttons: await waitForDownloadButtonVisible(undefined, undefined, previousButtons, sharedWaitOptions),
          retryCount
        };
      } catch (error) {
        const refusalDetected = isImageRefusalDetectedError(error);
        const imageGenerationFailedUiDetected = isImageGenerationFailedUiError(error);
        if (!refusalDetected && !imageGenerationFailedUiDetected && !isImageDownloadTimeoutError(error)) {
          throw error;
        }

        while (true) {
          if (retryCount >= retryPromptQueue.length) {
            if (retryCount > 0) {
              console.error(
                `${
                  refusalDetected
                    ? "Detected an image refusal"
                    : imageGenerationFailedUiDetected
                      ? `Detected latest assistant "Image generation failed" UI after exhausting ${IMAGE_RETRY_BUTTON_COUNT} in-turn "Try again" click${
                          IMAGE_RETRY_BUTTON_COUNT === 1 ? "" : "s"
                        }`
                      : "Timed out waiting for a generated image"
                } after ${retryCount} retry step${retryCount === 1 ? "" : "s"}.`
              );
            }
            throw refusalDetected || imageGenerationFailedUiDetected
              ? createImageDownloadTimeoutError()
              : error;
          }

          const retryStep = retryPromptQueue[retryCount];
          const retryPrompt = retryStep.prompt;
          const nextRetryNumber = retryCount + 1;
          console.log("[image-retry] Preparing retry step.", {
            retryStepNumber: nextRetryNumber,
            retryStepCount: retryPromptQueue.length,
            imageExpected: retryStep.image_expected_p,
            isMagicRetry: isMagicRetryPrompt(retryPrompt),
            isMagicRefreshRetry: isMagicRefreshRetryPrompt(retryPrompt),
            promptIndex,
            assistantTurnCount: waitOptions.assistantTurnCount
          });
          if (isMagicRefreshRetryPrompt(retryPrompt)) {
            console.warn(
              `${
                refusalDetected
                  ? "Detected an image refusal."
                  : imageGenerationFailedUiDetected
                    ? `Detected latest assistant "Image generation failed" UI after exhausting ${IMAGE_RETRY_BUTTON_COUNT} in-turn "Try again" click${
                        IMAGE_RETRY_BUTTON_COUNT === 1 ? "" : "s"
                      }.`
                    : "Timed out waiting for a generated image."
              } Running retry step ${nextRetryNumber}/${retryPromptQueue.length}: MAGIC_REFRESH_RETRY.`
            );
            setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.RETRYING_PROMPT);
            await triggerArrayRunReloadResume("magic_refresh_retry", {
              initialImageRetryCount: nextRetryNumber
            });
            return;
          }
          if (isMagicRetryPrompt(retryPrompt)) {
            console.warn(
              `${
                refusalDetected
                  ? "Detected an image refusal."
                  : imageGenerationFailedUiDetected
                    ? `Detected latest assistant "Image generation failed" UI after exhausting ${IMAGE_RETRY_BUTTON_COUNT} in-turn "Try again" click${
                        IMAGE_RETRY_BUTTON_COUNT === 1 ? "" : "s"
                      }.`
                  : "Timed out waiting for a generated image."
              } Running retry step ${nextRetryNumber}/${retryPromptQueue.length}: MAGIC_RETRY.`
            );
            setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.RETRYING_PROMPT);
            const retryResult = await runMagicRetry(originalPrompt, {
              arrayRunController,
              outputTarget,
              promptIndex
            });
            activeImagePrompt = originalPrompt;
            activeImagePromptRequiresContext = false;
            nextImagePromptRequiresContext = false;
            previousButtons = retryResult.previousButtons;
            waitOptions.assistantTurnCount = retryResult.assistantTurnCount;
            retryCount = nextRetryNumber;
            break;
          }

          console.warn(
            `${
              refusalDetected
                ? "Detected an image refusal."
                : imageGenerationFailedUiDetected
                  ? `Detected latest assistant "Image generation failed" UI after exhausting ${IMAGE_RETRY_BUTTON_COUNT} in-turn "Try again" click${
                      IMAGE_RETRY_BUTTON_COUNT === 1 ? "" : "s"
                    }.`
                : "Timed out waiting for a generated image."
            } Sending retry step ${nextRetryNumber}/${retryPromptQueue.length} and waiting for the composer to become ready for the next input.`
          );
          setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.RETRYING_PROMPT);
          await sendMessage(
            retryPrompt,
            undefined,
            IMAGE_RETRY_PROMPT_SEND_SLEEP_MS,
            IMAGE_DOWNLOAD_TIMEOUT_SECONDS,
            {
              arrayRunController,
              outputTarget,
              promptText: retryPrompt,
              promptIndex,
              operationLabel: "retry_prompt_send",
              previousAssistantTurnCount: waitOptions.assistantTurnCount
            }
          );
          if (!retryStep.image_expected_p) {
            await waitForComposerReadyForInput(undefined, IMAGE_DOWNLOAD_TIMEOUT_SECONDS, {
              arrayRunController,
              outputTarget,
              promptText: retryPrompt,
              promptIndex,
              phase: ARRAY_RUN_PHASES.RETRYING_PROMPT,
              operationLabel: "retry_prompt_response",
              previousAssistantTurnCount: waitOptions.assistantTurnCount
            });
            waitOptions.assistantTurnCount = getAssistantTurnElements().length;
            nextImagePromptRequiresContext = true;
            retryCount = nextRetryNumber;
            console.log("[image-retry] Non-image retry step completed; composer is ready. Advancing to next retry step.", {
              completedRetryStepNumber: nextRetryNumber,
              retryStepCount: retryPromptQueue.length,
              promptIndex,
              assistantTurnCount: waitOptions.assistantTurnCount
            });
            continue;
          }

          activeImagePrompt = retryPrompt;
          activeImagePromptRequiresContext = nextImagePromptRequiresContext;
          nextImagePromptRequiresContext = false;
          waitOptions.assistantTurnCount = getAssistantTurnElements().length;
          retryCount = nextRetryNumber;
          console.log("[image-retry] Retry step sent; returning to image wait loop.", {
            completedRetryStepNumber: nextRetryNumber,
            retryStepCount: retryPromptQueue.length,
            promptIndex,
            assistantTurnCount: waitOptions.assistantTurnCount
          });
          break;
        }
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
    const promptText =
      options && options.promptText !== undefined && options.promptText !== null
        ? String(options.promptText)
        : "";
    const promptIndex = options && Number.isFinite(options.promptIndex) ? options.promptIndex : null;

    console.log(`Found ${buttons.length} generated image(s). Downloading all.`);
    for (let index = 0; index < buttons.length; index++) {
      setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.DOWNLOADING_IMAGES);
      throwIfSkipCurrentPromptRequested(arrayRunController, ARRAY_RUN_PHASES.DOWNLOADING_IMAGES);
      const button = buttons[index];
      console.log(`Downloading generated image ${index + 1}`);

      const filenameBase = filenameBaseBuilder ? filenameBaseBuilder(index, button) : null;
      const fetchResult = await fetchGeneratedImageBlobWithRetry(button, {
        downloadIndex: index,
        promptText,
        promptIndex,
        arrayRunController,
        outputTarget
      });
      const assetUrl = fetchResult.assetUrl;
      const response = fetchResult.response;
      const blob = fetchResult.blob;
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
      if (fetchResult.retryCount > 0) {
        console.log(
          `[download-retry] ${getGeneratedImageTargetLabel(index)} completed after ${fetchResult.retryCount} retry attempt${
            fetchResult.retryCount === 1 ? "" : "s"
          }.`
        );
      }

      const clickedCount = index + 1;
      const shouldPause =
        clickedCount % DOWNLOAD_CLICK_BURST_SIZE === 0 && clickedCount < buttons.length;
      if (shouldPause) {
        console.log(
          `Pausing ${DOWNLOAD_CLICK_BURST_DELAY_MS / 1000} seconds after ${clickedCount} download clicks...`
        );
        await sleepForMs(DOWNLOAD_CLICK_BURST_DELAY_MS, {
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
    const promptIndex =
      options && Number.isFinite(options.promptIndex) ? options.promptIndex : progressCurrent;
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
    const imageRetryPrompts =
      options && (options.imageRetryPrompts ?? options.retryPrompts) !== undefined
        ? options.imageRetryPrompts ?? options.retryPrompts
        : undefined;
    const initialImageRetryCount =
      options && Number.isFinite(options.initialImageRetryCount)
        ? Math.max(0, Math.trunc(options.initialImageRetryCount))
        : 0;

    if (useNewChat) {
      console.log("Waiting for generated image...");
      const waitResult = await waitForDownloadButtonVisibleWithRetry(previousButtons, imageRetryPrompts, {
        assistantTurnCount,
        originalPrompt,
        arrayRunController,
        outputTarget,
        promptIndex,
        initialRetryCount: initialImageRetryCount
      });
      const newButtons = waitResult.buttons;
      const clickedCount = await clickDownloadButtons(newButtons, undefined, {
        filenameBaseBuilder,
        arrayRunController,
        outputTarget,
        promptText: originalPrompt,
        promptIndex
      });
      const retrySuffix =
        waitResult.retryCount > 0
          ? ` after ${waitResult.retryCount} retry step${waitResult.retryCount === 1 ? "" : "s"}`
          : "";
      const completionVerb =
        outputTarget && outputTarget.type === "picked_directory" ? "saved" : "downloaded";
      console.log(
        `Image ${completionVerb}${retrySuffix} (${formatArrayPromptProgress(
          progressCurrent,
          progressTotal,
          promptIndex
        )}) via ${clickedCount} file${clickedCount === 1 ? "" : "s"}.`
      );

      if (index < total - 1) {
        setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.OPENING_NEW_CHAT_AFTER_SUCCESS);
        await openNewChat({
          arrayRunController,
          phase: ARRAY_RUN_PHASES.OPENING_NEW_CHAT_AFTER_SUCCESS,
          outputTarget,
          promptText: originalPrompt,
          promptIndex
        });
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
      await openNewChat({
        arrayRunController: controller,
        phase: ARRAY_RUN_PHASES.OPENING_NEW_CHAT_AFTER_SKIP,
        promptIndex: currentAbsoluteIndex
      });
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

    if (useNewChat && count > 0) {
      console.log("[new_chat_image] Opening a fresh chat before starting the run.");
      await openNewChat({
        outputTarget,
        promptText: msg,
        promptIndex: 1
      });
    }

    for (let i = 0; i < count; i++) {
      const previousButtons = useNewChat
        ? new Set(getDownloadButtons().map((button) => getDownloadTargetKey(button)).filter(Boolean))
        : undefined;
      const previousAssistantTurnCount = useNewChat ? getAssistantTurnElements().length : 0;
      await sendMessage(msg, undefined, undefined, undefined, {
        outputTarget,
        promptText: msg,
        promptIndex: i + 1,
        operationLabel: "initial_send",
        previousAssistantTurnCount: previousAssistantTurnCount
      });
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
  // - continueOnImageDownloadTimeout: legacy escape hatch; if an image timeout still bubbles out
  //   of the recovery loop, save the failed prompt to a .txt file and continue.
  // - imageRetryPrompts / retryPrompts: override the default image retry queue used by
  //   waitForDownloadButtonVisibleWithRetry in new_chat_image mode. Entries may be raw
  //   strings / MAGIC_RETRY / MAGIC_REFRESH_RETRY or objects like { prompt, image_expected_p }.
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

  function isRecognizedSendMode(value) {
    if (value === undefined || value === null) {
      return false;
    }

    const normalized = String(value).trim().toLowerCase();
    return normalized === SEND_MODES.CONTINUOUS || normalized === SEND_MODES.NEW_CHAT_IMAGE;
  }

  function isIntegerCompatibleValue(value) {
    if (value === undefined || value === null) {
      return false;
    }
    if (typeof value === "string" && value.trim() === "") {
      return false;
    }
    return Number.isFinite(Number(value));
  }

  function describeArraySelection(selection) {
    if (selection === undefined || selection === null) {
      return "all";
    }
    if (typeof selection === "string") {
      return selection === "" ? '""' : selection;
    }
    if (Array.isArray(selection)) {
      try {
        return JSON.stringify(selection);
      } catch (error) {
        return "[array]";
      }
    }
    return String(selection);
  }

  function createAllArraySelectionIndices(length) {
    return Array.from({ length }, (_, index) => index);
  }

  function parseSelectionIndexToken(token, length) {
    if (!/^-?\d+$/.test(token)) {
      throw new Error(`Invalid selection index token: "${token}".`);
    }
    const normalizedIndex = normalizeIndex(toInteger(token, 0), length, false);
    if (normalizedIndex < 0 || normalizedIndex >= length) {
      console.warn(
        `[selection] Skipping out-of-range index ${token} for ${length} prompt${
          length === 1 ? "" : "s"
        }.`
      );
      return [];
    }
    return [normalizedIndex];
  }

  function parseSelectionRangeToken(token, length) {
    const match = token.match(/^(-?\d+)?\.\.(-?\d+)?$/);
    if (!match) {
      throw new Error(`Invalid selection range token: "${token}".`);
    }

    if (length <= 0) {
      return [];
    }

    const [, startToken, endToken] = match;
    if (startToken === undefined && endToken === undefined) {
      return createAllArraySelectionIndices(length);
    }

    let startIndex = 0;
    if (startToken !== undefined) {
      const normalizedStart = normalizeIndex(toInteger(startToken, 0), length, false);
      if (normalizedStart >= length) {
        return [];
      }
      startIndex = Math.max(0, normalizedStart);
    }

    let endIndex = length - 1;
    if (endToken !== undefined) {
      const normalizedEnd = normalizeIndex(toInteger(endToken, 0), length, false);
      if (normalizedEnd < 0) {
        return [];
      }
      endIndex = Math.min(length - 1, normalizedEnd);
    }

    if (startIndex > endIndex) {
      return [];
    }

    const indices = [];
    for (let index = startIndex; index <= endIndex; index++) {
      indices.push(index);
    }
    return indices;
  }

  function normalizeArraySelection(selection, length) {
    if (length <= 0) {
      return [];
    }

    if (selection === undefined || selection === null || selection === "") {
      return createAllArraySelectionIndices(length);
    }

    if (Array.isArray(selection)) {
      const indices = [];
      for (const entry of selection) {
        if (!isIntegerCompatibleValue(entry)) {
          throw new Error(`Selection arrays may contain integers only; got: ${String(entry)}`);
        }
        indices.push(...parseSelectionIndexToken(String(Math.trunc(Number(entry))), length));
      }
      return indices;
    }

    const selectionText = String(selection).trim();
    if (selectionText === "") {
      return createAllArraySelectionIndices(length);
    }

    const indices = [];
    for (const rawSegment of selectionText.split(",")) {
      const segment = rawSegment.trim();
      if (segment === "") {
        throw new Error(`Invalid empty selection segment in "${selectionText}".`);
      }
      if (segment.includes("..")) {
        indices.push(...parseSelectionRangeToken(segment, length));
      } else {
        indices.push(...parseSelectionIndexToken(segment, length));
      }
    }
    return indices;
  }

  function createLegacyArraySelectionError() {
    return new Error(
      `Legacy from/to array helper arguments are no longer supported. Use selection instead, ` +
        `for example selection="" (all), selection="2..", or selection="4..10, 12, 20..".`
    );
  }

  function normalizeArraySelectionCallArguments(
    selectionOrMode,
    modeOrPickOutputDirOrOptions,
    pickOutputDirOrOptions,
    maybeLegacyPickOutputDir,
    options
  ) {
    if (
      isIntegerCompatibleValue(selectionOrMode) &&
      isIntegerCompatibleValue(modeOrPickOutputDirOrOptions)
    ) {
      throw createLegacyArraySelectionError();
    }

    if (
      selectionOrMode === undefined ||
      selectionOrMode === null ||
      typeof selectionOrMode === "boolean" ||
      isPlainObject(selectionOrMode)
    ) {
      return {
        selection: undefined,
        mode: undefined,
        pickOutputDirOrOptions: selectionOrMode,
        maybeLegacyPickOutputDir: modeOrPickOutputDirOrOptions,
        options: pickOutputDirOrOptions
      };
    }

    if (
      isRecognizedSendMode(selectionOrMode) &&
      !isRecognizedSendMode(modeOrPickOutputDirOrOptions)
    ) {
      return {
        selection: undefined,
        mode: selectionOrMode,
        pickOutputDirOrOptions: modeOrPickOutputDirOrOptions,
        maybeLegacyPickOutputDir: pickOutputDirOrOptions,
        options: maybeLegacyPickOutputDir
      };
    }

    if (
      (Array.isArray(selectionOrMode) ||
        (typeof selectionOrMode === "string" && !isRecognizedSendMode(selectionOrMode))) &&
      (modeOrPickOutputDirOrOptions === undefined ||
        modeOrPickOutputDirOrOptions === null ||
        typeof modeOrPickOutputDirOrOptions === "boolean" ||
        isPlainObject(modeOrPickOutputDirOrOptions))
    ) {
      return {
        selection: selectionOrMode,
        mode: undefined,
        pickOutputDirOrOptions: modeOrPickOutputDirOrOptions,
        maybeLegacyPickOutputDir: pickOutputDirOrOptions,
        options: maybeLegacyPickOutputDir
      };
    }

    return {
      selection: selectionOrMode,
      mode: modeOrPickOutputDirOrOptions,
      pickOutputDirOrOptions,
      maybeLegacyPickOutputDir,
      options
    };
  }

  function formatArrayPromptProgress(selectionPosition, totalSelected, absoluteIndex) {
    const segments = [];
    if (Number.isFinite(selectionPosition) && Number.isFinite(totalSelected)) {
      segments.push(`selection ${selectionPosition}/${totalSelected}`);
    }
    if (Number.isFinite(absoluteIndex)) {
      segments.push(`prompt ${absoluteIndex}`);
    }
    return segments.join(", ");
  }

  async function resolveArrayRunOutputTarget(config) {
    if (!config.useNewChat || !Array.isArray(config.selectedEntries) || config.selectedEntries.length === 0) {
      return null;
    }
    if (config.pickOutputDir && config.outputDirectoryHandle) {
      try {
        return await createPickedOutputTargetFromHandle(config.outputDirectoryHandle);
      } catch (error) {
        console.warn(`[resume] Could not reuse saved output folder: ${formatErrorForLog(error)}. Asking again.`);
      }
    }
    return resolveOutputTarget(Boolean(config.pickOutputDir));
  }

  async function runPreparedArrayRun(config, resumeOptions) {
    const selectedEntries = Array.isArray(config.selectedEntries)
      ? config.selectedEntries.map((entry) => ({
          absoluteIndex: entry.absoluteIndex,
          message: String(entry.message ?? ""),
          fullPrompt:
            entry.fullPrompt !== undefined
              ? String(entry.fullPrompt)
              : `${config.prefixText || ""}${entry.message ?? ""}${config.postfixText || ""}`
        }))
      : [];
    const sleepSeconds = config.sleepSeconds ?? 30;
    const sleepDuration = sleepSeconds * 1000;
    const sendMode = normalizeSendMode(config.sendMode);
    const useNewChat = sendMode === SEND_MODES.NEW_CHAT_IMAGE;
    const options = isPlainObject(config.options) ? config.options : undefined;
    const continueOnImageDownloadTimeout = Boolean(
      useNewChat && options && options.continueOnImageDownloadTimeout
    );
    const imageRetryPrompts =
      useNewChat && options ? options.imageRetryPrompts ?? options.retryPrompts : undefined;
    if (useNewChat) {
      logImageRetryOptionsForArrayRun(imageRetryPrompts);
    }
    const startSelectedEntryIndex = Math.max(
      0,
      Math.min(
        selectedEntries.length,
        Math.trunc(Number(resumeOptions && resumeOptions.startSelectedEntryIndex) || 0)
      )
    );
    const initialImageRetryCount =
      resumeOptions && Number.isFinite(resumeOptions.initialImageRetryCount)
        ? Math.max(0, Math.trunc(resumeOptions.initialImageRetryCount))
        : 0;
    const isAutoResume = Boolean(resumeOptions && resumeOptions.isAutoResume);

    if (selectedEntries.length === 0 || startSelectedEntryIndex >= selectedEntries.length) {
      console.log("[resume] No remaining selected prompts to send.");
      await discardArrayRunResumeRecord();
      return;
    }
    if (activeArrayRunController && activeArrayRunController.active) {
      throw new Error("An array prompt run is already active; cannot start another skippable array run.");
    }
    const outputTarget = await resolveArrayRunOutputTarget({
      ...config,
      selectedEntries,
      sendMode,
      useNewChat
    });
    const runConfig = {
      ...config,
      selectedEntries,
      sleepSeconds,
      sendMode,
      useNewChat,
      outputDirectoryHandle:
        outputTarget && outputTarget.directoryHandle
          ? outputTarget.directoryHandle
          : config.outputDirectoryHandle || null,
      options
    };

    const arrayRunController = createArrayRunController({
      useNewChat,
      totalSelected: selectedEntries.length
    });
    arrayRunController.resumeEnabled = true;
    arrayRunController.runConfig = runConfig;
    arrayRunController.selectedEntryIndex = startSelectedEntryIndex;
    activeArrayRunController = arrayRunController;

    try {
      await saveArrayRunResumeCheckpoint(runConfig, arrayRunController, {
        reason: isAutoResume ? "auto_resume_started" : "array_run_started",
        selectedEntryIndex: startSelectedEntryIndex,
        currentPromptSent: false,
        initialImageRetryCount
      });
      if (useNewChat && selectedEntries.length > 0) {
        const firstEntry = selectedEntries[startSelectedEntryIndex];
        const phase = startSelectedEntryIndex === 0 && !isAutoResume
          ? ARRAY_RUN_PHASES.OPENING_NEW_CHAT_BEFORE_START
          : ARRAY_RUN_PHASES.OPENING_NEW_CHAT_FOR_RETRY;
        setArrayRunPhase(arrayRunController, phase);
        console.log(
          isAutoResume
            ? "[resume] Opening a fresh chat before redoing the active prompt after reload."
            : "[new_chat_image] Opening a fresh chat before starting the array run."
        );
        await openNewChat({
          arrayRunController,
          phase,
          outputTarget,
          promptText: firstEntry.fullPrompt,
          promptIndex: firstEntry.absoluteIndex
        });
      }

      for (let i = startSelectedEntryIndex; i < selectedEntries.length; i++) {
        const entry = selectedEntries[i];
        const absoluteIndex = entry.absoluteIndex;
        const selectionPosition = i + 1;
        const fullPrompt = entry.fullPrompt;
        const hasNextPrompt = i < selectedEntries.length - 1;
        const previousButtons = useNewChat ? captureDownloadTargetKeys() : undefined;
        const previousAssistantTurnCount = useNewChat ? getAssistantTurnElements().length : 0;
        const progressLabel = formatArrayPromptProgress(
          selectionPosition,
          selectedEntries.length,
          absoluteIndex
        );

        arrayRunController.selectedEntryIndex = i;
        setArrayRunCurrentPrompt(arrayRunController, absoluteIndex, fullPrompt);
        await saveArrayRunResumeCheckpoint(runConfig, arrayRunController, {
          reason: "prompt_started",
          selectedEntryIndex: i,
          currentPromptSent: false,
          initialImageRetryCount: i === startSelectedEntryIndex ? initialImageRetryCount : 0
        });

        try {
          await sendMessage(fullPrompt, undefined, undefined, undefined, {
            arrayRunController,
            outputTarget,
            promptText: fullPrompt,
            promptIndex: absoluteIndex,
            operationLabel: "initial_send",
            previousAssistantTurnCount: previousAssistantTurnCount
          });
          markArrayRunCurrentPromptSent(arrayRunController);
          await saveArrayRunResumeCheckpoint(runConfig, arrayRunController, {
            reason: "prompt_sent",
            selectedEntryIndex: i,
            currentPromptSent: true,
            initialImageRetryCount: i === startSelectedEntryIndex ? initialImageRetryCount : 0
          });
          console.log(`Message sent (${progressLabel}).`);

          await handlePostSend(
            i,
            selectedEntries.length,
            sleepDuration,
            sleepSeconds,
            useNewChat,
            previousButtons,
            {
              progressCurrent: selectionPosition,
              progressTotal: selectedEntries.length,
              promptIndex: absoluteIndex,
              assistantTurnCount: previousAssistantTurnCount,
              originalPrompt: fullPrompt,
              arrayRunController,
              outputTarget,
              filenameBaseBuilder: useNewChat
                ? (downloadIndex) =>
                    downloadIndex === 0 ? `${absoluteIndex}` : `${absoluteIndex}_${downloadIndex}`
                : undefined,
              imageRetryPrompts,
              initialImageRetryCount: i === startSelectedEntryIndex ? initialImageRetryCount : 0
            }
          );
          arrayRunController.selectedEntryIndex = i + 1;
          await saveArrayRunResumeCheckpoint(runConfig, arrayRunController, {
            reason: "prompt_completed",
            selectedEntryIndex: i + 1,
            currentPromptSent: false,
            initialImageRetryCount: 0
          });
        } catch (error) {
          if (isSkipCurrentPromptError(error)) {
            await handleSkippedCurrentArrayPrompt(arrayRunController, {
              hasNextPrompt,
              useNewChat
            });
            arrayRunController.selectedEntryIndex = i + 1;
            await saveArrayRunResumeCheckpoint(runConfig, arrayRunController, {
              reason: "prompt_skipped",
              selectedEntryIndex: i + 1,
              currentPromptSent: false,
              initialImageRetryCount: 0
            });
            continue;
          }

          if (!continueOnImageDownloadTimeout || !isImageDownloadTimeoutError(error)) {
            throw error;
          }

          const failedFilename = await downloadTextFile(
            fullPrompt,
            `failed_prompt_${absoluteIndex}_selection_${selectionPosition}_of_${selectedEntries.length}`,
            outputTarget
          );
          console.error(
            `Timed out waiting for a generated image (${progressLabel}). ` +
              `Saved failed prompt to "${failedFilename}" in ${describeOutputTarget(
                outputTarget
              )}. Continuing.`,
            error
          );

          if (hasNextPrompt) {
            setArrayRunPhase(arrayRunController, ARRAY_RUN_PHASES.OPENING_NEW_CHAT_AFTER_SKIP);
            await openNewChat({
              arrayRunController,
              phase: ARRAY_RUN_PHASES.OPENING_NEW_CHAT_AFTER_SKIP,
              outputTarget,
              promptText: fullPrompt,
              promptIndex: absoluteIndex
            });
            await waitForNextPromptTransition(
              sleepDuration > 0 ? sleepDuration : 1200,
              arrayRunController
            );
          }
          arrayRunController.selectedEntryIndex = i + 1;
          await saveArrayRunResumeCheckpoint(runConfig, arrayRunController, {
            reason: "prompt_failed_and_continued",
            selectedEntryIndex: i + 1,
            currentPromptSent: false,
            initialImageRetryCount: 0
          });
        } finally {
          clearArrayRunCurrentPrompt(arrayRunController);
        }
      }
      await discardArrayRunResumeRecord();
    } finally {
      finalizeArrayRunController(arrayRunController);
    }
  }

  async function sendMessageRepeatedlyArray(
    msgs,
    sleep,
    sep,
    prefix,
    postfix,
    selection,
    mode,
    pickOutputDirOrOptions,
    maybeLegacyPickOutputDir,
    options
  ) {
    const sleepSeconds = sleep ?? 30;
    const separator = sep ?? "\n";
    const prefixText = prefix ?? "";
    const postfixText = postfix ?? "";
    const normalizedCallArgs = normalizeArraySelectionCallArguments(
      selection,
      mode,
      pickOutputDirOrOptions,
      maybeLegacyPickOutputDir,
      options
    );
    const sendMode = normalizeSendMode(normalizedCallArgs.mode);
    const useNewChat = sendMode === SEND_MODES.NEW_CHAT_IMAGE;
    const normalizedArgs = normalizeArrayOutputArguments(
      normalizedCallArgs.pickOutputDirOrOptions,
      normalizedCallArgs.maybeLegacyPickOutputDir,
      normalizedCallArgs.options
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

    const selectedIndices = normalizeArraySelection(normalizedCallArgs.selection, messages.length);
    if (selectedIndices.length === 0) {
      console.log(
        `No messages to send for selection ${describeArraySelection(normalizedCallArgs.selection)}.`
      );
      return;
    }

    const selectedEntries = selectedIndices.map((absoluteIndex) => ({
      absoluteIndex,
      message: messages[absoluteIndex],
      fullPrompt: `${prefixText}${messages[absoluteIndex]}${postfixText}`
    }));

    await runPreparedArrayRun({
      selectedEntries,
      sleepSeconds,
      prefixText,
      postfixText,
      sendMode,
      useNewChat,
      pickOutputDir: normalizedArgs.pickOutputDir,
      options: normalizedArgs.options
    });
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

  function normalizeChooseFileOutputArguments(
    pickOutputDirOrOptions,
    maybeLegacyPickOutputDir,
    options
  ) {
    return normalizeArrayOutputArguments(
      pickOutputDirOrOptions,
      maybeLegacyPickOutputDir,
      options
    );
  }

  async function sendMessageRepeatedlyArrayChooseFile(
    sleep,
    sep,
    prefix,
    postfix,
    selection,
    mode,
    pick_output_dir,
    legacy_pick_output_dir,
    options
  ) {
    const fileText = await chooseFileAsText();
    const normalizedCallArgs = normalizeArraySelectionCallArguments(
      selection,
      mode,
      pick_output_dir,
      legacy_pick_output_dir,
      options
    );
    const sendMode = normalizeSendMode(normalizedCallArgs.mode);
    const normalizedArgs = normalizeChooseFileOutputArguments(
      normalizedCallArgs.pickOutputDirOrOptions,
      normalizedCallArgs.maybeLegacyPickOutputDir,
      normalizedCallArgs.options
    );
    await sendMessageRepeatedlyArray(
      fileText,
      sleep,
      sep,
      prefix,
      postfix,
      normalizedCallArgs.selection,
      sendMode,
      normalizedArgs.pickOutputDir,
      {
        ...normalizedArgs.options,
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

  async function autoResumeArrayRunOnStartup() {
    if (arrayRunAutoResumeStarted) {
      return;
    }

    const record = await readArrayRunResumeRecord();
    if (!record || record.status !== "pending" || !record.runConfig) {
      return;
    }

    arrayRunAutoResumeStarted = true;
    const selectedEntryIndex = Number.isFinite(record.selectedEntryIndex)
      ? Math.max(0, Math.trunc(record.selectedEntryIndex))
      : 0;
    const initialImageRetryCount = Number.isFinite(record.initialImageRetryCount)
      ? Math.max(0, Math.trunc(record.initialImageRetryCount))
      : 0;
    console.warn("[resume] Found saved array-run state. Auto-resuming after page load.", {
      reason: record.reason || "",
      selectedEntryIndex,
      currentAbsoluteIndex: record.currentAbsoluteIndex,
      initialImageRetryCount,
      savedAt: record.updatedAt ? new Date(record.updatedAt).toISOString() : null
    });

    try {
      await runPreparedArrayRun(record.runConfig, {
        isAutoResume: true,
        startSelectedEntryIndex: selectedEntryIndex,
        initialImageRetryCount
      });
    } catch (error) {
      console.error(`[resume] Auto-resume failed: ${formatErrorForLog(error)}`, error);
      arrayRunAutoResumeStarted = false;
    }
  }

  // Export helpers so they are callable from devtools console.
  window.delay = sleepForMs;
  window.sleepForMs = sleepForMs;
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
  window.refreshPageAndResume = refreshPageAndResume;
  window.reloadAndResume = refreshPageAndResume;
  window.getArrayRunResumeState = getArrayRunResumeState;
  window.clearArrayRunResumeState = clearArrayRunResumeState;
  window.clickDallEDownloadButtons = clickDallEDownloadButtons;
  window.waitForImageGenerationLimitReset = waitForImageGenerationLimitReset;
  window.MAGIC_RETRY = MAGIC_RETRY_PROMPT;
  window.MAGIC_REFRESH_RETRY = MAGIC_REFRESH_RETRY_PROMPT;
  window.MAGIC_REFRESH_RETRY_PROMPT = MAGIC_REFRESH_RETRY_PROMPT;

  // Keep these globals so this call style works in console:
  // sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)
  // sendMessageRepeatedlyArray("Prompt 1\nPrompt 2", sleep=10, sep="\n", prefix="", postfix="", selection="", mode="continuous")
  // sendMessageRepeatedlyArrayChooseFile(sleep=10, sep="\n", prefix="", postfix="", selection="", mode="new_chat_image", pick_output_dir=true)
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
  if (!("selection" in window)) {
    window.selection = undefined;
  }
  if (!("mode" in window)) {
    window.mode = undefined;
  }
  if (!("pick_output_dir" in window)) {
    window.pick_output_dir = undefined;
  }

  console.log(`[userscript] ChatGPT Message Helper v${USERSCRIPT_VERSION} loaded.`);
  console.log(
    '[userscript] Ready. Example: sendMessageRepeatedly("Thanks, continue.", n=2, sleep=60,)'
  );
  autoResumeArrayRunOnStartup();
})();
