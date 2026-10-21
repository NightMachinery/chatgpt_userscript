// ==UserScript==
// @name         AI Chat Shortcut Swap
// @namespace    https://github.com/NightMachinery/chatgpt_userscript
// @version      1.0.0
// @description  Cmd+K starts a new chat; Cmd+Shift+O and Cmd+S search chats.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @match        https://claude.ai/*
// @match        https://gemini.google.com/*
// @match        https://perplexity.ai/*
// @match        https://www.perplexity.ai/*
// @match        https://www.kimi.com/*
// @grant        none
// @run-at       document-start
// @noframes
// ==/UserScript==

(function () {
  "use strict";

  const SITES = {
    "chatgpt.com": { newChat: "/", nativeShortcuts: true },
    "chat.openai.com": { newChat: "/", nativeShortcuts: true },
    "claude.ai": { newChat: "/new" },
    "gemini.google.com": {
      newChat: "/app",
      newChatSelector: '[data-test-id="new-chat-button"] a, a[data-test-id="new-chat-button"], button[data-test-id="new-chat-button"]',
      searchSelector: 'button[data-test-id="expand-search-button"], button[data-test-id="search-button"], button[aria-label="Search"], button[aria-label="搜索"]',
      sidebarSelector: 'button[data-test-id="expand-side-nav"], button[data-test-id="side-nav-menu-button"]'
    },
    "perplexity.ai": { newChat: "/" },
    "www.perplexity.ai": { newChat: "/" },
    "www.kimi.com": { newChat: "/" }
  };
  const site = SITES[location.hostname];
  if (!site || window.top !== window.self) return;

  const CONTROLS = 'button, a[href], [role="button"], [role="link"]';
  const NAVIGATION = 'nav, aside, [role="navigation"], [data-testid="sidebar"], .sidebar, bard-sidenav';
  const LABELS = {
    newChat: /^(?:(?:start\s+)?new\s+(?:chat|conversation|thread)|新建(?:聊天|对话|会话)|开启新对话|新对话)$/i,
    search: /^(?:search\s+(?:(?:your|past|all)\s+)?(?:(?:chats?|conversations?|threads?)(?:\s+history)?|history)|搜索(?:聊天|对话|会话|历史))$/i,
    sidebar: /^(?:(?:open|show|expand)\s+(?:sidebar|menu|navigation)|main menu|展开(?:侧边栏|菜单))$/i
  };
  let pending = false;
  let noticeTimer;
  const heldKeys = new Set();

  function isAvailable(element) {
    if (element.closest('[hidden], [inert], [aria-hidden="true"]')) return false;
    if (element.matches(':disabled, [aria-disabled="true"]')) return false;
    const style = getComputedStyle(element);
    return style.display !== "none" && style.visibility !== "hidden" && element.getClientRects().length > 0;
  }

  function labels(element) {
    return [element.getAttribute("aria-label"), element.getAttribute("title"), element.innerText]
      .filter(Boolean)
      // Shortcut hints sometimes share the button's accessible label.
      .map((label) => label.replace(/\s*(?:\(|\[)?(?:[⌘⇧⌃⌥]|cmd\b|command\b|ctrl\b|control\b).*$/i, "").trim());
  }

  function findControl(action) {
    const selector = site[`${action}Selector`];
    if (selector) {
      const control = Array.from(document.querySelectorAll(selector)).find(isAvailable);
      if (control) return control;
    }
    return Array.from(document.querySelectorAll(CONTROLS)).find((element) => {
      if (!isAvailable(element)) return false;
      const names = labels(element);
      if (names.some((name) => LABELS[action].test(name))) return true;
      // A bare "Search" in the composer usually means web search. Only use it
      // in navigation, or on a control explicitly declaring the chat shortcut.
      return action === "search" && names.some((name) => /^(?:search|搜索)$/i.test(name)) &&
        (element.closest(NAVIGATION) || /^(?:Meta|Control)\+K$/i.test(element.getAttribute("aria-keyshortcuts") || ""));
    });
  }

  function activate(action) {
    const control = findControl(action);
    if (!control) return false;
    control.click();
    return true;
  }

  function waitForControl(action) {
    return new Promise((resolve) => {
      const observer = new MutationObserver(() => {
        if (activate(action)) finish(true);
      });
      const timer = setTimeout(() => finish(false), 1200);
      function finish(found) {
        observer.disconnect();
        clearTimeout(timer);
        resolve(found);
      }
      observer.observe(document.documentElement, { childList: true, subtree: true, attributes: true });
      if (activate(action)) finish(true);
    });
  }

  function nativeShortcut(action) {
    const target = document.activeElement || document.body || document;
    const options = {
      key: action === "newChat" ? "o" : "k",
      code: action === "newChat" ? "KeyO" : "KeyK",
      metaKey: true,
      shiftKey: action === "newChat",
      bubbles: true,
      cancelable: true,
      composed: true
    };
    target.dispatchEvent(new KeyboardEvent("keydown", options));
    target.dispatchEvent(new KeyboardEvent("keyup", options));
  }

  function showUnavailable(action) {
    const message = `AI Chat Shortcut Swap: ${action === "search" ? "chat search" : "new chat"} control not found. Open the site's sidebar and try again.`;
    console.warn(message);
    let notice = document.getElementById("ai-chat-shortcut-notice");
    if (!notice) {
      notice = document.createElement("div");
      notice.id = "ai-chat-shortcut-notice";
      notice.setAttribute("role", "status");
      notice.style.cssText = "position:fixed;bottom:20px;left:20px;z-index:2147483647;max-width:420px;padding:12px 16px;border-radius:8px;background:#222;color:#fff;font:14px/1.4 system-ui;box-shadow:0 2px 12px #0006";
      document.documentElement.appendChild(notice);
    }
    notice.textContent = message;
    clearTimeout(noticeTimer);
    noticeTimer = setTimeout(() => notice.remove(), 5000);
  }

  async function perform(action) {
    if (pending) return;
    pending = true;
    try {
      if (activate(action)) return;
      const sidebar = findControl("sidebar");
      if (sidebar && sidebar.getAttribute("aria-expanded") !== "true") {
        sidebar.click();
        if (await waitForControl(action)) return;
      }
      if (site.nativeShortcuts) {
        nativeShortcut(action);
      } else if (action === "newChat") {
        location.assign(site.newChat);
      } else {
        showUnavailable(action);
      }
    } catch (error) {
      console.warn("AI Chat Shortcut Swap:", error);
      showUnavailable(action);
    } finally {
      pending = false;
    }
  }

  function actionFor(event) {
    if (!event.metaKey || event.ctrlKey || event.altKey || event.isComposing) return null;
    const key = event.key.toLowerCase();
    if (!event.shiftKey && key === "k") return "newChat";
    if ((!event.shiftKey && key === "s") || (event.shiftKey && key === "o")) return "search";
    return null;
  }

  window.addEventListener("keydown", (event) => {
    // Leave generated shortcuts alone: basic.js uses Cmd+Shift+O to open new
    // chats, and the native fallback above must not loop back through the swap.
    if (!event.isTrusted) return;
    const action = actionFor(event);
    if (!action) return;
    event.preventDefault();
    event.stopImmediatePropagation();
    const key = event.code || event.key.toLowerCase();
    if (event.repeat || heldKeys.has(key)) return;
    heldKeys.add(key);
    void perform(action);
  }, true);

  window.addEventListener("keyup", (event) => {
    if (!event.isTrusted) return;
    const held = heldKeys.delete(event.code || event.key.toLowerCase());
    if (held || actionFor(event)) {
      event.preventDefault();
      event.stopImmediatePropagation();
    }
    if (event.key === "Meta") heldKeys.clear();
  }, true);
  window.addEventListener("blur", () => heldKeys.clear());
})();
