// ==UserScript==
// @name         ChatGPT Fast Exact Plain-Text Paste
// @namespace    chatgpt-fast-exact-paste
// @version      1.0.0
// @description  Fast long-text paste for ChatGPT. Prevents attachment conversion and preserves exact line breaks as plain text.
// @match        https://chatgpt.com/*
// @match        https://chat.openai.com/*
// @grant        none
// @run-at       document-start
// ==/UserScript==

(() => {
    "use strict";

    /*
     * ============================================================
     * Configuration
     * ============================================================
     */

    // 只干预较长文本。
    // 短文本继续交给 ChatGPT 原生处理。
    const LONG_TEXT_THRESHOLD = 8000;

    /*
     * true:
     *   所有超过阈值的纯文本粘贴都由本脚本处理。
     *
     * false:
     *   可以自行进一步限制。
     */
    const ENABLE_LONG_TEXT_INTERCEPT = true;


    /*
     * ChatGPT composer selectors.
     */
    const COMPOSER_SELECTOR = [
        '#prompt-textarea[contenteditable="true"]',
        '#prompt-textarea[contenteditable="plaintext-only"]',
        '.ProseMirror[contenteditable="true"][role="textbox"]',
        '[contenteditable="true"][data-virtualkeyboard="true"]'
    ].join(",");


    /*
     * ============================================================
     * Clipboard helpers
     * ============================================================
     */

    function clipboardHasFile(data) {
        if (!data) {
            return false;
        }

        if (data.files && data.files.length > 0) {
            return true;
        }

        if (data.items) {
            for (const item of data.items) {
                if (item.kind === "file") {
                    return true;
                }
            }
        }

        return false;
    }


    function findComposer(target) {
        if (!(target instanceof Element)) {
            return null;
        }

        return target.closest(COMPOSER_SELECTOR);
    }


    /*
     * ============================================================
     * Text normalization
     * ============================================================
     *
     * Windows:
     *   \r\n
     *
     * Old Mac:
     *   \r
     *
     * Unix:
     *   \n
     *
     * 全部统一成 \n。
     *
     * 注意：
     * 这不会改变行数。
     * 它只是统一换行符编码。
     */

    function normalizeNewlines(text) {
        return text.replace(/\r\n?/g, "\n");
    }


    /*
     * ============================================================
     * Build exact plain-text fragment
     * ============================================================
     *
     * 关键：
     *
     * 不使用 innerHTML 拼接用户内容。
     * 不解析 Markdown。
     * 不创建 <p>。
     *
     * 每一行都是普通 TextNode。
     * 每一个 \n 都对应一个明确的 <br>。
     *
     *
     * 输入：
     *
     *   A\nB\n\nD
     *
     *
     * DOM：
     *
     *   Text("A")
     *   <br>
     *   Text("B")
     *   <br>
     *   <br>
     *   Text("D")
     *
     *
     * 因而：
     *
     *   一个 newline = 一个换行
     *   两个 newline = 两个换行
     *
     * 不依赖浏览器猜测。
     */

    function buildPlainTextFragment(text) {
        const fragment = document.createDocumentFragment();

        const normalized = normalizeNewlines(text);
        const lines = normalized.split("\n");

        for (let i = 0; i < lines.length; i++) {

            /*
             * 即便这一行为空，也不要删除。
             *
             * 空行由相邻的 <br> 保留下来。
             */
            if (lines[i].length > 0) {
                fragment.appendChild(
                    document.createTextNode(lines[i])
                );
            }

            /*
             * 最后一行后面只有原文本确实存在 newline
             * 才会出现对应 <br>。
             *
             * split("\n") 会自然保留 trailing empty item。
             */
            if (i < lines.length - 1) {
                fragment.appendChild(
                    document.createElement("br")
                );
            }
        }

        return fragment;
    }


    /*
     * ============================================================
     * Selection helpers
     * ============================================================
     */

    function selectionBelongsToEditor(selection, editor) {
        if (
            !selection ||
            selection.rangeCount === 0
        ) {
            return false;
        }

        const range = selection.getRangeAt(0);

        return (
            editor === range.commonAncestorContainer ||
            editor.contains(range.commonAncestorContainer)
        );
    }


    function createRangeAtEnd(editor) {
        const range = document.createRange();

        range.selectNodeContents(editor);
        range.collapse(false);

        return range;
    }


    /*
     * ============================================================
     * One-shot insertion
     * ============================================================
     */

    function insertExactPlainText(editor, text) {
        editor.focus({
            preventScroll: true
        });


        let selection = window.getSelection();

        if (!selection) {
            return false;
        }


        let range;

        if (
            selectionBelongsToEditor(
                selection,
                editor
            )
        ) {

            range = selection.getRangeAt(0);

        } else {

            /*
             * 找不到有效 caret 时，
             * 插到输入框末尾。
             */
            range = createRangeAtEnd(editor);

            selection.removeAllRanges();
            selection.addRange(range);
        }


        /*
         * 替换当前选中的内容。
         */
        if (!range.collapsed) {
            range.deleteContents();
        }


        /*
         * 一次创建整个 fragment。
         *
         * 注意：
         *
         * 我们不是：
         *
         *   插一行
         *   event
         *   插一行
         *   event
         *   ...
         *
         * 而是：
         *
         *   构造 fragment
         *          ↓
         *   一次 insertNode()
         *
         * 浏览器只需要完成一次主要 DOM 插入。
         */
        const fragment =
            buildPlainTextFragment(text);


        /*
         * 为了恢复 caret，
         * 放一个临时 marker。
         */
        const marker =
            document.createTextNode("");

        fragment.appendChild(marker);


        /*
         * 一次 DOM 操作。
         */
        range.insertNode(fragment);


        /*
         * caret 移到插入内容之后。
         */
        const newRange =
            document.createRange();

        newRange.setStartAfter(marker);
        newRange.collapse(true);

        selection.removeAllRanges();
        selection.addRange(newRange);


        /*
         * marker 没有实际文本，可以安全移除。
         */
        marker.remove();


        /*
         * ========================================================
         * 只通知编辑器一次。
         * ========================================================
         */

        try {
            editor.dispatchEvent(
                new InputEvent("input", {
                    bubbles: true,
                    composed: true,
                    cancelable: false,
                    inputType: "insertFromPaste",
                    data: null
                })
            );
        } catch (_) {
            editor.dispatchEvent(
                new Event("input", {
                    bubbles: true,
                    composed: true
                })
            );
        }


        return true;
    }


    /*
     * ============================================================
     * Paste handler
     * ============================================================
     */

    function handlePaste(event) {
        if (!ENABLE_LONG_TEXT_INTERCEPT) {
            return;
        }


        const data = event.clipboardData;

        if (!data) {
            return;
        }


        /*
         * 图片 / 截图 / PDF / 文件：
         *
         * 完全不碰。
         *
         * 继续使用 ChatGPT 原生上传。
         */
        if (clipboardHasFile(data)) {
            return;
        }


        const editor =
            findComposer(event.target);

        if (!editor) {
            return;
        }


        const text =
            data.getData("text/plain");

        if (!text) {
            return;
        }


        /*
         * 短文本继续使用官方 paste。
         */
        if (text.length < LONG_TEXT_THRESHOLD) {
            return;
        }


        /*
         * ========================================================
         * 阻止 ChatGPT：
         *
         *   long text
         *       ↓
         *   Pasted text
         *       ↓
         *   attachment
         *
         * ========================================================
         */

        event.preventDefault();
        event.stopImmediatePropagation();


        /*
         * 一次性插入。
         */
        insertExactPlainText(
            editor,
            text
        );
    }


    /*
     * Capture phase：
     *
     * 抢在 ChatGPT long-paste handler 前面。
     */
    window.addEventListener(
        "paste",
        handlePaste,
        {
            capture: true,
            passive: false
        }
    );


    /*
     * Debug
     */
    window.chatgptExactPaste = Object.freeze({
        version: "1.0.0",
        threshold: LONG_TEXT_THRESHOLD
    });


    console.log(
        "[ChatGPT Fast Exact Plain-Text Paste] enabled"
    );

})();
