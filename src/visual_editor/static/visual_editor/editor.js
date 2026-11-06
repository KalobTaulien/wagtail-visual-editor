/*
 * Visual editor for Wagtail pages (prototype).
 *
 * The browser owns the editing state (page fields + raw StreamField JSON). Every
 * change re-renders the page server-side. Usually only the blocks whose HTML
 * changed are patched into the live canvas (see patchCanvas), so nothing reloads
 * or scrolls; structural changes render into a hidden second iframe that is
 * "instrumented" (see instrumentDocument) and swapped in at the same scroll spot.
 *
 * - Text values arrive wrapped in Private Use Area markers; they become
 *   contenteditable regions mapped to a path in the state.
 * - Top-level stream blocks arrive bracketed by <template data-ve-start/end>;
 *   their elements get `data-ve-block` so clicks select the block.
 * - The inspector shows Wagtail's own block widgets for the selected block, and
 *   posts them back to the server to convert into raw JSON.
 */
(() => {
    'use strict';

    const config = JSON.parse(document.getElementById('ve-config').textContent);
    const wagtailConfig = JSON.parse(document.getElementById('wagtail-config').textContent);

    // Markers live in Supplementary Private Use Area-A (see instrument.py), clear of icon fonts.
    const MARKER = /[\u{F0000}-\u{F00FF}]/u;
    const MARKERS = /[\u{F0000}-\u{F00FF}]/gu;
    const DIGIT_ZERO = 0xf0010;
    const BLOCK_PREFIX = 've-block';

    const $ = (selector, root = document) => root.querySelector(selector);
    const $$ = (selector, root = document) => [...root.querySelectorAll(selector)];

    const el = {
        app: $('.ve-app'),
        frames: $$('.ve-frame'),
        loading: $('[data-ve-loading]'),
        outline: $('[data-ve-outline]'),
        pageTitle: $('[data-ve-page-title]'),
        statusChip: $('[data-ve-status-chip]'),
        saveState: $('[data-ve-save-state]'),
        liveLink: $('[data-ve-live-link]'),
        undo: $('[data-ve-undo]'),
        redo: $('[data-ve-redo]'),
        save: $('[data-ve-save]'),
        publish: $('[data-ve-publish]'),
        tabs: $$('[data-ve-tab]'),
        panels: $$('[data-ve-panel]'),
        problems: $('[data-ve-problems]'),
        blockEmpty: $('[data-ve-block-empty]'),
        blockInspector: $('[data-ve-block-inspector]'),
        blockIcon: $('[data-ve-block-icon]'),
        blockLabel: $('[data-ve-block-label]'),
        blockStream: $('[data-ve-block-stream]'),
        blockErrors: $('[data-ve-block-errors]'),
        blockForm: $('[data-ve-block-form]'),
        pageErrors: $('[data-ve-page-errors]'),
        snippetInspector: $('[data-ve-snippet-inspector]'),
        snippetTitle: $('[data-ve-snippet-title]'),
        snippetLabel: $('[data-ve-snippet-label]'),
        snippetNotice: $('[data-ve-snippet-notice]'),
        snippetOwner: $('[data-ve-snippet-owner]'),
        snippetEditLink: $('[data-ve-snippet-edit-link]'),
        snippetErrors: $('[data-ve-snippet-errors]'),
        snippetForm: $('[data-ve-snippet-form]'),
        pageForm: $('[data-ve-page-form]'),
        addMenu: $('[data-ve-add-menu]'),
        addSearch: $('[data-ve-add-search]'),
        addList: $('[data-ve-add-list]'),
        toasts: $('[data-ve-toasts]'),
    };

    // ------------------------------------------------------------------
    // State
    // ------------------------------------------------------------------

    let state = config.state;
    let status = config.status;
    let baseRevisionId = status.latestRevisionId;
    let selection = null; // {stream, id}
    let selectedSnippet = null; // a key of state.snippets / snippetMeta
    let activeTab = 'block';
    let dirty = false;
    let errors = { streams: {}, fields: {}, snippets: {} };
    let changeCounter = 0;

    const streamMeta = Object.fromEntries(config.streams.map((stream) => [stream.name, stream]));

    const history = { past: [], future: [], current: JSON.stringify(state), lastKey: null, lastTime: 0 };

    function blocksOf(stream) {
        if (!state.streams[stream]) state.streams[stream] = [];
        return state.streams[stream];
    }

    function findBlock(stream, id) {
        const blocks = state.streams[stream] || [];
        const index = blocks.findIndex((block) => block.id === id);
        return index === -1 ? null : { block: blocks[index], index, blocks };
    }

    function blockTypeMeta(stream, type) {
        const meta = streamMeta[stream];
        return (meta && meta.blockTypes.find((blockType) => blockType.name === type)) || { name: type, label: type, icon: 'placeholder' };
    }

    function uuid() {
        return crypto.randomUUID ? crypto.randomUUID() : 'xxxxxxxx-xxxx-4xxx-yxxx-xxxxxxxxxxxx'.replace(/[xy]/g, (c) => {
            const r = (Math.random() * 16) | 0;
            return (c === 'x' ? r : (r & 0x3) | 0x8).toString(16);
        });
    }

    /** Walk a state path like ["streams", "content", "#<id>", "value", "title"] and set the leaf. */
    function setAtPath(path, value) {
        if (path[0] === 'snippets') {
            // Snippet edits are kept sparse: only snippets (and fields) that were edited.
            state.snippets = state.snippets || {};
            state.snippets[path[1]] = state.snippets[path[1]] || {};
        }
        let node = state;
        for (let i = 0; i < path.length - 1; i += 1) {
            node = step(node, path[i]);
            if (node == null) return false;
        }
        const last = path[path.length - 1];
        if (Array.isArray(node) && last.startsWith('#')) return false;
        node[last] = value;
        return true;
    }

    function step(node, segment) {
        if (node == null) return null;
        if (segment.startsWith('#') && Array.isArray(node)) {
            const id = segment.slice(1);
            return node.find((item) => item && item.id === id) || null;
        }
        return node[segment];
    }

    /** Give a copied value fresh ids, so duplicated blocks don't share list/stream item ids. */
    function withFreshIds(value) {
        if (Array.isArray(value)) return value.map(withFreshIds);
        if (value && typeof value === 'object') {
            const copy = {};
            Object.entries(value).forEach(([key, child]) => {
                copy[key] = withFreshIds(child);
            });
            if ('id' in copy && 'type' in copy && 'value' in copy) copy.id = uuid();
            return copy;
        }
        return value;
    }

    /** A short human summary of a block's raw value, for the outline. */
    function snippet(value) {
        const seen = [];
        const visit = (node) => {
            if (seen.length) return;
            if (typeof node === 'string') {
                const text = node.replace(/<[^>]+>/g, ' ').replace(/\s+/g, ' ').trim();
                if (text && !/^(https?:|mailto:|#|\/)/.test(text) && !/^[0-9a-f-]{36}$/.test(text) && text.length > 1) seen.push(text);
            } else if (Array.isArray(node)) {
                node.forEach(visit);
            } else if (node && typeof node === 'object') {
                Object.entries(node).forEach(([key, child]) => {
                    if (key !== 'id' && key !== 'type') visit(child);
                });
            }
        };
        visit(value);
        return seen[0] || '';
    }

    // ------------------------------------------------------------------
    // Server calls
    // ------------------------------------------------------------------

    function csrfHeaders() {
        return { [wagtailConfig.CSRF_HEADER_NAME]: wagtailConfig.CSRF_TOKEN };
    }

    async function request(url, options) {
        const response = await fetch(url, { credentials: 'same-origin', ...options });
        let data = {};
        try {
            data = await response.json();
        } catch (e) {
            data = { message: `The server responded with ${response.status}.` };
        }
        return { ok: response.ok, status: response.status, data };
    }

    function postJSON(url, body) {
        return request(url, {
            method: 'POST',
            headers: { 'Content-Type': 'application/json', ...csrfHeaders() },
            body: JSON.stringify(body),
        });
    }

    function postForm(url, formData) {
        return request(url, { method: 'POST', headers: csrfHeaders(), body: formData });
    }

    // ------------------------------------------------------------------
    // Changes, history, dirty state
    // ------------------------------------------------------------------

    /**
     * Record a change to `state`.
     * coalesce: changes with the same key within 1.5s share one undo step (typing).
     */
    function commit({ render = true, renderDelay = 120, coalesce = null } = {}) {
        changeCounter += 1;
        recordHistory(coalesce);
        setDirty(true);
        renderOutline();
        if (render) scheduleRender(renderDelay);
    }

    function recordHistory(coalesceKey) {
        const snapshot = JSON.stringify(state);
        if (snapshot === history.current) return;
        const now = Date.now();
        const coalesced = coalesceKey && coalesceKey === history.lastKey && now - history.lastTime < 1500;
        if (!coalesced) {
            history.past.push(history.current);
            if (history.past.length > 200) history.past.shift();
        }
        history.current = snapshot;
        history.future = [];
        history.lastKey = coalesceKey;
        history.lastTime = now;
        updateHistoryButtons();
    }

    function undo() {
        if (!history.past.length) return;
        history.future.push(history.current);
        history.current = history.past.pop();
        restoreSnapshot();
    }

    function redo() {
        if (!history.future.length) return;
        history.past.push(history.current);
        history.current = history.future.pop();
        restoreSnapshot();
    }

    function restoreSnapshot() {
        state = JSON.parse(history.current);
        history.lastKey = null;
        changeCounter += 1;
        if (selection && !findBlock(selection.stream, selection.id)) selection = null;
        setDirty(true);
        updateHistoryButtons();
        renderOutline();
        scheduleRender(0);
        refreshInspector();
    }

    function updateHistoryButtons() {
        el.undo.disabled = !history.past.length;
        el.redo.disabled = !history.future.length;
    }

    function setDirty(value) {
        dirty = value;
        el.saveState.textContent = dirty ? 'Unsaved changes' : 'All changes saved';
        el.saveState.classList.toggle('ve-save-state--dirty', dirty);
    }

    function updateStatus() {
        let label = 'Draft';
        let modifier = 'draft';
        if (status.live && status.hasUnpublishedChanges) {
            label = 'Live + draft';
        } else if (status.live) {
            label = 'Live';
            modifier = 'live';
        }
        el.statusChip.textContent = label;
        el.statusChip.className = `ve-chip ve-chip--${modifier}`;
        el.liveLink.hidden = !(status.live && status.liveUrl);
        if (status.liveUrl) el.liveLink.href = status.liveUrl;
        const title = state.fields && state.fields.title;
        if (title) el.pageTitle.textContent = title;
    }

    // ------------------------------------------------------------------
    // Preview rendering
    //
    // Most changes are patched into the live canvas document: only the blocks
    // (and page-level text) whose rendered HTML changed are replaced, so the
    // page doesn't reload or move. Structural changes fall back to rendering
    // into the hidden second iframe and swapping it in.
    // ------------------------------------------------------------------

    let front = 0;
    let renderTimer = null;
    let renderInFlight = false;
    let renderQueued = false;
    let renderSeq = 0;
    let renderSkippedWhileTyping = false;
    let pendingScrollTo = null;
    let lastRender = null; // snapshot of the render currently on the canvas
    let snippetMeta = {}; // the snippets on the canvas, keyed like state.snippets (from the last render)
    // Page settings fields changed since the last render, to point out ones the template doesn't show.
    let pendingFieldChanges = new Set();
    const fieldsExplained = new Set();

    function frontFrame() {
        return el.frames[front];
    }

    function frontDoc() {
        const frame = frontFrame();
        return frame && frame.contentDocument;
    }

    function scheduleRender(delay = 120) {
        clearTimeout(renderTimer);
        renderTimer = setTimeout(renderPreview, delay);
    }

    async function renderPreview() {
        if (renderInFlight) {
            renderQueued = true;
            return;
        }
        renderInFlight = true;
        const seq = ++renderSeq;
        const loadingTimer = setTimeout(() => el.loading.classList.add('is-visible'), 250);
        const changedFields = [...pendingFieldChanges];
        pendingFieldChanges = new Set();
        let shown = false;
        try {
            const { ok, data } = await postJSON(config.urls.render, { state });
            if (!ok) throw new Error(data.message || 'The preview could not be rendered.');
            if (renderQueued) return; // a newer state is waiting; don't bother showing this one
            if (isTypingInCanvas()) {
                // Replacing the canvas now would throw away the caret; render again on blur.
                renderSkippedWhileTyping = true;
                return;
            }
            const next = snapshotRender(data.html, data.registry);
            const patched = patchCanvas(next);
            if (!patched) {
                await swapIn(data.html, data.registry, seq);
            }
            lastRender = next;
            snippetMeta = data.snippets || {};
            renderSnippetHeader();
            refreshSpacingPanel();
            shown = true;
            if (patched === 'unchanged') explainInvisibleFields(changedFields);
            if (data.status >= 400) toast(`The page template returned an error (${data.status}).`, 'error');
        } catch (error) {
            toast(`Preview failed to update: ${error.message}`, 'error');
        } finally {
            // A render that never reached the canvas leaves its field changes for the next one.
            if (!shown) changedFields.forEach((name) => pendingFieldChanges.add(name));
            clearTimeout(loadingTimer);
            el.loading.classList.remove('is-visible');
            renderInFlight = false;
            if (renderQueued) {
                renderQueued = false;
                renderPreview();
            }
        }
    }

    // ---- Snapshots: what a render looks like, in comparable pieces ----

    /** Collapse formatting whitespace so serialisations compare on content. */
    function squash(html) {
        return html.replace(/>\s+/g, '>').replace(/\s+</g, '<').replace(/\s+/g, ' ');
    }

    /** Values that legitimately differ on every render and must not count as changes. */
    function scrubVolatile(root) {
        // CSRF tokens are re-masked on every render (form inputs, and e.g. Marketo blocks' `data-csrf-token`).
        $$('input[name="csrfmiddlewaretoken"]', root).forEach((node) => node.removeAttribute('value'));
        [root, ...$$('*', root)].forEach((node) => {
            [...node.attributes].forEach((attribute) => {
                if (attribute.name.includes('csrf')) node.removeAttribute(attribute.name);
            });
        });
        $$('noscript', root).forEach((node) => node.remove());
        const walker = root.ownerDocument.createTreeWalker(root, NodeFilter.SHOW_COMMENT);
        const comments = [];
        for (let node = walker.nextNode(); node; node = walker.nextNode()) comments.push(node);
        comments.forEach((node) => node.remove());
    }

    /**
     * Group block elements into runs of adjacent siblings (a stream rendered in a
     * loop). Returns null if a block's elements aren't contiguous, which we can't patch.
     */
    function findRuns(body) {
        const runs = [];
        const seen = new Set();
        const runOfKey = new Map();
        for (const first of $$('[data-ve-block]', body)) {
            if (seen.has(first)) continue;
            const run = { keys: [], nodes: new Map() };
            for (let node = first; node; node = node.nextSibling) {
                if (node.nodeType === 3 && node.data.trim()) break;
                if (node.nodeType !== 1) continue;
                if (!node.hasAttribute('data-ve-block')) break;
                const key = node.dataset.veBlock;
                if (runOfKey.has(key) && runOfKey.get(key) !== run) return null;
                runOfKey.set(key, run);
                seen.add(node);
                if (!run.nodes.has(key)) {
                    run.keys.push(key);
                    run.nodes.set(key, []);
                }
                run.nodes.get(key).push(node);
            }
            runs.push(run);
        }
        return runs;
    }

    /**
     * Parse and instrument a render off-screen, then break it into:
     * - skeleton: everything that isn't a block or page-level text, which must match to patch;
     * - blockHtml: each block's HTML, to find the blocks that changed;
     * - fieldHtml: page-level text (title, description, ...) outside blocks.
     */
    function snapshotRender(html, registry) {
        const doc = new DOMParser().parseFromString(html, 'text/html');
        tagRich(doc, registry);
        tagBlocks(doc);
        tagText(doc, registry);
        tagSnippets(doc);
        stripMarkers(doc);

        const entries = entriesFrom(registry);
        const runs = findRuns(doc.body);
        if (!runs) return { doc, entries, runs: null };

        runs.forEach((run) => {
            run.keys.forEach((key, keyIndex) => {
                run.nodes.get(key).forEach((node, nodeIndex) => {
                    node.setAttribute('data-ve-run', String(keyIndex === 0 && nodeIndex === 0));
                });
            });
        });
        const clone = doc.body.cloneNode(true);
        $$('[data-ve-run]', doc.body).forEach((node) => node.removeAttribute('data-ve-run'));
        scrubVolatile(clone);

        const blockHtml = new Map();
        $$('[data-ve-run]', clone).forEach((node) => {
            const isFirst = node.getAttribute('data-ve-run') === 'true';
            node.removeAttribute('data-ve-run');
            const key = node.dataset.veBlock;
            blockHtml.set(key, (blockHtml.get(key) || '') + squash(node.outerHTML));
            if (isFirst) node.replaceWith(doc.createElement('ve-run'));
            else node.remove();
        });

        const fieldHtml = new Map();
        // Text and rich text outside blocks (page fields, snippets like a blog post's author).
        $$('[data-ve-text], [data-ve-rich]', clone).forEach((node) => {
            const key = node.dataset.veText || node.dataset.veRich;
            if (!fieldHtml.has(key)) fieldHtml.set(key, node.innerHTML);
            node.innerHTML = '';
        });

        const bodyAttributes = [...doc.body.attributes].map((attribute) => `${attribute.name}="${attribute.value}"`).join(' ');
        return { doc, entries, runs, blockHtml, fieldHtml, skeleton: squash(`${bodyAttributes}|${clone.innerHTML}`) };
    }

    /**
     * A block's structure with our own edits factored out: editor attributes,
     * and the text the editor may have typed inline. If the live canvas differs
     * from the render on this, the page's JavaScript has rewritten the block
     * (a carousel, tabs, ...) and a patched-in copy would come up uninitialised.
     */
    const EDITOR_ATTRIBUTES = ['contenteditable', 'spellcheck', 'data-ve-readonly', 'data-ve-selected', 'data-ve-hover', 'data-ve-error'];

    /** Undo a spacing drag's live preview in a copy of a block (see startSpacingDrag). */
    function withoutSpacingPreview(root) {
        [root, ...$$('[data-ve-spacing-preview]', root)].forEach((node) => {
            if (!node.hasAttribute || !node.hasAttribute('data-ve-spacing-preview')) return;
            const original = node.getAttribute('data-ve-spacing-preview');
            if (original) node.setAttribute('style', original);
            else node.removeAttribute('style');
            node.removeAttribute('data-ve-spacing-preview');
        });
    }

    function structureOf(nodes) {
        return nodes
            .map((node) => {
                const clone = node.cloneNode(true);
                withoutSpacingPreview(clone);
                [clone, ...$$('*', clone)].forEach((child) => EDITOR_ATTRIBUTES.forEach((name) => child.removeAttribute(name)));
                // Whether a <details> is open is the editor's doing (opening an FAQ answer), not the page's.
                [clone, ...$$('details', clone)].forEach((child) => child.matches('details') && child.removeAttribute('open'));
                $$('[data-ve-text], [data-ve-rich]', clone).forEach((child) => {
                    child.innerHTML = '';
                });
                if (clone.matches('[data-ve-text], [data-ve-rich]')) clone.innerHTML = '';
                scrubVolatile(clone);
                return squash(clone.outerHTML);
            })
            .join('');
    }

    // ---- In-place patching ----

    function liveBlockNodes(doc, key) {
        return $$(`[data-ve-block="${CSS.escape(key)}"]`, doc);
    }

    function nextNonWhitespace(node) {
        let sibling = node.nextSibling;
        while (sibling && (sibling.nodeType === 8 || (sibling.nodeType === 3 && !sibling.data.trim()))) sibling = sibling.nextSibling;
        return sibling;
    }

    /** Bring a block from an off-screen render into the canvas document, with its scripts runnable. */
    function adoptNode(doc, node) {
        const adopted = doc.importNode(node, true);
        const scripts = adopted.matches('script') ? [adopted] : $$('script', adopted);
        scripts.forEach((old) => {
            const script = doc.createElement('script');
            [...old.attributes].forEach((attribute) => script.setAttribute(attribute.name, attribute.value));
            script.textContent = old.textContent;
            if (old === adopted) return;
            old.replaceWith(script);
        });
        prepareEditable(adopted);
        return adopted;
    }

    /**
     * A Page settings change that left the canvas untouched is a field this
     * template doesn't display (e.g. a page's main "Image", used for listings
     * and sharing). Say so once per field, rather than looking broken.
     */
    function explainInvisibleFields(names) {
        // Page fields are plain names; snippet fields are "snippet|<key>|<name>".
        const fresh = names.filter((name) => !fieldsExplained.has(name));
        fresh.forEach((name) => fieldsExplained.add(name));
        const labelFor = (form, name) => {
            const label = $(`[data-field-name="${CSS.escape(name)}"] label`, form);
            return `“${label ? label.textContent.replace('*', '').trim() : name}”`;
        };
        const subjectFor = (labels) => (labels.length === 1 ? `${labels[0]} isn’t` : `${labels.join(', ')} aren’t`);

        const pageLabels = fresh.filter((name) => !name.startsWith('snippet|')).map((name) => labelFor(el.pageForm, name));
        if (pageLabels.length) {
            toast(`${subjectFor(pageLabels)} shown by this page’s template, so the preview won’t change. It’s still saved with the page, and may be used in listings or when shared.`, 'info');
        }
        const snippetLabels = fresh.filter((name) => name.startsWith('snippet|')).map((name) => labelFor(el.snippetForm, name.split('|')[2]));
        if (snippetLabels.length) {
            toast(`${subjectFor(snippetLabels)} shown by this page’s template, so the preview won’t change. It’s still saved with the snippet, and may show on other pages that use it.`, 'info');
        }
    }

    /**
     * Apply `next` to the live canvas by replacing only what changed. Returns
     * 'patched', 'unchanged' (nothing on the page differed), or false (having
     * changed nothing) when a full document swap is needed.
     */
    function patchCanvas(next) {
        const prev = lastRender;
        const doc = frontDoc();
        if (!prev || !prev.runs || !next.runs || !doc || !doc.body || prev.skeleton !== next.skeleton) return false;

        // Plan everything before touching the DOM, so a bail-out leaves the canvas intact.
        const plans = [];
        for (let i = 0; i < next.runs.length; i += 1) {
            const oldRun = prev.runs[i];
            const newRun = next.runs[i];
            const live = oldRun.keys.map((key) => liveBlockNodes(doc, key));
            if (live.some((nodes) => !nodes.length)) return false;
            const liveAll = live.flat();
            const parent = liveAll[0].parentNode;
            if (liveAll.some((node) => node.parentNode !== parent)) return false;

            const liveByKey = new Map(oldRun.keys.map((key, index) => [key, live[index]]));
            const items = [];
            for (const key of newRun.keys) {
                const unchanged = prev.blockHtml.get(key) === next.blockHtml.get(key);
                if (unchanged && liveByKey.has(key)) {
                    items.push({ key, reuse: liveByKey.get(key) });
                    continue;
                }
                // New blocks, and blocks the page's scripts have rewritten, need a fresh document.
                if (!liveByKey.has(key)) return false;
                const rendered = prev.runs[i].nodes.get(key);
                if (structureOf(liveByKey.get(key)) !== structureOf(rendered)) return false;
                items.push({ key, replace: newRun.nodes.get(key) });
            }
            const keptKeys = new Set(newRun.keys);
            const removed = oldRun.keys.filter((key) => !keptKeys.has(key)).flatMap((key) => liveByKey.get(key));
            const changedOrder = newRun.keys.join() !== oldRun.keys.filter((key) => keptKeys.has(key)).join();
            if (!removed.length && !changedOrder && items.every((item) => item.reuse)) continue;
            plans.push({ parent, after: nextNonWhitespace(liveAll[liveAll.length - 1]), items, removed, liveByKey });
        }

        const fieldChanges = [...next.fieldHtml].filter(([key, html]) => prev.fieldHtml.get(key) !== html);
        const unchanged = !plans.length && !fieldChanges.length;
        // Adopted nodes are checked against these to decide what's editable in place.
        textEntries = next.entries;

        plans.forEach(({ parent, after, items, removed, liveByKey }) => {
            items.forEach((item) => {
                if (item.replace) {
                    const old = liveByKey.get(item.key);
                    item.nodes = item.replace.map((node) => adoptNode(doc, node));
                    restoreOpenDetails(item.nodes, openDetails(old));
                    removed.push(...old);
                } else {
                    item.nodes = item.reuse;
                }
            });
            removed.forEach((node) => node.remove());
            // Insert back to front, leaving nodes that are already in place alone
            // (moving an element reloads any iframe embed inside it).
            let ref = after && after.parentNode === parent ? after : null;
            items
                .flatMap((item) => item.nodes)
                .reverse()
                .forEach((node) => {
                    if (node.parentNode !== parent || nextNonWhitespace(node) !== ref) parent.insertBefore(node, ref);
                    ref = node;
                });
        });

        const active = doc.activeElement;
        fieldChanges.forEach(([key, html]) => {
            $$('[data-ve-text], [data-ve-rich]', doc.body)
                .filter((node) => (node.dataset.veText || node.dataset.veRich) === key && !node.closest('[data-ve-block]') && node !== active)
                .forEach((node) => {
                    node.innerHTML = html;
                    prepareEditable(node);
                });
        });

        if (doc.title !== next.doc.title) doc.title = next.doc.title;
        applyHighlights();
        if (pendingScrollTo) {
            scrollBlockIntoView(pendingScrollTo);
            pendingScrollTo = null;
        }
        return unchanged ? 'unchanged' : 'patched';
    }

    // ---- Keeping <details> open across re-renders ----

    function detailsIn(nodes) {
        return nodes.flatMap((node) => (node.matches('details') ? [node, ...$$('details', node)] : $$('details', node)));
    }

    /** Which <details> (by position) among these nodes are open. */
    function openDetails(nodes) {
        return detailsIn(nodes).map((details, index) => (details.open ? index : -1)).filter((index) => index >= 0);
    }

    function restoreOpenDetails(nodes, openIndexes) {
        const all = detailsIn(nodes);
        openIndexes.forEach((index) => {
            if (all[index]) all[index].open = true;
        });
    }

    /** Re-open in a new document the <details> that are open in the old one: per block, then the rest by position. */
    function carryOpenDetails(fromDoc, toDoc) {
        if (!fromDoc || !fromDoc.body) return;
        const keys = new Set($$('[data-ve-block]', fromDoc.body).map((node) => node.dataset.veBlock));
        keys.forEach((key) => {
            const open = openDetails(liveBlockNodes(fromDoc, key));
            if (open.length) restoreOpenDetails(liveBlockNodes(toDoc, key), open);
        });
        const outside = (doc) => $$('details', doc.body).filter((details) => !details.closest('[data-ve-block]'));
        const toOutside = outside(toDoc);
        outside(fromDoc).forEach((details, index) => {
            if (details.open && toOutside[index]) toOutside[index].open = true;
        });
    }

    // ---- Full document swap (structural changes) ----

    /** The block or text nearest the top of the viewport, and where it sits, so a new document can line up with it. */
    function scrollAnchor(doc) {
        const win = doc && doc.defaultView;
        if (!win) return null;
        const candidates = $$('[data-ve-block], [data-ve-text]', doc.body);
        let best = null;
        for (const node of candidates) {
            const rect = node.getBoundingClientRect();
            if (rect.height && rect.bottom > 0 && (!best || rect.top < best.top) && rect.top > -rect.height) {
                best = { node, top: rect.top };
                if (rect.top >= 0) break;
            }
        }
        if (!best) return { scrollY: win.scrollY };
        const attribute = best.node.hasAttribute('data-ve-block') ? 'data-ve-block' : 'data-ve-text';
        const value = best.node.getAttribute(attribute);
        const index = $$(`[${attribute}]`, doc.body).filter((node) => node.getAttribute(attribute) === value).indexOf(best.node);
        return { scrollY: win.scrollY, attribute, value, index, top: best.top };
    }

    function restoreScroll(doc, anchor) {
        const win = doc.defaultView;
        if (!anchor) return;
        win.scrollTo(0, anchor.scrollY);
        if (!anchor.attribute) return;
        const node = $$(`[${anchor.attribute}]`, doc.body).filter((candidate) => candidate.getAttribute(anchor.attribute) === anchor.value)[anchor.index];
        if (node) win.scrollBy(0, node.getBoundingClientRect().top - anchor.top);
    }

    function swapIn(html, registry, seq) {
        const back = el.frames[1 - front];
        const current = el.frames[front];
        const marker = `ve-render-${seq}`;
        // Tag the document so we can tell when the iframe has really switched to it.
        const tagged = /<head[^>]*>/i.test(html)
            ? html.replace(/<head([^>]*)>/i, `<head$1><meta name="ve-render" content="${marker}">`)
            : `<meta name="ve-render" content="${marker}">${html}`;

        return new Promise((resolve) => {
            back.srcdoc = tagged;
            const started = Date.now();
            let instrumented = false;
            const poll = () => {
                const doc = back.contentDocument;
                const parsed = doc && doc.readyState !== 'loading' && doc.body && doc.querySelector(`meta[name="ve-render"][content="${marker}"]`);
                if (parsed && !instrumented) {
                    instrumentDocument(doc, registry);
                    instrumented = true;
                }
                // Wait for images etc. so the page has its final height before we line
                // up the scroll position, but don't let a slow third-party script stall us.
                const settled = parsed && (doc.readyState === 'complete' || Date.now() - started > 1500);
                if (!settled) {
                    if (Date.now() - started > 20000) {
                        toast('The preview took too long to load.', 'error');
                        resolve();
                    } else {
                        setTimeout(poll, 20);
                    }
                    return;
                }

                carryOpenDetails(current.contentDocument, doc);
                const anchor = scrollAnchor(current.contentDocument);
                restoreScroll(doc, anchor);
                textEntries = entriesFrom(registry);

                back.classList.add('is-front');
                back.removeAttribute('aria-hidden');
                back.removeAttribute('tabindex');
                current.classList.remove('is-front');
                current.setAttribute('aria-hidden', 'true');
                current.setAttribute('tabindex', '-1');
                front = 1 - front;

                applyHighlights();
                if (pendingScrollTo) {
                    scrollBlockIntoView(pendingScrollTo);
                    pendingScrollTo = null;
                }
                // Stop the old document's scripts and media from running in the background.
                setTimeout(() => {
                    if (el.frames[front] !== current) current.srcdoc = '<!doctype html><title></title>';
                }, 50);
                resolve();
            };
            poll();
        });
    }

    // ------------------------------------------------------------------
    // Canvas instrumentation
    // ------------------------------------------------------------------

    /** Text values on the canvas, keyed by their JSON state path (the `data-ve-text` attribute). */
    let textEntries = new Map();

    function entriesFrom(registry) {
        return new Map(registry.map((entry) => [JSON.stringify(entry.path), entry]));
    }

    function entryFor(node) {
        return textEntries.get(node.dataset.veText || node.dataset.veRich);
    }

    function normalise(text) {
        return (text || '').replace(MARKERS, '').replace(/\s+/g, ' ').trim();
    }

    function instrumentDocument(doc, registry) {
        textEntries = entriesFrom(registry);
        tagRich(doc, registry);
        tagBlocks(doc);
        tagText(doc, registry);
        tagSnippets(doc);
        stripMarkers(doc);
        prepareEditable(doc.body);
        injectCanvasStyles(doc);
        bindCanvas(doc);
    }

    /** Turn <template data-ve-start/end> brackets into `data-ve-block` on the elements between them. */
    function tagBlocks(doc) {
        $$('template[data-ve-start]', doc).forEach((start) => {
            const key = start.dataset.veStart;
            let end = start.nextSibling;
            while (end && !(end.nodeType === 1 && end.matches('template[data-ve-end]') && end.dataset.veEnd === key)) {
                end = end.nextSibling;
            }
            if (!end) {
                // The HTML parser moved the end marker; fall back to the next element.
                if (start.nextElementSibling) start.nextElementSibling.setAttribute('data-ve-block', key);
                return;
            }
            for (let node = start.nextSibling; node && node !== end; node = node.nextSibling) {
                if (node.nodeType === 1 && !node.matches('template[data-ve-start], template[data-ve-end]')) {
                    node.setAttribute('data-ve-block', key);
                }
            }
        });
        $$('template[data-ve-start], template[data-ve-end]', doc).forEach((node) => node.remove());
    }

    /** Find marker-wrapped text, remove the markers, and tag the element holding each value with its state path. */
    function tagText(doc, registry) {
        const markers = [];
        const walker = doc.createTreeWalker(doc.body, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (!MARKER.test(node.data)) continue;
            if (node.parentElement && node.parentElement.closest('script, style, textarea, noscript, title, option')) {
                node.data = node.data.replace(MARKERS, '');
                continue;
            }
            const pattern = /\u{F0000}([\u{F0010}-\u{F0019}]+)\u{F0001}|\u{F0002}|[\u{F0000}-\u{F00FF}]/gu;
            let match;
            while ((match = pattern.exec(node.data))) {
                if (match[1] !== undefined) {
                    const index = Number([...match[1]].map((c) => c.codePointAt(0) - DIGIT_ZERO).join(''));
                    markers.push({ node, offset: match.index, length: match[0].length, kind: 'start', index });
                } else {
                    markers.push({ node, offset: match.index, length: match[0].length, kind: match[0] === '\u{F0002}' ? 'end' : 'stray' });
                }
            }
        }

        const stack = [];
        const ranges = [];
        markers.forEach((marker) => {
            if (marker.kind === 'start') {
                stack.push(marker);
            } else if (marker.kind === 'end' && stack.length) {
                const start = stack.pop();
                const range = doc.createRange();
                range.setStart(start.node, start.offset + start.length);
                range.setEnd(marker.node, marker.offset);
                ranges.push({ range, index: start.index });
            }
        });

        // Delete markers back to front so recorded offsets stay valid; live ranges adjust themselves.
        for (let i = markers.length - 1; i >= 0; i -= 1) {
            markers[i].node.deleteData(markers[i].offset, markers[i].length);
        }

        ranges.forEach(({ range, index }) => {
            const entry = registry[index];
            const target = entry && elementForRange(doc, range);
            if (target) target.setAttribute('data-ve-text', JSON.stringify(entry.path));
        });
    }

    /** Make tagged text inside `root` editable in place, where what's shown is exactly the stored value. */
    function prepareEditable(root) {
        const nodes = root.matches && root.matches('[data-ve-text]') ? [root, ...$$('[data-ve-text]', root)] : $$('[data-ve-text]', root);
        nodes.forEach((node) => {
            const entry = entryFor(node);
            // Choice fields are picked from a dropdown rather than typed into.
            const editable = entry && !entry.readonly && !entry.choices && normalise(node.textContent) === normalise(entry.value) && !node.closest('button, select, option, svg');
            if (editable) {
                trimEdgeWhitespace(node);
                node.setAttribute('contenteditable', 'plaintext-only');
                node.setAttribute('spellcheck', 'true');
                node.removeAttribute('data-ve-readonly');
            } else {
                node.removeAttribute('contenteditable');
                node.setAttribute('data-ve-readonly', '');
            }
            if (entry && entry.numeric) {
                node.setAttribute('inputmode', 'decimal');
                node.setAttribute('data-ve-numeric', '');
            } else {
                node.removeAttribute('inputmode');
                node.removeAttribute('data-ve-numeric');
            }
            if (entry && entry.choices) node.setAttribute('data-ve-choice', '');
            else node.removeAttribute('data-ve-choice');
        });
        const regions = root.matches && root.matches('[data-ve-rich]') ? [root, ...$$('[data-ve-rich]', root)] : $$('[data-ve-rich]', root);
        regions.forEach((region) => {
            if (!entryFor(region) || entryFor(region).readonly) return;
            region.setAttribute('contenteditable', 'true');
            region.setAttribute('spellcheck', 'true');
        });
    }

    /**
     * Editable elements render their source whitespace (Chrome treats `plaintext-only`
     * like pre-wrap), so drop the template's indentation around the value.
     */
    function trimEdgeWhitespace(node) {
        const first = node.firstChild;
        const last = node.lastChild;
        if (first && first.nodeType === 3) first.data = first.data.replace(/^\s+/, '');
        if (last && last.nodeType === 3) last.data = last.data.replace(/\s+$/, '');
    }

    const NEVER_TAG = new Set(['HTML', 'BODY', 'MAIN', 'UL', 'OL', 'TABLE', 'TBODY', 'THEAD', 'TR', 'SELECT']);

    function elementForRange(doc, range) {
        const text = normalise(range.toString());
        if (!text) return null;
        let container = range.commonAncestorContainer;
        if (container.nodeType !== 1) container = container.parentElement;
        if (container && !NEVER_TAG.has(container.tagName) && !container.hasAttribute('data-ve-text') && normalise(container.textContent) === text) {
            return container;
        }
        const span = doc.createElement('span');
        span.className = 've-text';
        try {
            range.surroundContents(span);
            return span;
        } catch (e) {
            return null;
        }
    }

    /** Markers inside attributes, <title>, scripts etc. can't be mapped; just remove them. */
    function stripMarkers(doc) {
        $$('*', doc).forEach((node) => {
            [...node.attributes].forEach((attribute) => {
                if (MARKER.test(attribute.value)) node.setAttribute(attribute.name, attribute.value.replace(MARKERS, ''));
            });
        });
        const walker = doc.createTreeWalker(doc.documentElement, NodeFilter.SHOW_TEXT);
        for (let node = walker.nextNode(); node; node = walker.nextNode()) {
            if (MARKER.test(node.data)) node.data = node.data.replace(MARKERS, '');
        }
        if (MARKER.test(doc.title)) doc.title = doc.title.replace(MARKERS, '');
    }

    const CANVAS_CSS = `
        [data-ve-block] { cursor: pointer; }
        [data-ve-hover] { outline: 2px dashed rgba(37, 99, 235, 0.55) !important; outline-offset: -2px; }
        [data-ve-selected] { outline: 2px solid #2563eb !important; outline-offset: -2px; }
        [data-ve-error] { outline: 2px solid #dc2626 !important; outline-offset: -2px; }
        [data-ve-text] { cursor: text; border-radius: 2px; }
        [data-ve-text][data-ve-readonly] { cursor: pointer; }
        [data-ve-text]:hover { outline: 1px dashed #f59e0b !important; outline-offset: 2px; }
        [data-ve-text]:focus { outline: 2px solid #f59e0b !important; outline-offset: 2px; }
        [data-ve-text]:empty::before { content: 'Insert text here'; opacity: 0.45; }
        [data-ve-numeric] { font-variant-numeric: tabular-nums; }
        [data-ve-choice] { cursor: pointer; }
        [data-ve-choice]::after { content: ' ▾'; opacity: 0.5; font-size: 0.8em; }
        [data-ve-choice]:has(select)::after { content: none; }
        select[data-ve-choice-input] { font: inherit; color: inherit; }
        span.ve-text { display: inline; }
        [data-ve-rich] { cursor: text; border-radius: 2px; }
        [data-ve-rich]:hover { outline: 1px dashed #f59e0b !important; outline-offset: 4px; }
        [data-ve-rich]:focus { outline: 2px solid #f59e0b !important; outline-offset: 4px; }
        ve-embed { display: contents; cursor: default; }
        [data-ve-snippet] { cursor: pointer; }
        [data-ve-snippet]:hover { outline: 2px dashed rgba(147, 51, 234, 0.6) !important; outline-offset: 4px; }
        .ve-block-placeholder { box-sizing: border-box; max-width: 960px; margin: 12px auto; padding: 24px; border: 2px dashed #94a3b8; border-radius: 8px; background: #f8fafc; color: #475569; font: 14px/1.4 system-ui, sans-serif; text-align: center; }
        .ve-block-placeholder--error { border-color: #dc2626; background: #fef2f2; color: #991b1b; }
    `;

    function injectCanvasStyles(doc) {
        const style = doc.createElement('style');
        style.textContent = CANVAS_CSS;
        doc.head.appendChild(style);
    }

    // ------------------------------------------------------------------
    // Canvas interaction
    // ------------------------------------------------------------------

    let toolbarHost = null;
    let hoverKey = null;

    function bindCanvas(doc) {
        const win = doc.defaultView;
        doc.addEventListener('click', onCanvasClick, true);
        doc.addEventListener('submit', (event) => event.preventDefault(), true);
        doc.addEventListener('mouseover', onCanvasHover);
        doc.addEventListener('mouseleave', () => setHover(null));
        doc.addEventListener('input', onCanvasInput, true);
        doc.addEventListener('focusout', onCanvasFocusOut, true);
        doc.addEventListener('focusin', onCanvasFocusIn, true);
        doc.addEventListener('selectionchange', () => {
            if (richSession) updateRichToolbarState();
        });
        doc.addEventListener('keydown', onCanvasKeydown, true);
        doc.addEventListener('paste', onCanvasPaste, true);
        win.addEventListener('scroll', () => {
            positionToolbar();
            positionRichToolbar();
        }, { passive: true });
        win.addEventListener('resize', () => {
            positionToolbar();
            positionRichToolbar();
        });
        win.frameElement.dataset.userScrolled = '0';
        ['wheel', 'touchstart', 'mousedown', 'keydown'].forEach((type) => {
            doc.addEventListener(type, () => {
                win.frameElement.dataset.userScrolled = '1';
            }, { passive: true, capture: true });
        });
        toolbarHost = buildToolbar(doc);
        richToolbarHost = buildRichToolbar(doc);
        spacingHandlesHost = buildSpacingHandles(doc);
        richSession = null;
    }

    /**
     * Mark each snippet's section of the page (`data-ve-snippet`): the element
     * holding all of its marked text, e.g. a blog post's author box. Clicking
     * anywhere in it (the photo, say) opens the snippet.
     */
    function tagSnippets(doc) {
        const byKey = new Map();
        $$('[data-ve-text], [data-ve-rich]', doc.body).forEach((node) => {
            const path = JSON.parse(node.dataset.veText || node.dataset.veRich);
            if (path[0] !== 'snippets') return;
            if (!byKey.has(path[1])) byKey.set(path[1], []);
            byKey.get(path[1]).push(node);
        });
        byKey.forEach((nodes, key) => {
            let section = nodes[0].parentElement;
            while (section && !nodes.every((node) => section.contains(node))) section = section.parentElement;
            // A single value's section is its nearest block-level container.
            // doc.defaultView is null for the detached document snapshotRender diffs
            // off-screen (DOMParser output is never attached to a window), so there's
            // no computed style to widen past inline ancestors with; keep the nearest
            // common container as found above instead of crashing.
            if (section && nodes.length === 1 && doc.defaultView) {
                while (section && section.parentElement && doc.defaultView.getComputedStyle(section).display.startsWith('inline')) section = section.parentElement;
            }
            const tooBig = !section || NEVER_TAG.has(section.tagName) || section.querySelector('[data-ve-block]') || section.hasAttribute('data-ve-snippet');
            if (!tooBig) section.setAttribute('data-ve-snippet', key);
        });
    }

    function targetForPath(path) {
        if (path[0] === 'snippets') return { kind: 'snippet', key: path[1], field: path[2] };
        if (path[0] === 'streams') return { kind: 'block', stream: path[1], id: path[2].slice(1) };
        return { kind: 'field', name: path[1] };
    }

    function onCanvasClick(event) {
        const path = event.composedPath();
        if ([toolbarHost, richToolbarHost, spacingHandlesHost].some((host) => host && path.includes(host))) return;
        closeAddMenu();
        // Links, buttons and forms on the page must not navigate away from the editor.
        // Native disclosure widgets (<details>/<summary>, e.g. FAQ answers) still open
        // and close, so what's inside them can be reached and edited; clicking text
        // that's being edited in place doesn't toggle them.
        const summary = event.target.closest('summary');
        const editing = event.target.closest('[contenteditable]:not([contenteditable="false"])');
        if (!summary || editing) event.preventDefault();

        // Rich text is edited right there; just show its block in the sidebar too.
        const region = event.target.closest('[data-ve-rich]');
        if (region && entryFor(region)) {
            const target = targetForPath(entryFor(region).path);
            if (target.kind === 'block') selectBlock(target.stream, target.id);
            else if (target.kind === 'snippet') selectSnippet(target.key);
            else if (activeTab !== 'page' || selection) showPageField(target.name);
            return;
        }

        const textNode = event.target.closest('[data-ve-text]');
        if (textNode) {
            const entry = entryFor(textNode);
            if (entry) {
                const target = targetForPath(entry.path);
                const readonly = textNode.hasAttribute('data-ve-readonly');
                if (target.kind === 'block') {
                    selectBlock(target.stream, target.id, { focusField: readonly ? entry.path[entry.path.length - 1] : null });
                } else if (target.kind === 'snippet') {
                    selectSnippet(target.key, { focusField: readonly ? target.field : null });
                } else {
                    showPageField(target.name, { focus: readonly });
                }
                if (entry.choices) openChoiceDropdown(textNode, entry);
                return;
            }
        }

        const blockNode = event.target.closest('[data-ve-block]');
        const snippetNode = event.target.closest('[data-ve-snippet]');
        if (snippetNode && (!blockNode || blockNode.contains(snippetNode))) {
            selectSnippet(snippetNode.dataset.veSnippet);
            return;
        }
        if (blockNode) {
            const [stream, id] = splitKey(blockNode.dataset.veBlock);
            selectBlock(stream, id);
            return;
        }

        selectBlock(null);
    }

    function splitKey(key) {
        const separator = key.indexOf(':');
        return [key.slice(0, separator), key.slice(separator + 1)];
    }

    /** Show a choice field's options as a native <select> in place of its text, until it's settled. */
    function openChoiceDropdown(node, entry) {
        if (node.querySelector('[data-ve-choice-input]')) return;
        const doc = node.ownerDocument;
        const originalText = node.textContent;

        const select = doc.createElement('select');
        select.setAttribute('data-ve-choice-input', '');
        (entry.choices || []).forEach(([choiceValue, label]) => {
            const option = doc.createElement('option');
            option.value = choiceValue;
            option.textContent = label;
            option.selected = choiceValue === entry.value;
            select.appendChild(option);
        });

        node.textContent = '';
        node.appendChild(select);
        select.focus();

        let settled = false;
        const settle = (nextValue) => {
            if (settled) return;
            settled = true;
            node.textContent = nextValue;
            if (nextValue !== originalText) commitChoiceEdit(node, entry, nextValue);
        };
        select.addEventListener('change', () => settle(select.value));
        select.addEventListener('blur', () => settle(select.value), { once: true });
        select.addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.stopPropagation();
                settle(originalText);
                select.blur();
            }
        });
    }

    /** Write a choice dropdown's new value into state, the same way an inline text edit does. */
    function commitChoiceEdit(node, entry, value) {
        const pathKey = node.dataset.veText;
        entry.value = value;
        $$('[data-ve-text]', node.ownerDocument).forEach((copy) => {
            if (copy !== node && copy.dataset.veText === pathKey) copy.textContent = value;
        });
        setAtPath(entry.path, value);
        if (entry.path[0] === 'streams') clearBlockError(entry.path[1], entry.path[2].slice(1));
        commit({ coalesce: `choice:${pathKey}` });
        if (
            activeTab === 'block' &&
            selection &&
            entry.path[0] === 'streams' &&
            entry.path[1] === selection.stream &&
            entry.path[2] === `#${selection.id}`
        ) {
            refreshInspector();
        }
    }

    function onCanvasHover(event) {
        const blockNode = event.target.closest && event.target.closest('[data-ve-block]');
        setHover(blockNode ? blockNode.dataset.veBlock : null);
    }

    function setHover(key) {
        if (key === hoverKey) return;
        hoverKey = key;
        const doc = frontDoc();
        if (!doc) return;
        $$('[data-ve-hover]', doc).forEach((node) => node.removeAttribute('data-ve-hover'));
        if (key) $$(`[data-ve-block="${CSS.escape(key)}"]`, doc).forEach((node) => node.setAttribute('data-ve-hover', ''));
    }

    let inlineEditedPaths = new Set();

    function onCanvasInput(event) {
        const region = event.target.closest && event.target.closest('[data-ve-rich]');
        if (region) {
            scheduleRichSync(region);
            positionRichToolbar();
            return;
        }
        const node = event.target.closest && event.target.closest('[data-ve-text]');
        if (!node) return;
        const entry = entryFor(node);
        if (!entry) return;

        let value = entry.multiline ? node.innerText : node.textContent;
        if (!entry.multiline) value = value.replace(/\s*\n\s*/g, ' ');
        value = value.replace(/\u00a0/g, ' ');

        // Keep every rendering of the same value in sync (e.g. a title used twice).
        const pathKey = node.dataset.veText;
        entry.value = value;
        $$('[data-ve-text]', node.ownerDocument).forEach((copy) => {
            if (copy !== node && copy.dataset.veText === pathKey) copy.textContent = value;
        });

        setAtPath(entry.path, value);
        inlineEditedPaths.add(pathKey);
        if (entry.path[0] === 'streams') clearBlockError(entry.path[1], entry.path[2].slice(1));
        commit({ render: false, coalesce: `text:${pathKey}` });
        if (entry.path[0] === 'fields' && entry.path[1] === 'title') updateStatus();
    }

    function onCanvasFocusOut(event) {
        const region = event.target.closest && event.target.closest('[data-ve-rich]');
        if (region) {
            // Moving into the formatting toolbar (or a page chooser) is still editing.
            if (event.relatedTarget === richToolbarHost || (richSession && richSession.suspended)) return;
            endRichSession(region);
            return;
        }
        const node = event.target.closest && event.target.closest('[data-ve-text]');
        if (node) afterInlineEditing();
    }

    /** After editing on the canvas: bring the sidebar back in line, and re-render if anything was put off. */
    function afterInlineEditing() {
        if (!inlineEditedPaths.size) {
            if (renderSkippedWhileTyping) {
                renderSkippedWhileTyping = false;
                scheduleRender(0);
            }
            return;
        }
        const edited = [...inlineEditedPaths].map((pathKey) => JSON.parse(pathKey));
        inlineEditedPaths = new Set();
        // Bring the sidebar forms back in line with what was typed on the canvas.
        const touchesSelection = selection && edited.some((path) => path[0] === 'streams' && path[1] === selection.stream && path[2] === `#${selection.id}`);
        const touchesPage = edited.some((path) => path[0] === 'fields');
        const touchesSnippet = selectedSnippet && edited.some((path) => path[0] === 'snippets' && path[1] === selectedSnippet);
        if (activeTab === 'block' && touchesSnippet) loadSnippetForm(selectedSnippet);
        if ((activeTab === 'block' && touchesSelection) || (activeTab === 'page' && touchesPage)) refreshInspector();
        pageFormStale = pageFormStale || touchesPage;
        // Rich text is shown as edited until it's re-rendered from the saved value
        // (patched in place, so the page doesn't move).
        if (renderSkippedWhileTyping || inlineEditedRich) {
            renderSkippedWhileTyping = false;
            inlineEditedRich = false;
            scheduleRender(0);
        }
    }

    function onCanvasKeydown(event) {
        const region = event.target.closest && event.target.closest('[data-ve-rich]');
        if (region) {
            const mod = event.metaKey || event.ctrlKey;
            if (event.key === 'Escape') {
                event.preventDefault();
                region.blur();
            } else if (mod && event.key.toLowerCase() === 'k' && richSession) {
                const link = entryFor(region).toolbar.find((control) => control.kind === 'link');
                if (link) {
                    event.preventDefault();
                    openLinkPopover(link);
                }
            } else if (mod && event.key.toLowerCase() === 's') {
                handleShortcut(event);
            }
            return;
        }
        const node = event.target.closest && event.target.closest('[data-ve-text]');
        if (node) {
            const entry = entryFor(node);
            if (event.key === 'Escape' || (event.key === 'Enter' && entry && !entry.multiline)) {
                event.preventDefault();
                node.blur();
            } else if (entry && entry.numeric && event.key.length === 1 && !event.metaKey && !event.ctrlKey && !/[0-9.-]/.test(event.key)) {
                // Only digits, "." and "-" are accepted so the value stays parseable as a number.
                event.preventDefault();
            }
            return;
        }
        handleShortcut(event);
    }

    function onCanvasPaste(event) {
        // `plaintext-only` handles this in most browsers; this covers the rest.
        const node = event.target.closest && event.target.closest('[data-ve-text]');
        if (!node) return;
        event.preventDefault();
        const text = (event.clipboardData || window.clipboardData).getData('text/plain');
        node.ownerDocument.execCommand('insertText', false, text);
    }

    function isTypingInCanvas() {
        const doc = frontDoc();
        const active = doc && doc.activeElement;
        return Boolean(richSession || (active && active.closest && active.closest('[data-ve-text], [data-ve-rich]')));
    }

    // ---- Inline rich text ----
    //
    // Rich text renders as `data-ve-rich` regions: contenteditable, with a
    // floating toolbar built from the block's Draftail features. Edits are
    // posted to the server, which converts them with Draftail's own converter,
    // so the stored value is what Draftail itself would save. The sidebar's
    // Draftail editor reloads with the result when editing on the canvas ends.

    let richToolbarHost = null;
    let richSession = null; // { region, range, link, suspended }
    let inlineEditedRich = false;
    const richTimers = new Map();
    const richInFlight = new Map();
    const richSynced = new WeakMap();
    const NATIVE_INLINE = { b: 'bold', strong: 'bold', i: 'italic', em: 'italic', sup: 'superscript', sub: 'subscript' };

    /** Turn <template data-ve-rt-start/end> brackets into a `data-ve-rich` region holding the rich text. */
    function tagRich(doc, registry) {
        $$('template[data-ve-rt-start]', doc).forEach((start) => {
            const index = start.dataset.veRtStart;
            const entry = registry[Number(index)];
            let end = start.nextSibling;
            while (end && !(end.nodeType === 1 && end.matches('template[data-ve-rt-end]') && end.dataset.veRtEnd === index)) end = end.nextSibling;
            if (!entry || !end) return;

            const nodes = [];
            for (let node = start.nextSibling; node !== end; node = node.nextSibling) nodes.push(node);
            const parent = start.parentNode;
            const others = [...parent.childNodes].filter(
                (node) => node !== start && node !== end && !nodes.includes(node) && node.nodeType !== 8 && !(node.nodeType === 3 && !node.data.trim()),
            );
            // Use the element the template wraps the rich text in when it holds nothing
            // else; otherwise wrap the rich text so it can be edited on its own.
            let region = parent;
            if (others.length || parent === doc.body || NEVER_TAG.has(parent.tagName) || parent.hasAttribute('data-ve-rich')) {
                region = doc.createElement('div');
                region.className = 've-rich';
                parent.insertBefore(region, start);
                nodes.forEach((node) => region.appendChild(node));
            }
            region.setAttribute('data-ve-rich', JSON.stringify(entry.path));
        });
        $$('template[data-ve-rt-start], template[data-ve-rt-end]', doc).forEach((node) => node.remove());
    }

    function onCanvasFocusIn(event) {
        const region = event.target.closest && event.target.closest('[data-ve-rich]');
        if (!region || !entryFor(region)) return;
        if (richSession && richSession.region === region) return;
        richSession = { region };
        if (!richSynced.has(region)) richSynced.set(region, region.innerHTML);
        const doc = region.ownerDocument;
        doc.execCommand('defaultParagraphSeparator', false, 'p');
        doc.execCommand('styleWithCSS', false, false);
        renderRichToolbar(entryFor(region));
        positionToolbar();
        positionRichToolbar();
        updateRichToolbarState();
    }

    async function endRichSession(region) {
        if (!richSession || richSession.region !== region) return;
        richSession = null;
        closeLinkPopover();
        hideRichToolbar();
        positionToolbar();
        await flushRich(region);
        afterInlineEditing();
    }

    function scheduleRichSync(region, delay = 400) {
        clearTimeout(richTimers.get(region));
        richTimers.set(
            region,
            setTimeout(() => {
                richTimers.delete(region);
                syncRich(region);
            }, delay),
        );
    }

    function flushRich(region) {
        if (richTimers.has(region)) {
            clearTimeout(richTimers.get(region));
            richTimers.delete(region);
            return syncRich(region);
        }
        return richInFlight.get(region) || Promise.resolve();
    }

    /** Send a region's HTML to be converted to Wagtail's stored format, and keep the result in the state. */
    function syncRich(region) {
        const previous = richInFlight.get(region);
        const run = (async () => {
            await previous;
            const entry = entryFor(region);
            if (!entry) return;
            const html = region.innerHTML;
            if (richSynced.get(region) === html) return;
            richSynced.set(region, html);
            const { ok, data } = await postJSON(config.urls.richTextValue, { html, features: entry.features });
            if (!ok) {
                toast('That edit couldn’t be applied. Try the editor in the sidebar.', 'error');
                return;
            }
            if (entry.value === data.value) return;
            entry.value = data.value;
            setAtPath(entry.path, data.value);
            inlineEditedPaths.add(region.dataset.veRich);
            inlineEditedRich = true;
            if (entry.path[0] === 'streams') clearBlockError(entry.path[1], entry.path[2].slice(1));
            commit({ render: false, coalesce: `rich:${region.dataset.veRich}` });
        })();
        richInFlight.set(region, run);
        run.finally(() => {
            if (richInFlight.get(region) === run) richInFlight.delete(region);
        });
        return run;
    }

    // ---- Rich text toolbar (in the iframe, isolated in a shadow root) ----

    const RICH_TOOLBAR_CSS = `
        :host { all: initial; }
        .wrap { position: fixed; z-index: 2147483647; display: none; font: 13px/1 system-ui, -apple-system, sans-serif; }
        .wrap.visible { display: block; }
        .bar { display: flex; flex-wrap: wrap; align-items: center; gap: 1px; padding: 4px; border-radius: 8px; background: #fff; border: 1px solid #cbd5e1; box-shadow: 0 6px 20px rgba(15,23,42,.18); }
        button { all: unset; box-sizing: border-box; display: inline-flex; align-items: center; justify-content: center; min-width: 30px; height: 30px; padding: 0 6px; border-radius: 6px; color: #334155; cursor: pointer; font-weight: 600; font-size: 13px; }
        button:hover { background: #f1f5f9; color: #0f172a; }
        button.active { background: #e0e7ff; color: #1d4ed8; }
        button:disabled { opacity: .35; cursor: default; }
        svg.icon { width: 16px; height: 16px; fill: currentColor; }
        .sep { width: 1px; height: 20px; background: #e2e8f0; margin: 0 3px; }
        .link { margin-top: 6px; padding: 8px; border-radius: 8px; background: #fff; border: 1px solid #cbd5e1; box-shadow: 0 6px 20px rgba(15,23,42,.18); width: 320px; }
        .link[hidden] { display: none; }
        .link input { all: unset; box-sizing: border-box; display: block; width: 100%; padding: 8px 10px; border: 1px solid #cbd5e1; border-radius: 6px; font: 13px system-ui, sans-serif; color: #0f172a; background: #fff; }
        .link input:focus { border-color: #2563eb; box-shadow: 0 0 0 3px rgba(37,99,235,.15); }
        .new-tab { display: flex; align-items: center; gap: 6px; margin-top: 8px; color: #334155; font-size: 13px; cursor: pointer; }
        .new-tab input { all: revert; margin: 0; }
        .actions { display: flex; flex-wrap: wrap; gap: 4px; margin-top: 6px; }
        .actions button { height: 28px; font-weight: 500; border: 1px solid #e2e8f0; }
        .actions button.primary { background: #2563eb; border-color: #2563eb; color: #fff; }
        .actions button[hidden] { display: none; }
    `;

    function buildRichToolbar(doc) {
        const host = doc.createElement('ve-rich-toolbar');
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>${RICH_TOOLBAR_CSS}</style>
            <svg style="display:none" data-sprite></svg>
            <div class="wrap">
                <div class="bar" role="toolbar" aria-label="Text formatting"></div>
                <form class="link" hidden>
                    <input type="text" placeholder="Paste a URL, #anchor or mailto: address" aria-label="Link URL">
                    <label class="new-tab"><input type="checkbox" data-link-new-tab> Open in a new tab</label>
                    <div class="actions">
                        <button type="submit" class="primary">Apply</button>
                        <button type="button" data-link="page">Link to a page…</button>
                        <button type="button" data-link="remove">Remove link</button>
                    </div>
                </form>
            </div>`;
        // Pressing a toolbar button mustn't take the focus (and selection) out of the text.
        shadow.addEventListener('mousedown', (event) => {
            if (event.target.closest('.bar button')) event.preventDefault();
        });
        shadow.addEventListener('click', onRichToolbarClick);
        $('.link', shadow).addEventListener('submit', (event) => {
            event.preventDefault();
            const href = $('.link input[type="text"]', shadow).value.trim();
            // Applying an existing page link's own URL (e.g. just to change "new tab") keeps it a page link.
            const anchor = richSession && richSession.link && richSession.link.anchor;
            const unchanged = anchor && anchor.hasAttribute('data-ve-link') && anchor.getAttribute('href') === href;
            if (href) applyLink(href, unchanged ? 'keep' : null);
            else removeLink();
        });
        $('.link input[type="text"]', shadow).addEventListener('keydown', (event) => {
            if (event.key === 'Escape') {
                event.preventDefault();
                closeLinkPopover({ refocus: true });
            }
        });
        // Leaving the toolbar for anywhere but the text being edited ends the edit.
        host.addEventListener('focusout', (event) => {
            if (!richSession || richSession.suspended) return;
            const to = event.relatedTarget;
            if (to === host || (to && richSession.region.contains(to))) return;
            endRichSession(richSession.region);
        });
        doc.documentElement.appendChild(host);
        return host;
    }

    function controlContent(control, sprite) {
        const symbol = control.icon && document.getElementById(`icon-${control.icon}`);
        if (symbol) {
            if (!sprite.querySelector(`[id="icon-${control.icon}"]`)) sprite.appendChild(symbol.cloneNode(true));
            return `<svg class="icon" aria-hidden="true"><use href="#icon-${control.icon}"></use></svg>`;
        }
        return (control.label || control.description.slice(0, 2)).replace(/[&<>"]/g, '');
    }

    function renderRichToolbar(entry) {
        const shadow = richToolbarHost.shadowRoot;
        const bar = $('.bar', shadow);
        const key = entry.toolbar.map((control) => control.name).join();
        if (bar.dataset.key === key) return;
        bar.dataset.key = key;
        bar.innerHTML = '';
        const sprite = $('svg[data-sprite]', shadow);
        // Draftail's order: block types, inline styles, then links and the rest.
        const groups = [
            entry.toolbar.filter((control) => control.kind === 'block'),
            entry.toolbar.filter((control) => control.kind === 'inline'),
            entry.toolbar.filter((control) => control.kind === 'link' || control.kind === 'hr'),
        ];
        groups.filter((group) => group.length).forEach((group, groupIndex) => {
            if (groupIndex) bar.insertAdjacentHTML('beforeend', '<span class="sep"></span>');
            group.forEach((control) => {
                const button = document.createElement('button');
                button.type = 'button';
                button.dataset.name = control.name;
                button.title = control.description;
                button.setAttribute('aria-label', control.description);
                button.innerHTML = controlContent(control, sprite);
                bar.appendChild(button);
            });
        });
        if (entry.toolbar.some((control) => control.kind === 'sidebar')) {
            bar.insertAdjacentHTML('beforeend', '<span class="sep"></span>');
            const button = document.createElement('button');
            button.type = 'button';
            button.dataset.name = '__sidebar';
            button.title = 'Images, embeds and documents are added from the editor in the sidebar';
            button.textContent = 'More…';
            bar.appendChild(button);
        }
    }

    function hideRichToolbar() {
        if (richToolbarHost && richToolbarHost.isConnected) $('.wrap', richToolbarHost.shadowRoot).classList.remove('visible');
    }

    function positionRichToolbar() {
        if (!richSession || !richToolbarHost || !richToolbarHost.isConnected) return;
        const wrap = $('.wrap', richToolbarHost.shadowRoot);
        wrap.classList.add('visible');
        const win = richSession.region.ownerDocument.defaultView;
        const rect = richSession.region.getBoundingClientRect();
        const height = $('.bar', richToolbarHost.shadowRoot).offsetHeight;
        // Above the text while that's in view, then pinned to the top of the viewport.
        const top = Math.min(Math.max(rect.top - height - 10, 6), Math.max(rect.bottom - height, 6));
        const left = Math.min(Math.max(rect.left, 6), win.innerWidth - wrap.offsetWidth - 6);
        wrap.style.top = `${top}px`;
        wrap.style.left = `${Math.max(left, 6)}px`;
    }

    function selectionElement() {
        if (!richSession) return null;
        const selection = richSession.region.ownerDocument.getSelection();
        const node = selection && selection.anchorNode;
        const element = node && (node.nodeType === 1 ? node : node.parentElement);
        return element && richSession.region.contains(element) ? element : null;
    }

    function closestWithin(element, matches) {
        for (let node = element; node && node !== richSession.region; node = node.parentElement) {
            if (matches(node)) return node;
        }
        return null;
    }

    function isStyled(node, control) {
        if (node.tagName.toLowerCase() !== control.element) return false;
        return Object.entries(control.attrs || {}).every(([name, value]) =>
            name === 'class' ? value.split(/\s+/).every((cls) => node.classList.contains(cls)) : node.getAttribute(name) === value,
        );
    }

    function currentBlock(element) {
        return closestWithin(element, (node) => /^(P|H[1-6]|BLOCKQUOTE|LI|PRE)$/.test(node.tagName));
    }

    function isActive(control, element) {
        if (!element) return false;
        if (control.kind === 'inline') return Boolean(closestWithin(element, (node) => isStyled(node, control)));
        if (control.kind === 'block' && control.wrapper) return Boolean(closestWithin(element, (node) => node.tagName.toLowerCase() === control.wrapper));
        if (control.kind === 'block') {
            const block = currentBlock(element);
            return Boolean(block && block.tagName.toLowerCase() === control.element);
        }
        if (control.kind === 'link') return Boolean(closestWithin(element, (node) => node.tagName === 'A'));
        return false;
    }

    function updateRichToolbarState() {
        if (!richSession || !richToolbarHost) return;
        const entry = entryFor(richSession.region);
        const element = selectionElement();
        $$('.bar button[data-name]', richToolbarHost.shadowRoot).forEach((button) => {
            const control = entry.toolbar.find((candidate) => candidate.name === button.dataset.name);
            button.classList.toggle('active', Boolean(control && isActive(control, element)));
        });
    }

    function onRichToolbarClick(event) {
        const linkButton = event.target.closest('[data-link]');
        if (linkButton) {
            if (linkButton.dataset.link === 'remove') removeLink();
            if (linkButton.dataset.link === 'page') chooseLinkPage();
            return;
        }
        const button = event.target.closest('.bar button[data-name]');
        if (!button || !richSession) return;
        if (button.dataset.name === '__sidebar') {
            openSidebarEditor();
            return;
        }
        const control = entryFor(richSession.region).toolbar.find((candidate) => candidate.name === button.dataset.name);
        if (control) runRichControl(control);
    }

    function runRichControl(control) {
        const { region } = richSession;
        const doc = region.ownerDocument;
        const element = selectionElement();
        if (control.kind === 'inline') {
            const native = NATIVE_INLINE[control.element];
            if (native && !Object.keys(control.attrs || {}).length) doc.execCommand(native);
            else toggleInlineElement(control);
        } else if (control.kind === 'block' && control.wrapper) {
            toggleList(control.wrapper);
        } else if (control.kind === 'block') {
            const block = currentBlock(element);
            doc.execCommand('formatBlock', false, block && block.tagName.toLowerCase() === control.element ? 'p' : control.element);
        } else if (control.kind === 'hr') {
            doc.execCommand('insertHorizontalRule');
        } else if (control.kind === 'link') {
            openLinkPopover(control);
            return;
        }
        scheduleRichSync(region);
        updateRichToolbarState();
        positionRichToolbar();
    }

    /** Toggle a list, without the empty paragraphs Chrome leaves either side of a new one. */
    function toggleList(tag) {
        const { region } = richSession;
        const doc = region.ownerDocument;
        const block = currentBlock(selectionElement());
        const neighbours = new Set(block ? [block.previousElementSibling, block.nextElementSibling] : []);
        doc.execCommand(tag === 'ol' ? 'insertOrderedList' : 'insertUnorderedList');
        const list = closestWithin(selectionElement(), (node) => node.tagName === 'UL' || node.tagName === 'OL');
        if (!list) return;
        // Chrome sometimes nests the new list in the paragraph it came from (`<p><ul>`).
        const paragraph = list.parentElement;
        if (paragraph && paragraph.tagName === 'P' && region.contains(paragraph) && paragraph !== region) {
            // Moving nodes drops the selection; put it back where it was.
            const selection = doc.getSelection();
            const range = selection.rangeCount ? selection.getRangeAt(0) : null;
            const points = range && [range.startContainer, range.startOffset, range.endContainer, range.endOffset];
            paragraph.replaceWith(...paragraph.childNodes);
            if (points) {
                const restored = doc.createRange();
                restored.setStart(points[0], points[1]);
                restored.setEnd(points[2], points[3]);
                selection.removeAllRanges();
                selection.addRange(restored);
            }
        }
        [list.previousElementSibling, list.nextElementSibling].forEach((node) => {
            const empty = node && node.tagName === 'P' && !node.textContent.trim() && !node.querySelector('img, iframe, ve-embed');
            if (empty && !neighbours.has(node)) node.remove();
        });
    }

    /** Toggle an inline element that has no native command (e.g. the alignment features' `div.block`). */
    function toggleInlineElement(control) {
        const { region } = richSession;
        const doc = region.ownerDocument;
        const selection = doc.getSelection();
        if (!selection.rangeCount) return;
        const existing = closestWithin(selectionElement(), (node) => isStyled(node, control));
        if (existing) {
            while (existing.firstChild) existing.parentNode.insertBefore(existing.firstChild, existing);
            existing.remove();
            return;
        }
        let range = selection.getRangeAt(0);
        if (range.collapsed) {
            // Nothing selected: apply to the whole paragraph the caret is in.
            const block = currentBlock(selectionElement());
            if (!block) return;
            range = doc.createRange();
            range.selectNodeContents(block);
        }
        const wrapper = doc.createElement(control.element);
        Object.entries(control.attrs || {}).forEach(([name, value]) => wrapper.setAttribute(name, value));
        wrapper.appendChild(range.extractContents());
        range.insertNode(wrapper);
        selection.removeAllRanges();
        const inside = doc.createRange();
        inside.selectNodeContents(wrapper);
        selection.addRange(inside);
    }

    // ---- Links ----

    function linkForm() {
        return $('.link', richToolbarHost.shadowRoot);
    }

    function openLinkPopover(control) {
        const doc = richSession.region.ownerDocument;
        const selection = doc.getSelection();
        const anchor = closestWithin(selectionElement(), (node) => node.tagName === 'A');
        richSession.range = selection.rangeCount ? selection.getRangeAt(0).cloneRange() : null;
        richSession.link = { control, anchor };
        const form = linkForm();
        $('input[type="text"]', form).value = anchor ? anchor.getAttribute('href') || '' : '';
        $('[data-link-new-tab]', form).checked = Boolean(anchor && anchor.getAttribute('target') === '_blank');
        $('[data-link="remove"]', form).hidden = !anchor;
        $('[data-link="page"]', form).hidden = !(control.pageChooser && window.ModalWorkflow && window.PAGE_CHOOSER_MODAL_ONLOAD_HANDLERS);
        form.hidden = false;
        $('input[type="text"]', form).focus();
    }

    function closeLinkPopover({ refocus = false } = {}) {
        if (!richToolbarHost || !richToolbarHost.isConnected) return;
        linkForm().hidden = true;
        if (refocus && richSession) restoreRichSelection();
    }

    function restoreRichSelection() {
        const { region, range } = richSession;
        region.focus({ preventScroll: true });
        if (range) {
            const selection = region.ownerDocument.getSelection();
            selection.removeAllRanges();
            selection.addRange(range);
        }
    }

    /**
     * Link the selection (or update the link it's in). `stored` is the link's stored
     * form for page links, 'keep' to leave an existing page link's as it is, or null.
     */
    function applyLink(href, stored) {
        if (!richSession) return;
        const { region, link } = richSession;
        const doc = region.ownerDocument;
        restoreRichSelection();
        let anchors = link && link.anchor ? [link.anchor] : [];
        const selection = doc.getSelection();
        if (!anchors.length && selection.rangeCount && selection.getRangeAt(0).collapsed) {
            // Nothing selected: insert the link, using its address (or page title) as the text.
            const anchor = doc.createElement('a');
            anchor.textContent = (stored && stored.title) || href;
            selection.getRangeAt(0).insertNode(anchor);
            selection.collapse(anchor, anchor.childNodes.length);
            anchors = [anchor];
        } else if (!anchors.length) {
            const placeholder = `https://ve-link.invalid/${Date.now()}`;
            doc.execCommand('createLink', false, placeholder);
            anchors = $$('a', region).filter((anchor) => anchor.getAttribute('href') === placeholder);
            // If there was no text to link, Chrome uses the URL as the text; show the real one.
            anchors.forEach((anchor) => {
                if (anchor.textContent === placeholder) anchor.textContent = (stored && stored.title) || href;
            });
        }
        // Stored server-side as target="_blank" (see cms/rich_text_links.py).
        const newTab = $('[data-link-new-tab]', linkForm()).checked;
        anchors.forEach((anchor) => {
            anchor.setAttribute('href', href);
            if (stored && stored !== 'keep') anchor.setAttribute('data-ve-link', JSON.stringify({ linktype: stored.linktype, id: stored.id }));
            else if (!stored) anchor.removeAttribute('data-ve-link');
            if (newTab) {
                anchor.setAttribute('target', '_blank');
                anchor.setAttribute('rel', 'noopener noreferrer');
            } else {
                anchor.removeAttribute('target');
                anchor.removeAttribute('rel');
            }
        });
        closeLinkPopover();
        scheduleRichSync(region);
        updateRichToolbarState();
    }

    function removeLink() {
        if (!richSession) return;
        const { region, link } = richSession;
        restoreRichSelection();
        const anchor = link && link.anchor;
        if (anchor) {
            while (anchor.firstChild) anchor.parentNode.insertBefore(anchor.firstChild, anchor);
            anchor.remove();
        }
        closeLinkPopover();
        scheduleRichSync(region);
        updateRichToolbarState();
    }

    /** Wagtail's own page chooser, opened in the editor (outside the canvas). */
    function chooseLinkPage() {
        const session = richSession;
        if (!session || !session.link) return;
        session.suspended = true;
        let chosen = false;
        const resume = () => {
            session.suspended = false;
            if (richSession === session && !chosen) closeLinkPopover({ refocus: true });
        };
        const workflow = window.ModalWorkflow({
            url: session.link.control.pageChooser,
            onload: window.PAGE_CHOOSER_MODAL_ONLOAD_HANDLERS,
            responses: {
                pageChosen: (page) => {
                    chosen = true;
                    session.suspended = false;
                    if (richSession === session) applyLink(page.url, { linktype: 'page', id: String(page.id), title: page.title });
                },
            },
        });
        if (workflow && workflow.container) workflow.container.on('hidden.bs.modal', resume);
    }

    function openSidebarEditor() {
        const entry = richSession && entryFor(richSession.region);
        if (!entry) return;
        if (entry.path[0] === 'fields') {
            showPageField(entry.path[1]);
            toast('Add images, embeds and documents with the editor in Page settings.');
            return;
        }
        selectBlock(entry.path[1], entry.path[2].slice(1));
        setTab('block');
        toast('Add images, embeds and documents with the editor in the sidebar.');
        const started = Date.now();
        const focusDraftail = setInterval(() => {
            const editor = $('[data-ve-block-form] .public-DraftEditor-content');
            if (editor || Date.now() - started > 3000) {
                clearInterval(focusDraftail);
                if (editor) {
                    editor.scrollIntoView({ block: 'center', behavior: 'smooth' });
                    editor.focus();
                }
            }
        }, 100);
    }

    // ---- Floating block toolbar (lives in the iframe, isolated in a shadow root) ----

    const TOOLBAR_CSS = `
        :host { all: initial; }
        .bar { position: fixed; z-index: 2147483647; display: none; align-items: center; gap: 2px; padding: 3px; border-radius: 8px; background: #1e293b; box-shadow: 0 4px 16px rgba(15,23,42,.3); font: 12px/1 system-ui, -apple-system, sans-serif; color: #fff; }
        .bar.visible { display: flex; }
        .label { padding: 0 8px; font-weight: 600; white-space: nowrap; max-width: 220px; overflow: hidden; text-overflow: ellipsis; }
        button { all: unset; display: inline-flex; align-items: center; justify-content: center; min-width: 26px; height: 26px; padding: 0 6px; border-radius: 5px; cursor: pointer; color: #e2e8f0; font-size: 13px; }
        button:hover { background: #334155; color: #fff; }
        button:disabled { opacity: .35; cursor: default; background: none; }
        .sep { width: 1px; height: 16px; background: #475569; margin: 0 2px; }
    `;

    function buildToolbar(doc) {
        const host = doc.createElement('ve-toolbar');
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `
            <style>${TOOLBAR_CSS}</style>
            <div class="bar" part="bar">
                <span class="label"></span>
                <span class="sep"></span>
                <button type="button" data-action="up" title="Move up">↑</button>
                <button type="button" data-action="down" title="Move down">↓</button>
                <button type="button" data-action="duplicate" title="Duplicate">⧉</button>
                <button type="button" data-action="add" title="Add a block below">＋</button>
                <button type="button" data-action="delete" title="Delete">🗑</button>
            </div>`;
        shadow.addEventListener('click', (event) => {
            const button = event.target.closest('button[data-action]');
            if (!button || button.disabled) return;
            event.preventDefault();
            event.stopPropagation();
            runBlockAction(button.dataset.action, button);
        });
        doc.documentElement.appendChild(host);
        return host;
    }

    function positionToolbar() {
        positionSpacingHandles();
        if (!toolbarHost || !toolbarHost.isConnected) return;
        const bar = toolbarHost.shadowRoot.querySelector('.bar');
        const doc = frontDoc();
        // The rich text toolbar takes its place while text is being formatted.
        const nodes = selection && doc && !richSession ? blockNodes(doc, selection) : [];
        if (!nodes.length) {
            bar.classList.remove('visible');
            return;
        }
        const rect = unionRect(nodes);
        const win = doc.defaultView;
        if (rect.bottom < 0 || rect.top > win.innerHeight) {
            bar.classList.remove('visible');
            return;
        }
        const found = findBlock(selection.stream, selection.id);
        bar.querySelector('.label').textContent = found ? blockTypeMeta(selection.stream, found.block.type).label : '';
        bar.querySelector('[data-action="up"]').disabled = !found || found.index === 0;
        bar.querySelector('[data-action="down"]').disabled = !found || found.index === found.blocks.length - 1;
        bar.querySelector('[data-action="add"]').disabled = !canAddAny(selection.stream);
        bar.querySelector('[data-action="duplicate"]').disabled = !found || !canAdd(selection.stream, found.block.type);
        bar.classList.add('visible');
        // Sit just above the block when there's room, so the toolbar doesn't cover its content.
        const above = rect.top - bar.offsetHeight - 6;
        const top = above >= 4 ? above : Math.min(Math.max(rect.top + 6, 6), win.innerHeight - 40);
        const left = Math.min(Math.max(rect.left + 6, 6), win.innerWidth - bar.offsetWidth - 6);
        bar.style.top = `${top}px`;
        bar.style.left = `${left}px`;
    }

    function blockNodes(doc, sel) {
        return $$(`[data-ve-block="${CSS.escape(`${sel.stream}:${sel.id}`)}"]`, doc);
    }

    function unionRect(nodes) {
        const rects = nodes.map((node) => node.getBoundingClientRect()).filter((rect) => rect.width || rect.height);
        if (!rects.length) return { top: 0, left: 0, bottom: 0, right: 0 };
        return {
            top: Math.min(...rects.map((rect) => rect.top)),
            left: Math.min(...rects.map((rect) => rect.left)),
            bottom: Math.max(...rects.map((rect) => rect.bottom)),
            right: Math.max(...rects.map((rect) => rect.right)),
        };
    }

    function applyHighlights() {
        const doc = frontDoc();
        if (!doc) return;
        $$('[data-ve-selected]', doc).forEach((node) => node.removeAttribute('data-ve-selected'));
        $$('[data-ve-error]', doc).forEach((node) => node.removeAttribute('data-ve-error'));
        if (selection) blockNodes(doc, selection).forEach((node) => node.setAttribute('data-ve-selected', ''));
        if (selectedSnippet) $$('[data-ve-snippet]', doc).filter((node) => node.dataset.veSnippet === selectedSnippet).forEach((node) => node.setAttribute('data-ve-selected', ''));
        Object.entries(errors.streams).forEach(([stream, streamErrors]) => {
            Object.keys(streamErrors.blocks || {}).forEach((id) => {
                if (!selection || selection.id !== id) blockNodes(doc, { stream, id }).forEach((node) => node.setAttribute('data-ve-error', ''));
            });
        });
        hoverKey = null;
        positionToolbar();
    }

    function scrollBlockIntoView(sel) {
        const doc = frontDoc();
        const nodes = doc ? blockNodes(doc, sel) : [];
        if (nodes.length) nodes[0].scrollIntoView({ block: 'center', behavior: 'smooth' });
    }

    // ------------------------------------------------------------------
    // Selection and block actions
    // ------------------------------------------------------------------

    function selectBlock(stream, id, { scroll = false, focusField = null } = {}) {
        if (selectedSnippet) closeSnippetInspector();
        const changed = !selection || !stream || selection.stream !== stream || selection.id !== id;
        selection = stream ? { stream, id } : null;
        applyHighlights();
        renderOutline();
        if (scroll && selection) scrollBlockIntoView(selection);
        if (selection) {
            setTab('block');
            if (changed || el.blockForm.dataset.id !== id) {
                loadBlockForm({ focusField });
            } else if (focusField) {
                focusFormField(el.blockForm, focusField);
            }
        } else {
            showBlockInspector(false);
        }
    }

    function canAdd(stream, type) {
        const meta = streamMeta[stream];
        if (!meta) return false;
        const blocks = blocksOf(stream);
        if (meta.maxNum != null && blocks.length >= meta.maxNum) return false;
        const counts = meta.blockCounts[type];
        if (counts && counts.max_num != null && blocks.filter((block) => block.type === type).length >= counts.max_num) return false;
        return true;
    }

    function canAddAny(stream) {
        const meta = streamMeta[stream];
        return Boolean(meta && meta.blockTypes.some((blockType) => !blockType.deprecated && canAdd(stream, blockType.name)));
    }

    function runBlockAction(action, anchor) {
        if (!selection) return;
        const found = findBlock(selection.stream, selection.id);
        if (!found) return;
        const { blocks, index, block } = found;
        const label = blockTypeMeta(selection.stream, block.type).label;

        if (action === 'up' && index > 0) {
            [blocks[index - 1], blocks[index]] = [blocks[index], blocks[index - 1]];
            pendingScrollTo = selection;
            commit({ renderDelay: 0 });
        } else if (action === 'down' && index < blocks.length - 1) {
            [blocks[index + 1], blocks[index]] = [blocks[index], blocks[index + 1]];
            pendingScrollTo = selection;
            commit({ renderDelay: 0 });
        } else if (action === 'duplicate') {
            const copy = withFreshIds(block);
            copy.id = uuid();
            blocks.splice(index + 1, 0, copy);
            commit({ renderDelay: 0 });
            pendingScrollTo = { stream: selection.stream, id: copy.id };
            selectBlock(selection.stream, copy.id);
            toast(`Duplicated “${label}”.`);
        } else if (action === 'delete') {
            blocks.splice(index, 1);
            clearBlockError(selection.stream, block.id);
            selectBlock(null);
            commit({ renderDelay: 0 });
            toast(`Deleted “${label}”.`, 'info', { label: 'Undo', run: undo });
        } else if (action === 'add') {
            openAddMenu(selection.stream, index + 1, anchor);
        }
        positionToolbar();
    }

    // ------------------------------------------------------------------
    // Add-block menu
    // ------------------------------------------------------------------

    let addTarget = null; // {stream, index}

    function openAddMenu(stream, index, anchor) {
        addTarget = { stream, index };
        el.addSearch.value = '';
        renderAddMenu();
        el.addMenu.hidden = false;

        // The anchor may be the canvas toolbar's button, inside the iframe.
        let rect = anchor.getBoundingClientRect();
        const frameElement = anchor.ownerDocument.defaultView.frameElement;
        if (frameElement) rect = offsetRect(rect, frameElement.getBoundingClientRect(), canvasScale);
        const menuWidth = 320;
        const left = Math.min(Math.max(rect.left, 8), window.innerWidth - menuWidth - 8);
        const top = Math.min(rect.bottom + 6, window.innerHeight - 300);
        el.addMenu.style.left = `${left}px`;
        el.addMenu.style.top = `${Math.max(top, 8)}px`;
        el.addSearch.focus();
    }

    /** A rect inside the canvas, in editor coordinates (`scale`: the desktop canvas is shown scaled down). */
    function offsetRect(rect, by, scale = 1) {
        return {
            left: by.left + rect.left * scale,
            top: by.top + rect.top * scale,
            bottom: by.top + rect.bottom * scale,
            right: by.left + rect.right * scale,
        };
    }

    function closeAddMenu() {
        el.addMenu.hidden = true;
        addTarget = null;
    }

    function renderAddMenu() {
        if (!addTarget) return;
        const meta = streamMeta[addTarget.stream];
        const query = el.addSearch.value.trim().toLowerCase();
        const groups = new Map();
        meta.blockTypes
            .filter((blockType) => !blockType.deprecated)
            .filter((blockType) => !query || blockType.label.toLowerCase().includes(query) || blockType.name.includes(query) || blockType.group.toLowerCase().includes(query))
            .forEach((blockType) => {
                const group = blockType.group || 'Blocks';
                if (!groups.has(group)) groups.set(group, []);
                groups.get(group).push(blockType);
            });

        el.addList.innerHTML = '';
        if (!groups.size) {
            el.addList.innerHTML = '<p class="ve-muted">No blocks match.</p>';
            return;
        }
        [...groups.entries()]
            .sort(([a], [b]) => (a === 'Blocks' ? -1 : b === 'Blocks' ? 1 : a.localeCompare(b)))
            .forEach(([group, blockTypes]) => {
                const heading = document.createElement('div');
                heading.className = 've-popover__group';
                heading.textContent = group;
                el.addList.appendChild(heading);
                blockTypes.forEach((blockType) => {
                    const button = document.createElement('button');
                    button.type = 'button';
                    button.className = 've-popover__item';
                    button.disabled = !canAdd(addTarget.stream, blockType.name);
                    button.innerHTML = `${iconSvg(blockType.icon)}<span><span class="ve-popover__name"></span><small></small></span>`;
                    button.querySelector('.ve-popover__name').textContent = blockType.label;
                    button.querySelector('small').textContent = button.disabled ? 'Limit reached' : blockType.description;
                    button.addEventListener('click', () => addBlock(addTarget.stream, addTarget.index, blockType.name));
                    el.addList.appendChild(button);
                });
            });
    }

    async function addBlock(stream, index, type) {
        closeAddMenu();
        const { ok, data } = await postJSON(config.urls.newBlock, { stream, type });
        if (!ok) {
            toast(data.message || 'That block could not be added.', 'error');
            return;
        }
        const blocks = blocksOf(stream);
        blocks.splice(Math.min(index, blocks.length), 0, data.block);
        pendingScrollTo = { stream, id: data.block.id };
        commit({ renderDelay: 0 });
        selectBlock(stream, data.block.id);
    }

    function iconSvg(name) {
        return `<svg class="icon icon-${name}" aria-hidden="true"><use href="#icon-${name}"></use></svg>`;
    }

    // ------------------------------------------------------------------
    // Outline
    // ------------------------------------------------------------------

    let dragging = null; // {stream, id}

    function renderOutline() {
        const scrollTop = el.outline.parentElement.scrollTop;
        el.outline.innerHTML = '';
        config.streams.forEach((meta) => {
            const section = document.createElement('section');
            section.className = 've-stream';

            const header = document.createElement('div');
            header.className = 've-stream__header';
            header.innerHTML = `<span class="ve-stream__label"></span><button type="button" class="ve-stream__add">${iconSvg('plus')} Add</button>`;
            header.querySelector('.ve-stream__label').textContent = meta.label;
            const addButton = header.querySelector('.ve-stream__add');
            addButton.disabled = !canAddAny(meta.name);
            addButton.addEventListener('click', () => {
                const index = selection && selection.stream === meta.name ? findBlock(meta.name, selection.id).index + 1 : blocksOf(meta.name).length;
                openAddMenu(meta.name, index, addButton);
            });
            section.appendChild(header);

            const blocks = blocksOf(meta.name);
            if (!blocks.length) {
                const empty = document.createElement('p');
                empty.className = 've-muted';
                empty.textContent = 'No blocks yet.';
                section.appendChild(empty);
            }

            const list = document.createElement('ol');
            list.className = 've-block-list';
            blocks.forEach((block) => {
                const item = document.createElement('li');
                item.className = 've-block-item';
                item.draggable = true;
                item.dataset.id = block.id;
                const typeMeta = blockTypeMeta(meta.name, block.type);
                const hasError = Boolean(errors.streams[meta.name] && errors.streams[meta.name].blocks[block.id]);
                item.innerHTML = `${iconSvg(typeMeta.icon)}<span class="ve-block-item__text"><span class="ve-block-item__label"></span><span class="ve-block-item__snippet"></span></span>${hasError ? '<span class="ve-block-item__error" title="Has problems"></span>' : ''}`;
                item.querySelector('.ve-block-item__label').textContent = typeMeta.label;
                item.querySelector('.ve-block-item__snippet').textContent = snippet(block.value);
                if (selection && selection.stream === meta.name && selection.id === block.id) item.classList.add('is-selected');

                item.addEventListener('click', () => selectBlock(meta.name, block.id, { scroll: true }));
                item.addEventListener('mouseenter', () => setHover(`${meta.name}:${block.id}`));
                item.addEventListener('mouseleave', () => setHover(null));
                item.addEventListener('dragstart', (event) => {
                    dragging = { stream: meta.name, id: block.id };
                    item.classList.add('is-dragging');
                    event.dataTransfer.effectAllowed = 'move';
                    event.dataTransfer.setData('text/plain', block.id);
                });
                item.addEventListener('dragend', () => {
                    dragging = null;
                    $$('.ve-block-item', el.outline).forEach((node) => node.classList.remove('is-dragging', 'drop-before', 'drop-after'));
                });
                item.addEventListener('dragover', (event) => {
                    if (!dragging || dragging.stream !== meta.name || dragging.id === block.id) return;
                    event.preventDefault();
                    const rect = item.getBoundingClientRect();
                    const before = event.clientY < rect.top + rect.height / 2;
                    item.classList.toggle('drop-before', before);
                    item.classList.toggle('drop-after', !before);
                });
                item.addEventListener('dragleave', () => item.classList.remove('drop-before', 'drop-after'));
                item.addEventListener('drop', (event) => {
                    if (!dragging || dragging.stream !== meta.name) return;
                    event.preventDefault();
                    const before = item.classList.contains('drop-before');
                    moveBlock(meta.name, dragging.id, block.id, before);
                });
                list.appendChild(item);
            });
            section.appendChild(list);
            el.outline.appendChild(section);
        });
        el.outline.parentElement.scrollTop = scrollTop;
    }

    function moveBlock(stream, id, targetId, before) {
        const blocks = blocksOf(stream);
        const from = blocks.findIndex((block) => block.id === id);
        if (from === -1) return;
        const [moved] = blocks.splice(from, 1);
        let to = blocks.findIndex((block) => block.id === targetId);
        if (to === -1) to = blocks.length;
        if (!before) to += 1;
        blocks.splice(to, 0, moved);
        pendingScrollTo = { stream, id };
        commit({ renderDelay: 0 });
    }

    // ------------------------------------------------------------------
    // Inspector: tabs
    // ------------------------------------------------------------------

    let pageFormStale = true;

    function setTab(tab) {
        activeTab = tab;
        el.tabs.forEach((button) => button.setAttribute('aria-selected', String(button.dataset.veTab === tab)));
        el.panels.forEach((panel) => {
            panel.hidden = panel.dataset.vePanel !== tab;
        });
        if (tab === 'page' && pageFormStale) loadPageForm();
    }

    function refreshInspector() {
        if (activeTab === 'block' && selection) loadBlockForm();
        if (activeTab === 'block' && selectedSnippet) {
            if (snippetMeta[selectedSnippet]) loadSnippetForm(selectedSnippet);
            else closeSnippetInspector();
        }
        if (activeTab === 'page') loadPageForm();
        else pageFormStale = true;
        if (!selection && !selectedSnippet) showBlockInspector(false);
    }

    /** Put server-rendered form HTML in place and run any inline <script>s it carries (chooser widgets). */
    function insertHTML(container, html) {
        container.innerHTML = html;
        $$('script', container).forEach((old) => {
            const script = document.createElement('script');
            [...old.attributes].forEach((attribute) => script.setAttribute(attribute.name, attribute.value));
            script.textContent = old.textContent;
            old.replaceWith(script);
        });
    }

    /** Build Wagtail's own block editing UI (the same telepath definitions the StreamField widget uses). */
    function renderBlockWidget(container, { prefix, blockDef, state: formState, error }) {
        container.innerHTML = '';
        const placeholder = document.createElement('div');
        placeholder.id = prefix;
        container.appendChild(placeholder);
        try {
            window.telepath.unpack(blockDef).render(placeholder, prefix, formState, error);
        } catch (e) {
            container.innerHTML = '<p class="ve-muted">This block’s options couldn’t be displayed.</p>';
            throw e;
        }
    }

    function serialise(form) {
        return new URLSearchParams(new FormData(form)).toString();
    }

    function focusFormField(form, name) {
        const field = $$('input, textarea, select, [contenteditable="true"]', form).find((input) => {
            const inputName = input.name || (input.closest('[data-field-name]') && input.closest('[data-field-name]').dataset.fieldName) || '';
            return inputName === name || inputName.endsWith(`-${name}`);
        });
        if (field) {
            field.scrollIntoView({ block: 'center', behavior: 'smooth' });
            field.focus({ preventScroll: true });
        }
    }

    // ------------------------------------------------------------------
    // Inspector: block form
    // ------------------------------------------------------------------

    let blockFormSeq = 0;
    let blockFormSerialised = null;
    let blockFormTouched = false;
    let blockSyncTimer = null;

    function showBlockInspector(show) {
        el.blockInspector.hidden = !show;
        el.blockEmpty.hidden = show;
        if (!show) {
            spacingPanel.hidden = true;
            spacingToggle.hidden = true;
            hideSpacingOverlay();
            el.blockForm.innerHTML = '';
            delete el.blockForm.dataset.id;
            blockFormSerialised = null;
        }
    }

    async function loadBlockForm({ focusField = null } = {}) {
        if (!selection) return;
        const found = findBlock(selection.stream, selection.id);
        if (!found) {
            selectBlock(null);
            return;
        }
        const sel = { ...selection };
        const typeMeta = blockTypeMeta(sel.stream, found.block.type);
        el.blockIcon.innerHTML = iconSvg(typeMeta.icon);
        el.blockLabel.textContent = typeMeta.label;
        el.blockStream.textContent = `In “${streamMeta[sel.stream].label}”`;
        renderBlockErrors(sel);
        showBlockInspector(true);
        $('[data-ve-action="up"]', el.blockInspector).disabled = found.index === 0;
        $('[data-ve-action="down"]', el.blockInspector).disabled = found.index === found.blocks.length - 1;
        $('[data-ve-action="add"]', el.blockInspector).disabled = !canAddAny(sel.stream);
        $('[data-ve-action="duplicate"]', el.blockInspector).disabled = !canAdd(sel.stream, found.block.type);

        const seq = ++blockFormSeq;
        blockFormSerialised = null;
        blockFormTouched = false;
        spacingPanel.hidden = true;
        spacingToggle.hidden = true;
        const hasErrors = Boolean(errors.streams[sel.stream] && errors.streams[sel.stream].blocks[sel.id]);
        const { ok, data } = await postJSON(config.urls.blockForm, {
            stream: sel.stream,
            type: found.block.type,
            value: found.block.value,
            validate: hasErrors,
        });
        if (seq !== blockFormSeq) return;
        if (!ok) {
            el.blockForm.innerHTML = '<p class="ve-muted">This block’s options couldn’t be loaded.</p>';
            return;
        }
        renderBlockWidget(el.blockForm, data);
        el.blockForm.dataset.stream = sel.stream;
        el.blockForm.dataset.id = sel.id;
        el.blockForm.dataset.type = found.block.type;
        // Wagtail's block widgets build their inputs asynchronously (Stimulus + telepath).
        setTimeout(() => {
            if (seq !== blockFormSeq) return;
            blockFormSerialised = serialise(el.blockForm);
            setupSpacingPanel();
            if (focusField) focusFormField(el.blockForm, focusField);
        }, 150);
    }

    function scheduleBlockSync(delay) {
        clearTimeout(blockSyncTimer);
        blockSyncTimer = setTimeout(syncBlockForm, delay);
    }

    async function syncBlockForm() {
        const form = el.blockForm;
        if (!form.dataset.id || blockFormSerialised === null) return;
        const serialised = serialise(form);
        if (serialised === blockFormSerialised) return;
        blockFormSerialised = serialised;
        // Widgets settle their initial values asynchronously (rich text especially);
        // only a change the editor made counts.
        if (!blockFormTouched) return;

        const sel = { stream: form.dataset.stream, id: form.dataset.id };
        const formData = new FormData(form);
        formData.append('__stream', sel.stream);
        formData.append('__type', form.dataset.type);
        const seq = blockFormSeq;
        const { ok, data } = await postForm(config.urls.blockValue, formData);
        if (!ok || seq !== blockFormSeq) return;
        const found = findBlock(sel.stream, sel.id);
        if (!found || JSON.stringify(found.block.value) === JSON.stringify(data.value)) return;
        found.block.value = data.value;
        clearBlockError(sel.stream, sel.id, { keepForm: true });
        commit({ coalesce: `form:${sel.id}`, renderDelay: 0 });
    }

    el.blockForm.addEventListener('submit', (event) => event.preventDefault());
    ['input', 'change', 'keydown', 'mousedown', 'paste', 'drop'].forEach((type) => {
        el.blockForm.addEventListener(type, () => {
            blockFormTouched = true;
        }, true);
    });
    el.blockForm.addEventListener('input', () => scheduleBlockSync(350));
    el.blockForm.addEventListener('change', () => scheduleBlockSync(50));
    // Wagtail's block UI (adding list items, reordering, choosers, rich text) doesn't always
    // fire input/change events, so also watch for any difference in the submitted data.
    setInterval(() => {
        if (el.blockForm.dataset.id && blockFormSerialised !== null && serialise(el.blockForm) !== blockFormSerialised) scheduleBlockSync(250);
    }, 600);

    $$('[data-ve-action]', el.blockInspector).forEach((button) => {
        button.addEventListener('click', () => runBlockAction(button.dataset.veAction, button));
    });

    // ------------------------------------------------------------------
    // Inspector: spacing (blocks with a SpacingBlock; see visual_editor/spacing.py)
    // ------------------------------------------------------------------
    //
    // A box-model view of the selected block's spacing. It edits Wagtail's own
    // spacing fields in the block form (hidden here), so the form stays the one
    // source of truth. The Desktop/Mobile tabs follow the canvas preview, so the
    // "now" sizes are what the canvas is showing.

    const SPACING_EDGES = ['margin_top', 'padding_top', 'padding_bottom', 'margin_bottom'];
    const SPACING_STYLE = { margin_top: 'marginTop', padding_top: 'paddingTop', padding_bottom: 'paddingBottom', margin_bottom: 'marginBottom' };
    const spacingPanel = $('[data-ve-spacing]');
    const spacingToggle = $('[data-ve-spacing-toggle]');
    // The panel sits behind the ⚙ toggle; once opened it stays open across blocks.
    let spacingOpen = false;
    let spacingTab = 'desktop';
    let pendingSpacingFlash = null;
    let spacingFlashTimer = null;

    function spacingField(tab, edge) {
        return $(`[name$="-spacing-${tab}_${edge}"]`, el.blockForm);
    }

    /** A typed length as {number, unit}, as the server reads it (bare numbers are px); null when blank or invalid. */
    function parseLength(text) {
        const match = String(text || '').trim().toLowerCase().replace(/\s+/g, '').match(/^(-?(?:\d+(?:\.\d+)?|\.\d+))(px|rem)?$/);
        return match ? { number: parseFloat(match[1]), unit: match[2] || 'px' } : null;
    }

    function formatLength({ number, unit }) {
        return `${Math.round(number * 100) / 100}${unit}`;
    }

    /** Write a value into the form's own spacing field, which syncs it like any other edit. */
    function writeSpacing(tab, edge, value) {
        const field = spacingField(tab, edge);
        if (!field || field.value === value) return;
        field.value = value;
        field.dispatchEvent(new Event('input', { bubbles: true }));
        field.dispatchEvent(new Event('change', { bubbles: true }));
        pendingSpacingFlash = edge;
        updateSpacingToggle();
    }

    function setupSpacingPanel() {
        const available = Boolean(spacingField('desktop', 'padding_top'));
        spacingToggle.hidden = !available;
        spacingPanel.hidden = !(available && spacingOpen);
        if (!available) return;
        hideFormSpacing();
        $('[data-ve-spacing-block-label]', spacingPanel).textContent = el.blockLabel.textContent;
        updateSpacingToggle();
        buildSpacingPanel();
        positionSpacingHandles();
    }

    function hasSpacingValues() {
        return ['desktop', 'mobile'].some((tab) => SPACING_EDGES.some((edge) => spacingField(tab, edge)?.value));
    }

    /** The ⚙ toggle's state, and its dot showing the block has custom spacing even while closed. */
    function updateSpacingToggle() {
        spacingToggle.setAttribute('aria-expanded', String(spacingOpen));
        spacingToggle.title = spacingOpen ? 'Hide spacing settings' : 'Spacing settings';
        $('[data-ve-spacing-dot]', spacingToggle).hidden = !hasSpacingValues();
    }

    function toggleSpacingSettings() {
        spacingOpen = !spacingOpen;
        spacingPanel.hidden = !spacingOpen;
        updateSpacingToggle();
        if (spacingOpen) buildSpacingPanel();
        else hideSpacingOverlay();
        // The canvas handles come and go with the settings.
        positionSpacingHandles();
    }

    /** The panel replaces the form's own spacing fields (and the settings gear, when spacing is all it holds). */
    function hideFormSpacing() {
        const wrapper = spacingField('desktop', 'padding_top').closest('[data-contentpath="spacing"]');
        if (!wrapper) return;
        wrapper.hidden = true;
        const settings = wrapper.parentElement;
        const others = [...settings.children].filter((child) => child !== wrapper && !child.hidden);
        if (!others.length && settings.id) {
            const gear = $(`[aria-controls="${CSS.escape(settings.id)}"]`, el.blockForm);
            if (gear) gear.hidden = true;
        }
    }

    function buildSpacingPanel() {
        if (spacingPanel.hidden) return;
        $$('[data-ve-spacing-tab]', spacingPanel).forEach((button) => button.setAttribute('aria-pressed', String(button.dataset.veSpacingTab === spacingTab)));
        SPACING_EDGES.forEach((edge) => {
            const container = $(`[data-ve-spacing-edge="${edge}"]`, spacingPanel);
            container.innerHTML = '';
            const field = spacingField(spacingTab, edge);
            if (!field) return;
            const input = document.createElement('input');
            input.type = 'text';
            input.inputMode = 'decimal';
            input.autocomplete = 'off';
            input.placeholder = 'Default';
            input.setAttribute('aria-label', `${spacingTab === 'desktop' ? 'Desktop' : 'Mobile'} ${edge.replace('_', ' ')}`);
            input.title = 'A size in px or rem, like 24px or 1.5rem. ↑/↓ to nudge (Shift for bigger steps). Blank keeps the block’s usual spacing.';
            const commit = () => {
                const text = input.value.trim();
                const length = parseLength(text);
                const valid = !text || (length && !(edge.startsWith('padding') && length.number < 0));
                input.classList.toggle('is-invalid', !valid);
                if (valid) writeSpacing(spacingTab, edge, text ? formatLength(length) : '');
            };
            let typing = null;
            input.addEventListener('input', () => {
                clearTimeout(typing);
                typing = setTimeout(commit, 400);
            });
            input.addEventListener('change', () => {
                clearTimeout(typing);
                commit();
                updateSpacingPanel();
            });
            input.addEventListener('keydown', (event) => {
                if (event.key === 'Enter') {
                    event.preventDefault();
                    input.blur();
                    return;
                }
                if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return;
                event.preventDefault();
                // Nudge from the typed value, or from what the canvas shows when it's blank.
                const current = parseLength(input.value) || { number: currentSpacingPx(edge) || 0, unit: 'px' };
                const stepSize = current.unit === 'rem' ? (event.shiftKey ? 1 : 0.25) : event.shiftKey ? 10 : 1;
                let number = current.number + (event.key === 'ArrowUp' ? stepSize : -stepSize);
                if (edge.startsWith('padding')) number = Math.max(0, number);
                input.value = formatLength({ number, unit: current.unit });
                clearTimeout(typing);
                typing = setTimeout(commit, 250);
            });
            input.addEventListener('mouseenter', () => showSpacingOverlay(edge));
            input.addEventListener('focus', () => showSpacingOverlay(edge));
            input.addEventListener('mouseleave', () => {
                if (document.activeElement !== input) hideSpacingOverlay();
            });
            input.addEventListener('blur', hideSpacingOverlay);
            const now = document.createElement('span');
            now.className = 've-spacing__now';
            container.append(input, now);
        });
        $('[data-ve-spacing-hint]', spacingPanel).textContent =
            spacingTab === 'desktop'
                ? 'Desktop: screens 960px and wider. Sizes in px or rem; blank keeps the block’s usual spacing. Or drag the handles on the block.'
                : 'Mobile: smaller screens, and desktop too wherever no desktop size is set. Or drag the handles on the block.';
        updateSpacingPanel();
    }

    /** Refresh the edges' values and the sizes the canvas is showing, without rebuilding (keeps focus). */
    function updateSpacingPanel() {
        if (!spacingToggle.hidden) updateSpacingToggle();
        if (spacingPanel.hidden) return;
        $('[data-ve-spacing-reset]', spacingPanel).disabled = !hasSpacingValues();
        const doc = frontDoc();
        const nodes = doc && selection ? blockNodes(doc, selection) : [];
        const styles = nodes.length && {
            top: doc.defaultView.getComputedStyle(nodes[0]),
            bottom: doc.defaultView.getComputedStyle(nodes[nodes.length - 1]),
        };
        SPACING_EDGES.forEach((edge) => {
            const container = $(`[data-ve-spacing-edge="${edge}"]`, spacingPanel);
            const input = $('input', container);
            const field = spacingField(spacingTab, edge);
            if (!input || !field) return;
            if (document.activeElement !== input) input.value = field.value;
            input.classList.toggle('is-set', Boolean(field.value));
            const px = styles ? Math.round(parseFloat(styles[edge.endsWith('top') ? 'top' : 'bottom'][SPACING_STYLE[edge]])) : null;
            let text = px === null ? '' : `now ${px}px`;
            const mobile = spacingField('mobile', edge);
            if (spacingTab === 'desktop' && !field.value && mobile && mobile.value) {
                text = `mobile value applies (${mobile.value})`;
            }
            $('.ve-spacing__now', container).textContent = text;
        });
    }

    /** The px size an edge of the selected block has on the canvas right now. */
    function currentSpacingPx(edge) {
        const doc = frontDoc();
        const nodes = doc && selection ? blockNodes(doc, selection) : [];
        if (!nodes.length) return null;
        const node = edge.endsWith('top') ? nodes[0] : nodes[nodes.length - 1];
        return parseFloat(doc.defaultView.getComputedStyle(node)[SPACING_STYLE[edge]]) || 0;
    }

    /** After the canvas updates: refresh the sizes, and briefly highlight the edge that was just changed. */
    function refreshSpacingPanel() {
        // A fresh render shows the saved spacing, so any drag preview has served its purpose.
        const doc = frontDoc();
        if (doc && !spacingDrag) $$('[data-ve-spacing-preview]', doc).forEach(restoreSpacingPreview);
        updateSpacingPanel();
        positionSpacingHandles();
        if (!pendingSpacingFlash) return;
        const edge = pendingSpacingFlash;
        pendingSpacingFlash = null;
        showSpacingOverlay(edge);
        clearTimeout(spacingFlashTimer);
        spacingFlashTimer = setTimeout(() => {
            if (!spacingPanel.contains(document.activeElement)) hideSpacingOverlay();
        }, 1500);
    }

    function setSpacingTab(tab) {
        spacingTab = tab;
        buildSpacingPanel();
    }

    // ---- Highlighting spacing on the canvas (in a shadow root, like the toolbars) ----

    function spacingOverlay(doc) {
        let host = doc.querySelector('ve-spacing-overlay');
        if (!host) {
            host = doc.createElement('ve-spacing-overlay');
            host.attachShadow({ mode: 'open' }).innerHTML = `
                <style>
                    :host { all: initial; }
                    div { position: fixed; z-index: 2147483646; pointer-events: none; display: flex; align-items: center; justify-content: center; font: 600 11px/1 system-ui, sans-serif; color: #0f172a; }
                    .margin { background: rgba(251, 146, 60, 0.35); }
                    .padding { background: rgba(74, 222, 128, 0.35); }
                </style>`;
            doc.documentElement.appendChild(host);
        }
        return host.shadowRoot;
    }

    function showSpacingOverlay(edge = null) {
        const doc = frontDoc();
        const nodes = doc && selection ? blockNodes(doc, selection) : [];
        if (!nodes.length) return;
        const root = spacingOverlay(doc);
        $$('div', root).forEach((box) => box.remove());
        const view = doc.defaultView;
        const first = nodes[0].getBoundingClientRect();
        const last = nodes[nodes.length - 1].getBoundingClientRect();
        const top = view.getComputedStyle(nodes[0]);
        const bottom = view.getComputedStyle(nodes[nodes.length - 1]);
        const left = Math.min(first.left, last.left);
        const width = Math.max(first.right, last.right) - left;
        const areas = {
            margin_top: [first.top - parseFloat(top.marginTop), parseFloat(top.marginTop)],
            padding_top: [first.top, parseFloat(top.paddingTop)],
            padding_bottom: [last.bottom - parseFloat(bottom.paddingBottom), parseFloat(bottom.paddingBottom)],
            margin_bottom: [last.bottom, parseFloat(bottom.marginBottom)],
        };
        (edge ? [edge] : SPACING_EDGES).forEach((name) => {
            const [y, height] = areas[name];
            if (!(height > 0)) return;
            const box = doc.createElement('div');
            box.className = name.startsWith('margin') ? 'margin' : 'padding';
            Object.assign(box.style, { top: `${y}px`, left: `${left}px`, width: `${width}px`, height: `${height}px` });
            box.textContent = `${Math.round(height)}px`;
            root.appendChild(box);
        });
    }

    function hideSpacingOverlay() {
        const doc = frontDoc();
        const host = doc && doc.querySelector('ve-spacing-overlay');
        if (host) $$('div', host.shadowRoot).forEach((box) => box.remove());
    }

    // ---- Spacing drag handles (in the iframe, isolated in a shadow root) ----
    //
    // For a selected block with spacing: a handle on each margin and padding
    // boundary, top and bottom. Dragging previews the size live with an inline
    // style, then writes it (in px) to the Desktop or Mobile field, whichever the
    // canvas is showing; the re-render replaces the preview.

    let spacingHandlesHost = null;
    let spacingDrag = null;
    const SPACING_HANDLE_CSS = `
        :host { all: initial; }
        .handle { position: fixed; z-index: 2147483646; display: none; transform: translate(-50%, -50%); padding: 3px 8px; border-radius: 999px; font: 600 11px/1.2 system-ui, -apple-system, sans-serif; color: #fff; cursor: ns-resize; user-select: none; touch-action: none; box-shadow: 0 2px 6px rgba(15, 23, 42, .3); white-space: nowrap; }
        .handle.visible { display: block; }
        .margin { background: #ea580c; }
        .padding { background: #16a34a; }
        .handle:hover, .handle.dragging { filter: brightness(1.1); box-shadow: 0 0 0 3px rgba(255, 255, 255, .8), 0 2px 8px rgba(15, 23, 42, .35); }
    `;
    const HANDLE_LABELS = { margin_top: 'margin', padding_top: 'padding', padding_bottom: 'padding', margin_bottom: 'margin' };

    function buildSpacingHandles(doc) {
        const host = doc.createElement('ve-spacing-handles');
        const shadow = host.attachShadow({ mode: 'open' });
        shadow.innerHTML = `<style>${SPACING_HANDLE_CSS}</style>${SPACING_EDGES.map((edge) => `<div class="handle ${HANDLE_LABELS[edge]}" data-edge="${edge}" title="Drag to change the ${edge.replace('_', ' ')} (Shift snaps to 8px)">↕ ${HANDLE_LABELS[edge]}</div>`).join('')}`;
        $$('.handle', shadow).forEach((handle) => {
            handle.addEventListener('pointerenter', () => showSpacingOverlay(handle.dataset.edge));
            handle.addEventListener('pointerleave', () => {
                if (!spacingDrag) hideSpacingOverlay();
            });
            handle.addEventListener('pointerdown', (event) => startSpacingDrag(event, handle));
        });
        doc.documentElement.appendChild(host);
        return host;
    }

    function positionSpacingHandles() {
        if (!spacingHandlesHost || !spacingHandlesHost.isConnected) return;
        const handles = $$('.handle', spacingHandlesHost.shadowRoot);
        const doc = frontDoc();
        const nodes = doc && selection && !spacingPanel.hidden && !richSession ? blockNodes(doc, selection) : [];
        if (!nodes.length) {
            handles.forEach((handle) => handle.classList.remove('visible'));
            return;
        }
        const view = doc.defaultView;
        const first = nodes[0].getBoundingClientRect();
        const last = nodes[nodes.length - 1].getBoundingClientRect();
        const top = view.getComputedStyle(nodes[0]);
        const bottom = view.getComputedStyle(nodes[nodes.length - 1]);
        const left = Math.min(first.left, last.left);
        const width = Math.max(first.right, last.right) - left;
        // Margin handles on the outer boundary, padding handles on the inner one, side by side.
        const at = {
            margin_top: [0.38, first.top - parseFloat(top.marginTop)],
            padding_top: [0.62, first.top + parseFloat(top.paddingTop)],
            padding_bottom: [0.62, last.bottom - parseFloat(bottom.paddingBottom)],
            margin_bottom: [0.38, last.bottom + parseFloat(bottom.marginBottom)],
        };
        handles.forEach((handle) => {
            const [x, y] = at[handle.dataset.edge];
            const inView = y > -10 && y < view.innerHeight + 10;
            handle.classList.toggle('visible', inView);
            handle.style.left = `${left + width * x}px`;
            handle.style.top = `${y}px`;
        });
    }

    function startSpacingDrag(event, handle) {
        if (!selection || event.button !== 0) return;
        event.preventDefault();
        event.stopPropagation();
        const edge = handle.dataset.edge;
        const doc = handle.ownerDocument;
        const nodes = blockNodes(doc, selection);
        if (!nodes.length) return;
        const node = edge.endsWith('top') ? nodes[0] : nodes[nodes.length - 1];
        const property = edge.replace('_', '-');
        const start = currentSpacingPx(edge) || 0;
        // Growing the margin above, or the padding at the bottom, means dragging up.
        const direction = edge === 'margin_top' || edge === 'padding_bottom' ? -1 : 1;
        const startY = event.clientY;
        const tab = spacingTab;
        if (!node.hasAttribute('data-ve-spacing-preview')) node.setAttribute('data-ve-spacing-preview', node.getAttribute('style') || '');
        spacingDrag = { edge, value: start };
        handle.classList.add('dragging');
        handle.setPointerCapture(event.pointerId);

        const move = (moveEvent) => {
            let value = Math.max(0, start + (moveEvent.clientY - startY) * direction);
            value = moveEvent.shiftKey ? Math.round(value / 8) * 8 : Math.round(value);
            spacingDrag.value = value;
            node.style.setProperty(property, `${value}px`, 'important');
            handle.textContent = `${edge.replace('_', ' ')} ${value}px`;
            showSpacingOverlay(edge);
            positionSpacingHandles();
            positionToolbar();
        };
        const end = () => {
            handle.removeEventListener('pointermove', move);
            handle.classList.remove('dragging');
            handle.textContent = `↕ ${HANDLE_LABELS[edge]}`;
            const { value } = spacingDrag;
            spacingDrag = null;
            if (value === start) {
                restoreSpacingPreview(node);
            } else {
                // The re-render replaces the preview; until then it stays, so nothing jumps.
                writeSpacing(tab, edge, `${value}px`);
            }
            updateSpacingPanel();
            positionSpacingHandles();
        };
        handle.addEventListener('pointermove', move);
        handle.addEventListener('pointerup', end, { once: true });
        handle.addEventListener('pointercancel', end, { once: true });
    }

    function restoreSpacingPreview(node) {
        const original = node.getAttribute('data-ve-spacing-preview');
        if (original) node.setAttribute('style', original);
        else node.removeAttribute('style');
        node.removeAttribute('data-ve-spacing-preview');
    }

    /** Clear every spacing value, desktop and mobile, back to the block's usual spacing (undo brings them back). */
    function resetSpacing() {
        ['desktop', 'mobile'].forEach((tab) => SPACING_EDGES.forEach((edge) => writeSpacing(tab, edge, '')));
        pendingSpacingFlash = null;
        $$('input', spacingPanel).forEach((input) => {
            input.value = '';
            input.classList.remove('is-invalid');
        });
        updateSpacingPanel();
    }

    $('[data-ve-spacing-reset]', spacingPanel).addEventListener('click', resetSpacing);
    spacingToggle.addEventListener('click', toggleSpacingSettings);

    $$('[data-ve-spacing-tab]', spacingPanel).forEach((button) => {
        button.addEventListener('click', () => {
            const tab = button.dataset.veSpacingTab;
            // Show the preview the tab is about, so the canvas and the "now" sizes match.
            const device = el.app.dataset.device;
            if (tab === 'desktop' && device !== 'desktop') $('[data-ve-device="desktop"]').click();
            else if (tab === 'mobile' && device === 'desktop') $('[data-ve-device="mobile"]').click();
            else setSpacingTab(tab);
        });
    });

    // ------------------------------------------------------------------
    // Inspector: page form
    // ------------------------------------------------------------------

    let pageFormSeq = 0;
    let pageFormSerialised = null;
    let pageFormTouched = false;
    let pageSyncTimer = null;

    async function loadPageForm() {
        pageFormStale = false;
        const seq = ++pageFormSeq;
        pageFormSerialised = null;
        pageFormTouched = false;
        const { ok, data } = await postJSON(config.urls.pageForm, { state });
        if (seq !== pageFormSeq) return;
        if (!ok) {
            el.pageForm.innerHTML = '<p class="ve-muted">The page settings couldn’t be loaded.</p>';
            return;
        }
        insertHTML(el.pageForm, data.html);
        renderPageErrors();
        setTimeout(() => {
            if (seq === pageFormSeq) pageFormSerialised = serialise(el.pageForm);
        }, 150);
    }

    function showPageField(name, { focus = false } = {}) {
        selectBlock(null);
        setTab('page');
        const reveal = () => {
            const field = $(`[data-field-name="${CSS.escape(name)}"]`, el.pageForm);
            if (!field) return false;
            field.scrollIntoView({ block: 'center', behavior: 'smooth' });
            field.classList.remove('is-flash');
            void field.offsetWidth;
            field.classList.add('is-flash');
            if (focus) focusFormField(el.pageForm, name);
            return true;
        };
        if (!reveal()) {
            const started = Date.now();
            const wait = setInterval(() => {
                if (reveal() || Date.now() - started > 3000) clearInterval(wait);
            }, 100);
        }
    }

    function schedulePageSync(delay) {
        clearTimeout(pageSyncTimer);
        pageSyncTimer = setTimeout(syncPageForm, delay);
    }

    async function syncPageForm() {
        if (pageFormSerialised === null) return;
        const serialised = serialise(el.pageForm);
        if (serialised === pageFormSerialised) return;
        pageFormSerialised = serialised;
        if (!pageFormTouched) return;

        const seq = pageFormSeq;
        const { ok, data } = await postForm(config.urls.pageValue, new FormData(el.pageForm));
        if (!ok || seq !== pageFormSeq) return;

        $$('.ve-field__errors', el.pageForm).forEach((list) => {
            list.hidden = true;
            list.innerHTML = '';
        });
        Object.entries(data.errors || {}).forEach(([name, messages]) => showFieldErrors(name, messages));

        let changed = false;
        Object.entries(data.fields).forEach(([name, value]) => {
            if (JSON.stringify(state.fields[name]) !== JSON.stringify(value)) {
                state.fields[name] = value;
                delete errors.fields[name];
                pendingFieldChanges.add(name);
                changed = true;
            }
        });
        if (changed) {
            updateStatus();
            commit({ coalesce: 'page-form', renderDelay: 0 });
        }
    }

    function showFieldErrors(name, messages) {
        const list = $(`[data-field-name="${CSS.escape(name)}"] .ve-field__errors`, el.pageForm);
        if (!list) return;
        list.innerHTML = '';
        messages.forEach((message) => {
            const item = document.createElement('li');
            item.textContent = message;
            list.appendChild(item);
        });
        list.hidden = !messages.length;
    }

    el.pageForm.addEventListener('submit', (event) => event.preventDefault());
    ['input', 'change', 'keydown', 'mousedown', 'paste', 'drop'].forEach((type) => {
        el.pageForm.addEventListener(type, () => {
            pageFormTouched = true;
        }, true);
    });
    el.pageForm.addEventListener('input', () => schedulePageSync(350));
    el.pageForm.addEventListener('change', () => schedulePageSync(50));
    setInterval(() => {
        if (activeTab === 'page' && pageFormSerialised !== null && serialise(el.pageForm) !== pageFormSerialised) schedulePageSync(250);
    }, 600);

    // ------------------------------------------------------------------
    // Inspector: snippets (shared objects the page shows, e.g. a blog post's author)
    // ------------------------------------------------------------------

    let snippetFormSeq = 0;
    let snippetFormValues = {}; // the loaded snippet's values, to tell which fields an edit changed
    let snippetFormInfo = null; // the snippet form endpoint's response (usage, label, ...)
    let snippetFormSerialised = null;
    let snippetFormTouched = false;
    let snippetSyncTimer = null;

    function selectSnippet(key, { focusField = null } = {}) {
        const meta = snippetMeta[key];
        if (!meta) return;
        // Snippets the editor can't change here: show where the page chooses them instead.
        if (!meta.editable) {
            showSnippetOwner(key);
            return;
        }
        if (selection) selectBlock(null);
        const changed = selectedSnippet !== key;
        selectedSnippet = key;
        setTab('block');
        el.blockEmpty.hidden = true;
        el.blockInspector.hidden = true;
        el.snippetInspector.hidden = false;
        applyHighlights();
        if (changed || !el.snippetForm.childElementCount) loadSnippetForm(key, { focusField });
        else if (focusField) focusFormField(el.snippetForm, focusField);
    }

    function closeSnippetInspector() {
        selectedSnippet = null;
        el.snippetInspector.hidden = true;
        el.snippetForm.innerHTML = '';
        snippetFormSerialised = null;
        if (!selection) el.blockEmpty.hidden = false;
        applyHighlights();
    }

    /** Highlight the field that chooses this snippet: in Page settings, or in its block's settings. */
    function showSnippetOwner(key) {
        const owner = snippetMeta[key] && snippetMeta[key].owners[0];
        if (!owner) return;
        if (owner.kind === 'field') {
            showPageField(owner.name);
        } else {
            selectBlock(owner.stream, owner.id, { scroll: true, focusField: owner.field });
        }
    }

    async function loadSnippetForm(key, { focusField = null } = {}) {
        const seq = ++snippetFormSeq;
        snippetFormSerialised = null;
        snippetFormTouched = false;
        const meta = snippetMeta[key];
        snippetFormInfo = null;
        renderSnippetHeader();
        const owner = meta.owners[0];
        el.snippetOwner.textContent = `Change ${owner.kind === 'field' ? owner.label.toLowerCase() : 'in block'}…`;
        el.snippetOwner.title = owner.kind === 'field' ? `Choose a different ${owner.label.toLowerCase()} in Page settings` : `Choose a different one in the “${owner.label}” block`;
        renderSnippetErrors(key);

        const { ok, data } = await postJSON(config.urls.snippetForm, { key, state });
        if (seq !== snippetFormSeq) return;
        if (!ok) {
            el.snippetForm.innerHTML = '<p class="ve-muted">This snippet couldn’t be loaded.</p>';
            return;
        }
        snippetFormInfo = data;
        renderSnippetHeader();
        el.snippetEditLink.href = data.editUrl;
        snippetFormValues = data.values || {};
        insertHTML(el.snippetForm, data.html);
        setTimeout(() => {
            if (seq !== snippetFormSeq) return;
            snippetFormSerialised = serialise(el.snippetForm);
            if (focusField) focusFormField(el.snippetForm, focusField);
        }, 150);
    }

    /** The selected snippet's title, status and notice, kept current as renders bring new snippet info. */
    function renderSnippetHeader() {
        const meta = selectedSnippet && snippetMeta[selectedSnippet];
        if (!meta) return;
        el.snippetTitle.textContent = meta.title;
        const edited = Object.keys((state.snippets || {})[selectedSnippet] || {}).length;
        const draftState = meta.mode === 'drafts' && (meta.hasUnpublishedChanges || edited) ? ' · draft changes' : '';
        el.snippetLabel.textContent = `${meta.label} · shared snippet${draftState}`;
        el.snippetNotice.textContent = snippetFormInfo ? snippetNotice(meta, snippetFormInfo) : '';
    }

    /** What saving does to this snippet, which depends on whether it has drafts (see snippets.py). */
    function snippetNotice(meta, data) {
        const label = data.label.toLowerCase();
        const others = data.usage - 1;
        const where = others > 0 ? ` (on ${others} other ${others === 1 ? 'page' : 'pages'} too)` : '';
        if (meta.mode === 'drafts') {
            let notice = `Edits are saved as a draft of this ${label} when you save this page, and go live when you publish the page. It’s shared, so publishing changes it everywhere it’s used${where}.`;
            if (meta.hasUnpublishedChanges) notice += ' It already has unpublished changes, which publishing this page will publish too.';
            if (!meta.canPublish) notice += ' You can’t publish it, so your changes will stay as a draft.';
            return notice;
        }
        const history = meta.mode === 'revisions' ? ' Each change is kept in its revision history.' : '';
        return `Edits here change this ${label} everywhere it’s used${where}, as soon as you save this page.${history}`;
    }

    function scheduleSnippetSync(delay) {
        clearTimeout(snippetSyncTimer);
        snippetSyncTimer = setTimeout(syncSnippetForm, delay);
    }

    async function syncSnippetForm() {
        if (!selectedSnippet || snippetFormSerialised === null) return;
        const serialised = serialise(el.snippetForm);
        if (serialised === snippetFormSerialised) return;
        snippetFormSerialised = serialised;
        if (!snippetFormTouched) return;

        const key = selectedSnippet;
        const seq = snippetFormSeq;
        const formData = new FormData(el.snippetForm);
        formData.append('__key', key);
        const { ok, data } = await postForm(config.urls.snippetValue, formData);
        if (!ok || seq !== snippetFormSeq) return;

        const previous = (state.snippets || {})[key] || {};
        const before = JSON.stringify(previous);
        const current = { ...snippetFormValues, ...previous };
        state.snippets = state.snippets || {};
        state.snippets[key] = { ...previous, ...data.fields };
        Object.entries(data.fields).forEach(([name, value]) => {
            if (JSON.stringify(current[name]) !== JSON.stringify(value)) pendingFieldChanges.add(`snippet|${key}|${name}`);
        });
        if (errors.snippets) delete errors.snippets[key];
        renderSnippetErrors(key, data.errors);
        if (JSON.stringify(state.snippets[key]) !== before) commit({ coalesce: `snippet:${key}`, renderDelay: 0 });
    }

    function renderSnippetErrors(key, formErrors = null) {
        const fieldErrors = formErrors || (errors.snippets && errors.snippets[key]) || {};
        el.snippetErrors.innerHTML = '';
        Object.entries(fieldErrors).forEach(([name, messages]) => {
            messages.forEach((message) => {
                const item = document.createElement('li');
                item.textContent = name === '__all__' ? message : `${name.replace(/_/g, ' ')}: ${message}`;
                el.snippetErrors.appendChild(item);
            });
        });
        el.snippetErrors.hidden = !el.snippetErrors.childElementCount;
    }

    /**
     * Snippets are shared, so say what saving will do to them first: snippets
     * without drafts change live straight away; on publish, draft snippets the
     * page shows are published too.
     */
    function confirmSnippetChanges(action) {
        const edited = Object.keys(state.snippets || {}).filter((key) => Object.keys(state.snippets[key]).length);
        const metaFor = (key) => snippetMeta[key] || { key, label: 'Snippet', title: key, mode: 'direct', canPublish: true };
        const names = (metas) => metas.map((meta) => `${meta.label} “${meta.title}”`).join(', ');
        const lines = [];

        const immediate = edited.map(metaFor).filter((meta) => meta.mode !== 'drafts');
        if (immediate.length) {
            const many = immediate.length > 1;
            lines.push(
                `This saves your changes to ${names(immediate)} straight away. ${many ? 'These are shared snippets without drafts' : 'This is a shared snippet without drafts'}, so the change applies everywhere ${many ? 'they’re' : 'it’s'} used${action === 'draft' ? ', even though the page is only saved as a draft' : ''}.`,
            );
        }
        if (action === 'publish') {
            const drafts = Object.values(snippetMeta).filter((meta) => meta.mode === 'drafts' && (meta.hasUnpublishedChanges || edited.includes(meta.key)));
            const publishable = drafts.filter((meta) => meta.canPublish);
            const blocked = drafts.filter((meta) => !meta.canPublish);
            if (publishable.length) lines.push(`Publishing also publishes the draft changes to ${names(publishable)}, everywhere ${publishable.length > 1 ? 'they’re' : 'it’s'} used.`);
            if (blocked.length) lines.push(`You can’t publish ${names(blocked)}, so ${blocked.length > 1 ? 'their' : 'its'} changes stay as a draft.`);
        }
        if (!lines.length) return true;
        return window.confirm(`${lines.join('\n\n')}\n\nContinue?`);
    }

    el.snippetForm.addEventListener('submit', (event) => event.preventDefault());
    ['input', 'change', 'keydown', 'mousedown', 'paste', 'drop'].forEach((type) => {
        el.snippetForm.addEventListener(type, () => {
            snippetFormTouched = true;
        }, true);
    });
    el.snippetForm.addEventListener('input', () => scheduleSnippetSync(350));
    el.snippetForm.addEventListener('change', () => scheduleSnippetSync(50));
    setInterval(() => {
        if (selectedSnippet && snippetFormSerialised !== null && serialise(el.snippetForm) !== snippetFormSerialised) scheduleSnippetSync(250);
    }, 600);
    el.snippetOwner.addEventListener('click', () => {
        if (selectedSnippet) showSnippetOwner(selectedSnippet);
    });

    // ------------------------------------------------------------------
    // Validation errors
    // ------------------------------------------------------------------

    function clearBlockError(stream, id, { keepForm = false } = {}) {
        const streamErrors = errors.streams[stream];
        if (!streamErrors || !streamErrors.blocks[id]) return;
        delete streamErrors.blocks[id];
        renderProblems();
        if (!keepForm && selection && selection.id === id) renderBlockErrors(selection);
    }

    function renderBlockErrors(sel) {
        const messages = (errors.streams[sel.stream] && errors.streams[sel.stream].blocks[sel.id]) || [];
        el.blockErrors.innerHTML = '';
        messages.forEach((message) => {
            const item = document.createElement('li');
            item.textContent = message;
            el.blockErrors.appendChild(item);
        });
        el.blockErrors.hidden = !messages.length;
    }

    function renderPageErrors() {
        const generic = [];
        Object.entries(errors.fields).forEach(([name, messages]) => {
            if ($(`[data-field-name="${CSS.escape(name)}"]`, el.pageForm)) showFieldErrors(name, messages);
            else generic.push(...messages.map((message) => (name === '__all__' ? message : `${name}: ${message}`)));
        });
        el.pageErrors.innerHTML = '';
        generic.forEach((message) => {
            const item = document.createElement('li');
            item.textContent = message;
            el.pageErrors.appendChild(item);
        });
        el.pageErrors.hidden = !generic.length;
    }

    /** The summary at the top of the Block tab: one row per block with problems. */
    function renderProblems() {
        const rows = [];
        Object.entries(errors.streams).forEach(([stream, streamErrors]) => {
            (streamErrors.messages || []).forEach((message) => rows.push({ stream, text: `${streamMeta[stream].label}: ${message}` }));
            Object.entries(streamErrors.blocks || {}).forEach(([id, messages]) => {
                const found = findBlock(stream, id);
                if (!found) return;
                rows.push({ stream, id, text: `${blockTypeMeta(stream, found.block.type).label} — ${messages[0]}${messages.length > 1 ? ` (+${messages.length - 1} more)` : ''}` });
            });
        });
        Object.entries(errors.snippets || {}).forEach(([key, fieldErrors]) => {
            const meta = snippetMeta[key];
            const first = Object.entries(fieldErrors)[0];
            rows.push({ snippet: key, text: `${meta ? `${meta.label} “${meta.title}”` : 'Snippet'} — ${first ? `${first[0] === '__all__' ? '' : `${first[0]}: `}${first[1][0]}` : 'needs attention'}` });
        });
        const fieldCount = Object.keys(errors.fields).length;
        if (fieldCount) rows.push({ page: true, text: `Page settings — ${fieldCount} field${fieldCount > 1 ? 's' : ''} need attention` });

        el.problems.innerHTML = '';
        el.problems.hidden = !rows.length;
        if (!rows.length) {
            applyHighlights();
            renderOutline();
            return;
        }
        const heading = document.createElement('strong');
        heading.textContent = `Fix ${rows.length} problem${rows.length > 1 ? 's' : ''} before saving`;
        el.problems.appendChild(heading);
        rows.forEach((row) => {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = row.text;
            button.addEventListener('click', () => {
                if (row.page) setTab('page');
                else if (row.snippet) selectSnippet(row.snippet);
                else if (row.id) selectBlock(row.stream, row.id, { scroll: true });
            });
            el.problems.appendChild(button);
        });
        applyHighlights();
        renderOutline();
    }

    // ------------------------------------------------------------------
    // Saving
    // ------------------------------------------------------------------

    let saving = false;

    async function save(action, force = false) {
        if (saving) return;
        // Let pending sidebar edits land in the state first.
        await Promise.all([syncBlockForm(), syncPageForm(), syncSnippetForm()]);
        if (!force && !confirmSnippetChanges(action)) return undefined;
        saving = true;
        el.save.disabled = true;
        if (el.publish) el.publish.disabled = true;
        const changeAtSave = changeCounter;
        try {
            const { ok, status: httpStatus, data } = await postJSON(config.urls.save, { state, action, baseRevisionId, force });
            if (httpStatus === 409 && data.conflict) {
                saving = false;
                if (window.confirm(`${data.message}\n\nSave anyway?`)) return save(action, true);
                return;
            }
            if (!ok) {
                if (data.errors) {
                    errors = { streams: data.errors.streams || {}, fields: data.errors.fields || {}, snippets: data.errors.snippets || {} };
                    renderProblems();
                    renderPageErrors();
                    pageFormStale = true;
                    setTab('block');
                    if (selection) loadBlockForm();
                    if (selectedSnippet) renderSnippetErrors(selectedSnippet);
                    toast('Some content needs fixing before this page can be saved.', 'error');
                } else {
                    toast(data.message || 'The page could not be saved.', 'error');
                }
                return;
            }

            errors = { streams: {}, fields: {}, snippets: {} };
            renderProblems();
            renderPageErrors();
            status = data.status;
            baseRevisionId = status.latestRevisionId;
            updateStatus();
            if (changeCounter === changeAtSave) {
                // Adopt the cleaned, saved values, unless the editor kept typing meanwhile.
                state = data.state;
                history.current = JSON.stringify(state);
                setDirty(false);
                refreshInspector();
                renderOutline();
            }
            // Snippets' draft/live status may have changed.
            scheduleRender(0);
            toast(data.message, 'success');
        } finally {
            saving = false;
            el.save.disabled = false;
            if (el.publish) el.publish.disabled = false;
        }
        return undefined;
    }

    // ------------------------------------------------------------------
    // Toasts
    // ------------------------------------------------------------------

    function toast(message, kind = 'info', action = null) {
        const node = document.createElement('div');
        node.className = `ve-toast ve-toast--${kind}`;
        const text = document.createElement('span');
        text.textContent = message;
        node.appendChild(text);
        if (action) {
            const button = document.createElement('button');
            button.type = 'button';
            button.textContent = action.label;
            button.addEventListener('click', () => {
                action.run();
                node.remove();
            });
            node.appendChild(button);
        }
        el.toasts.appendChild(node);
        setTimeout(() => node.remove(), kind === 'error' ? 8000 : 4500);
    }

    // ------------------------------------------------------------------
    // Shell wiring
    // ------------------------------------------------------------------

    function isEditingField(target) {
        return Boolean(target && target.closest && target.closest('input, textarea, select, [contenteditable]:not([contenteditable="false"])'));
    }

    function handleShortcut(event) {
        const mod = event.metaKey || event.ctrlKey;
        if (mod && event.key.toLowerCase() === 's') {
            event.preventDefault();
            save('draft');
        } else if (mod && event.key.toLowerCase() === 'z' && !isEditingField(event.target)) {
            event.preventDefault();
            if (event.shiftKey) redo();
            else undo();
        } else if (mod && event.key.toLowerCase() === 'y' && !isEditingField(event.target)) {
            event.preventDefault();
            redo();
        } else if (event.key === 'Escape') {
            if (!el.addMenu.hidden) {
                closeAddMenu();
                return;
            }
            // Escape belongs to Wagtail's chooser modals and the sidebar's own widgets.
            const inShell = event.target.ownerDocument === document;
            const busyElsewhere = document.querySelector('.modal.in, .modal.show, dialog[open]') || (inShell && event.target.closest && event.target.closest('.ve-inspector, .modal'));
            if (!busyElsewhere && !isEditingField(event.target)) selectBlock(null);
        }
    }

    document.addEventListener('keydown', handleShortcut);
    el.undo.addEventListener('click', undo);
    el.redo.addEventListener('click', redo);
    el.save.addEventListener('click', () => save('draft'));
    if (el.publish) el.publish.addEventListener('click', () => save('publish'));
    el.tabs.forEach((button) => button.addEventListener('click', () => setTab(button.dataset.veTab)));
    el.addSearch.addEventListener('input', renderAddMenu);
    el.addSearch.addEventListener('keydown', (event) => {
        if (event.key === 'Enter') {
            const first = $('.ve-popover__item:not(:disabled)', el.addList);
            if (first) first.click();
        }
    });
    document.addEventListener('mousedown', (event) => {
        if (!el.addMenu.hidden && !el.addMenu.contains(event.target) && !event.target.closest('.ve-stream__add, [data-ve-action="add"]')) closeAddMenu();
    });

    // ---- Device widths ----
    //
    // The canvas is narrower than a desktop browser (the sidebars take the rest),
    // so "Desktop" renders the page at a real desktop width and scales it down to
    // fit. Otherwise the page would show its tablet layout, and desktop-only styles
    // (like a block's desktop spacing) would never appear.

    const DESKTOP_WIDTH = 1280;
    let canvasScale = 1;

    function fitCanvas() {
        const canvas = $('.ve-canvas');
        const viewport = $('.ve-canvas__viewport');
        if (el.app.dataset.device !== 'desktop' || canvas.clientWidth >= DESKTOP_WIDTH) {
            canvasScale = 1;
            viewport.removeAttribute('style');
        } else {
            canvasScale = canvas.clientWidth / DESKTOP_WIDTH;
            Object.assign(viewport.style, {
                position: 'absolute',
                top: '0',
                left: '0',
                width: `${DESKTOP_WIDTH}px`,
                height: `${canvas.clientHeight / canvasScale}px`,
                transform: `scale(${canvasScale})`,
                transformOrigin: '0 0',
                transition: 'none',
            });
        }
        positionToolbar();
        positionRichToolbar();
    }

    window.addEventListener('resize', fitCanvas);
    fitCanvas();

    $$('[data-ve-device]').forEach((button) => {
        button.addEventListener('click', () => {
            el.app.dataset.device = button.dataset.veDevice;
            fitCanvas();
            // Tablet and mobile both show the mobile sizes (they're under the 960px desktop breakpoint).
            spacingTab = button.dataset.veDevice === 'desktop' ? 'desktop' : 'mobile';
            setTimeout(buildSpacingPanel, 300);
            $$('[data-ve-device]').forEach((other) => other.setAttribute('aria-pressed', String(other === button)));
            setTimeout(positionToolbar, 250);
        });
    });

    window.addEventListener('beforeunload', (event) => {
        if (dirty) {
            event.preventDefault();
            event.returnValue = '';
        }
    });

    updateStatus();
    setDirty(false);
    el.saveState.textContent = 'No changes';
    updateHistoryButtons();
    renderOutline();
    showBlockInspector(false);
    renderPreview();
})();
