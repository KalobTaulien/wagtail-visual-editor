/**
 * Structured admin UI for visual_editor.sections.CustomSectionBlock.
 *
 * Progressive enhancement over a hidden <textarea> (see section_editor_widget.html):
 * this script builds a form from the textarea's current JSON, keeps an in-memory
 * copy of the tree, and on every change serialises that tree straight back into the
 * textarea and fires a bubbling `input` event. Nothing downstream needs to know this
 * script exists - the visual editor's sidebar (editor.js's scheduleBlockSync) and
 * Wagtail's own StreamField JS both already listen for `input`/`change` on a block
 * form and read the textarea's value, exactly as they would for a hand-typed edit.
 *
 * There is no server round trip here and no shared module with sections.py, so this
 * file duplicates that module's property whitelist (DISPLAY_VALUES, FLEX_DIRECTIONS,
 * ...) by hand, flagged below. Keep the two in step: a value this file doesn't know
 * about will still be *accepted* (sections.py has the real, final say - this is a
 * convenience layer, not the validator), but won't get its own input here. The
 * reverse - a value this file offers that sections.py doesn't - would be rejected on
 * save with that block's usual field-level error message, visible in the same
 * "block failed to validate" list every other block uses, so it fails loudly rather
 * than silently losing the author's choice.
 *
 * Nothing here is re-parsed from the server, so this script is also where the
 * "mobile" direction matters most to get right: these properties are desktop-first
 * (the main fields apply at every width; "Mobile override" replaces them *below*
 * 960px), which is the opposite convention from the Spacing fieldset below it
 * (mobile-first; "Desktop" replaces it *above* 960px) - see sections.py's own
 * docstring for why. Copy in this file spells out the direction on both fieldsets
 * so the two conventions living side by side in one form don't read as a bug.
 */
(function () {
    'use strict';

    // ------------------------------------------------------------------
    // Whitelists mirrored from sections.py - see this file's own docstring.
    // ------------------------------------------------------------------

    var DISPLAY_VALUES = ['block', 'flex', 'grid', 'inline', 'inline-block', 'inline-flex', 'inline-grid', 'flow-root', 'contents', 'none'];
    var FLEX_DIRECTIONS = ['row', 'row-reverse', 'column', 'column-reverse'];
    var ALIGN_VALUES = ['start', 'end', 'center', 'stretch', 'baseline', 'flex-start', 'flex-end'];
    var JUSTIFY_VALUES = ['start', 'end', 'center', 'stretch', 'space-between', 'space-around', 'space-evenly', 'flex-start', 'flex-end'];
    var TEXT_ALIGN_VALUES = ['left', 'center', 'right', 'justify', 'start', 'end'];
    var HEADING_LEVELS = ['h1', 'h2', 'h3', 'h4', 'h5', 'h6'];
    var MAX_DEPTH = 5;
    var MAX_COLUMNS = 12;

    // A rough client-side mirror of spacing.LENGTH / sections._length, for a red
    // outline on an obviously bad value before it ever reaches the server. Not the
    // real validator - sections.py's `clean()` is - so this only needs to catch the
    // common case (letters, missing unit punctuation) rather than match it exactly.
    var LENGTH_RE = /^-?(?:\d+(?:\.\d+)?|\.\d+)(px|rem)?$/i;

    function isValidLength(value) {
        var text = (value || '').trim();
        return text === '' || LENGTH_RE.test(text);
    }

    function isValidInteger(value, min, max) {
        var text = (value || '').trim();
        if (text === '') return true;
        if (!/^-?\d+$/.test(text)) return false;
        var n = parseInt(text, 10);
        return n >= min && n <= max;
    }

    // ------------------------------------------------------------------
    // Small DOM-building helpers.
    // ------------------------------------------------------------------

    function el(tag, attrs, children) {
        var node = document.createElement(tag);
        Object.keys(attrs || {}).forEach(function (name) {
            var value = attrs[name];
            if (value === null || value === undefined) return;
            if (name === 'class') node.className = value;
            else if (name === 'text') node.textContent = value;
            else node.setAttribute(name, value);
        });
        (children || []).forEach(function (child) {
            if (child) node.appendChild(child);
        });
        return node;
    }

    function option(value, label, selected) {
        var node = el('option', { value: value, text: label });
        if (selected) node.selected = true;
        return node;
    }

    function selectField(value, choices) {
        var select = el('select', { class: 've-sec-input' });
        select.appendChild(option('', '—', !value));
        choices.forEach(function (choice) {
            select.appendChild(option(choice, choice, value === choice));
        });
        return select;
    }

    function textField(value, placeholder) {
        return el('input', { type: 'text', class: 've-sec-input', value: value || '', placeholder: placeholder || '', autocomplete: 'off' });
    }

    function checkboxField(checked) {
        var input = el('input', { type: 'checkbox', class: 've-sec-checkbox' });
        input.checked = !!checked;
        return input;
    }

    /** One labelled control, with optional help text under it. */
    function field(labelText, input, help) {
        var label = el('label', { class: 've-sec-field' }, [el('span', { class: 've-sec-field__label', text: labelText }), input]);
        if (help) label.appendChild(el('span', { class: 've-sec-field__help', text: help }));
        return label;
    }

    function fieldset(legendText, children, help) {
        var contents = [el('legend', { class: 've-sec-fieldset__legend', text: legendText })];
        if (help) contents.push(el('p', { class: 've-sec-fieldset__help', text: help }));
        return el('fieldset', { class: 've-sec-fieldset' }, contents.concat(children));
    }

    function button(labelText, kind, onClick) {
        var btn = el('button', { type: 'button', class: 've-sec-btn ve-sec-btn--' + (kind || 'default'), text: labelText });
        btn.addEventListener('click', onClick);
        return btn;
    }

    // ------------------------------------------------------------------
    // Tree helpers. Nodes are mutated in place; `children` arrays are spliced
    // directly for add/remove/move, so there is no separate "path" addressing.
    // ------------------------------------------------------------------

    function newId() {
        return window.crypto && window.crypto.randomUUID ? window.crypto.randomUUID() : 've-' + Math.random().toString(36).slice(2) + Date.now().toString(36);
    }

    function newNode(type) {
        if (type === 'heading') return { type: 'heading', id: newId(), level: 'h2', text: '' };
        if (type === 'rich_text') return { type: 'rich_text', id: newId(), value: '<p></p>' };
        return { type: 'section', id: newId(), children: [] };
    }

    function depthOf(node) {
        var deepest = 0;
        (node.children || []).forEach(function (child) {
            if (child.type === 'section') deepest = Math.max(deepest, 1 + depthOf(child));
        });
        return deepest;
    }

    // ------------------------------------------------------------------
    // Editor instance.
    // ------------------------------------------------------------------

    function init(root) {
        if (!root || root.dataset.veSectionInitialized) return;
        root.dataset.veSectionInitialized = '1';

        var textarea = root.querySelector('textarea');
        var container = root.querySelector('[data-ve-section-editor-ui]');
        var rawMode = false;
        var syncTimer = null;

        function parse(text) {
            if (!text || !text.trim()) return newNode('section');
            try {
                var parsed = JSON.parse(text);
                return parsed && typeof parsed === 'object' ? parsed : newNode('section');
            } catch (e) {
                return null; // Signals "unparseable"; caller falls back to raw mode.
            }
        }

        var state = parse(textarea.value);
        if (state === null) {
            // The textarea already holds something this UI can't read (hand-edited,
            // or mid-edit from before this script loaded). Open straight into raw
            // mode rather than silently discarding it by rendering an empty form.
            rawMode = true;
            state = newNode('section');
        }

        function flush() {
            textarea.value = JSON.stringify(state, null, 2);
            textarea.dispatchEvent(new Event('input', { bubbles: true }));
            textarea.dispatchEvent(new Event('change', { bubbles: true }));
        }

        /** Debounces for a typed value (`delay` truthy); flushes immediately for a
         * discrete action (`delay` 0/undefined) - a click has nothing to debounce. */
        function sync(delay) {
            clearTimeout(syncTimer);
            if (!delay) {
                flush();
                return;
            }
            syncTimer = setTimeout(flush, delay);
        }

        /** For a value typed into a field: update in place, debounce the sync, no rebuild. */
        function commitValue(delay) {
            sync(delay === undefined ? 300 : delay);
        }

        /** For add/remove/move/toggle-raw-mode: rebuild the form and sync immediately. */
        function commitStructure() {
            render();
            sync(0);
        }

        function toggleRawMode() {
            if (!rawMode) {
                // Entering raw mode: flush the in-memory tree first, so the textarea
                // reflects exactly what the form was showing.
                textarea.value = JSON.stringify(state, null, 2);
            } else {
                // Leaving raw mode: read back whatever the author typed, falling back
                // to the last-known-good tree if it doesn't parse.
                var reparsed = parse(textarea.value);
                if (reparsed === null) {
                    window.alert('That isn’t valid JSON - keeping the form’s last version. Fix the syntax here and switch back to see it.');
                    return;
                }
                state = reparsed;
            }
            rawMode = !rawMode;
            render();
            sync(0);
        }

        // ------------------------------------------------------------------
        // Rich text: a small contenteditable + toolbar, not Draftail - see this
        // file's docstring on why a full rich text widget isn't used here.
        // ------------------------------------------------------------------

        function richTextEditor(node) {
            var editable = el('div', { class: 've-sec-richtext', contenteditable: 'true', role: 'textbox', 'aria-multiline': 'true' });
            editable.innerHTML = node.value || '';

            function exec(command, arg) {
                editable.focus();
                document.execCommand(command, false, arg || null);
                node.value = editable.innerHTML;
                commitValue();
            }

            var toolbar = el('div', { class: 've-sec-richtext__toolbar' }, [
                button('B', 'icon', function () { exec('bold'); }),
                button('I', 'icon', function () { exec('italic'); }),
                button('Link', 'icon', function () {
                    var url = window.prompt('Link URL');
                    if (url) exec('createLink', url);
                }),
            ]);

            editable.addEventListener('input', function () {
                node.value = editable.innerHTML;
                commitValue();
            });

            return el('div', { class: 've-sec-richtext-wrap' }, [toolbar, editable]);
        }

        // ------------------------------------------------------------------
        // Layout + mobile-override + spacing property forms.
        // ------------------------------------------------------------------

        /** A text field validated against `isValidLength`/`isValidInteger`-style checks, purely for feedback. */
        function lengthField(labelText, getValue, setValue, help) {
            var input = textField(getValue());
            function check() {
                input.setAttribute('aria-invalid', isValidLength(input.value) ? 'false' : 'true');
            }
            input.addEventListener('input', function () {
                setValue(input.value);
                check();
                commitValue();
            });
            check();
            return field(labelText, input, help);
        }

        function selectPropertyField(labelText, getValue, setValue, choices, onChange) {
            var select = selectField(getValue(), choices);
            select.addEventListener('change', function () {
                setValue(select.value);
                commitValue(0);
                if (onChange) onChange(select.value);
            });
            return field(labelText, select);
        }

        /** Layout fields for `node` itself (`isMobile=false`) or `node.mobile` (`isMobile=true`). */
        function layoutFields(node, isMobile, onDisplayChange) {
            var data = isMobile ? (node.mobile = node.mobile || {}) : node;
            function get(key) { return data[key] || ''; }
            function set(key, value) {
                if (value) data[key] = value;
                else delete data[key];
                if (isMobile && Object.keys(data).length === 0) delete node.mobile;
            }

            var rows = [];
            rows.push(selectPropertyField('Display', function () { return get('display'); }, function (v) { set('display', v); }, DISPLAY_VALUES, onDisplayChange));
            rows.push(lengthField('Container size', function () { return get('container'); }, function (v) { set('container', v); }, 'e.g. 960px or 60rem. A centred max-width.'));
            rows.push(lengthField('Gap', function () { return get('gap'); }, function (v) { set('gap', v); }, 'Space between children, for flex or grid.'));

            var columnsInput = textField(get('columns'));
            columnsInput.addEventListener('input', function () {
                columnsInput.setAttribute('aria-invalid', isValidInteger(columnsInput.value, 1, MAX_COLUMNS) ? 'false' : 'true');
                set('columns', columnsInput.value);
                commitValue();
            });
            var columnsRow = field('Columns', columnsInput, 'Grid columns, 1–' + MAX_COLUMNS + '.');
            rows.push(columnsRow);

            var directionRow = selectPropertyField('Direction', function () { return get('direction'); }, function (v) { set('direction', v); }, FLEX_DIRECTIONS);
            var wrapInput = checkboxField(!!get('wrap'));
            wrapInput.addEventListener('change', function () {
                set('wrap', wrapInput.checked ? 'wrap' : '');
                commitValue(0);
            });
            var wrapRow = field('Wrap', wrapInput);
            rows.push(directionRow, wrapRow);

            rows.push(selectPropertyField('Align items', function () { return get('align'); }, function (v) { set('align', v); }, ALIGN_VALUES));
            rows.push(selectPropertyField('Justify content', function () { return get('justify'); }, function (v) { set('justify', v); }, JUSTIFY_VALUES));
            rows.push(selectPropertyField('Text align', function () { return get('text_align'); }, function (v) { set('text_align', v); }, TEXT_ALIGN_VALUES));

            function updateVisibility() {
                var display = get('display');
                var isGrid = display === 'grid' || display === 'inline-grid';
                var isFlex = display === 'flex' || display === 'inline-flex';
                columnsRow.hidden = !isGrid;
                directionRow.hidden = !isFlex;
                wrapRow.hidden = !isFlex;
            }
            updateVisibility();

            return { rows: rows, updateVisibility: updateVisibility };
        }

        /** The eight SpacingBlock-shaped fields - see sections.py's Spacing docstring section. */
        function spacingFields(node) {
            var data = node.spacing = node.spacing || {};
            function get(key) { return data[key] || ''; }
            function set(key, value) {
                if (value) data[key] = value;
                else delete data[key];
                if (Object.keys(data).length === 0) delete node.spacing;
            }

            function row(labelText, key, help) {
                return lengthField(labelText, function () { return get(key); }, function (v) { set(key, v); }, help);
            }

            var desktop = fieldset('Desktop', [
                row('Margin top', 'desktop_margin_top'),
                row('Padding top', 'desktop_padding_top'),
                row('Padding bottom', 'desktop_padding_bottom'),
                row('Margin bottom', 'desktop_margin_bottom'),
            ], 'Screens 960px and wider.');

            var mobile = fieldset('Mobile', [
                row('Margin top', 'mobile_margin_top'),
                row('Padding top', 'mobile_padding_top'),
                row('Padding bottom', 'mobile_padding_bottom'),
                row('Margin bottom', 'mobile_margin_bottom'),
            ], 'Smaller screens, and desktop too where no desktop size is set.');

            return el('div', { class: 've-sec-spacing' }, [desktop, mobile]);
        }

        function propertiesForm(node) {
            var base = layoutFields(node, false, function () {
                base.updateVisibility();
                mobile.updateVisibility();
            });
            var mobile = layoutFields(node, true);

            return el('div', { class: 've-sec-properties' }, [
                fieldset('Layout', base.rows),
                fieldset(
                    'Mobile override',
                    mobile.rows,
                    'Screens narrower than 960px. Leave a field blank to keep the value above at every width.',
                ),
                fieldset('Spacing', [spacingFields(node)]),
            ]);
        }

        // ------------------------------------------------------------------
        // Children: add / remove / move / recurse.
        // ------------------------------------------------------------------

        function addChildMenu(node, depth, onAdd) {
            var atMaxDepth = depth >= MAX_DEPTH;
            return el('div', { class: 've-sec-add-menu' }, [
                button('+ Heading', 'default', function () { onAdd(newNode('heading')); }),
                button('+ Rich text', 'default', function () { onAdd(newNode('rich_text')); }),
                atMaxDepth
                    ? el('span', { class: 've-sec-add-menu__limit', text: 'Nesting limit reached (' + MAX_DEPTH + ' levels).' })
                    : button('+ Section', 'default', function () { onAdd(newNode('section')); }),
            ]);
        }

        function childrenList(node, depth) {
            var list = el('div', { class: 've-sec-children' });
            node.children = node.children || [];

            node.children.forEach(function (child, index) {
                var controls = el('div', { class: 've-sec-node__controls' }, [
                    index > 0 ? button('↑', 'icon', function () {
                        node.children.splice(index - 1, 0, node.children.splice(index, 1)[0]);
                        commitStructure();
                    }) : null,
                    index < node.children.length - 1 ? button('↓', 'icon', function () {
                        node.children.splice(index + 1, 0, node.children.splice(index, 1)[0]);
                        commitStructure();
                    }) : null,
                    button('Remove', 'danger', function () {
                        if (window.confirm('Remove this ' + child.type.replace('_', ' ') + '?')) {
                            node.children.splice(index, 1);
                            commitStructure();
                        }
                    }),
                ]);
                list.appendChild(nodeEditor(child, depth, controls));
            });

            list.appendChild(
                addChildMenu(node, depth, function (child) {
                    node.children.push(child);
                    commitStructure();
                }),
            );

            return list;
        }

        // ------------------------------------------------------------------
        // One node, of whichever type, as a labelled card.
        // ------------------------------------------------------------------

        function nodeEditor(node, depth, controls) {
            var body;
            if (node.type === 'heading') {
                var level = selectField(node.level || 'h2', HEADING_LEVELS);
                level.addEventListener('change', function () {
                    node.level = level.value;
                    commitValue(0);
                });
                var text = textField(node.text, 'Heading text');
                text.addEventListener('input', function () {
                    node.text = text.value;
                    commitValue();
                });
                body = el('div', { class: 've-sec-node__body' }, [field('Level', level), field('Text', text)]);
            } else if (node.type === 'rich_text') {
                body = el('div', { class: 've-sec-node__body' }, [richTextEditor(node)]);
            } else {
                body = el('div', { class: 've-sec-node__body' }, [propertiesForm(node), childrenList(node, depth + 1)]);
            }

            var label = node.type === 'section' ? 'Section' : node.type === 'heading' ? 'Heading' : 'Rich text';
            var header = el('div', { class: 've-sec-node__header' }, [el('span', { class: 've-sec-node__label', text: label }), controls]);
            return el('div', { class: 've-sec-node ve-sec-node--' + node.type }, [header, body]);
        }

        // ------------------------------------------------------------------
        // Top-level render.
        // ------------------------------------------------------------------

        function render() {
            container.innerHTML = '';
            textarea.hidden = !rawMode;

            var toggle = button(rawMode ? 'Back to form' : 'View as JSON', 'default', toggleRawMode);
            container.appendChild(el('div', { class: 've-sec-toolbar' }, [toggle]));

            if (rawMode) {
                container.appendChild(el('p', { class: 've-sec-raw-help', text: 'Editing the raw JSON directly. Switch back to the form when you’re done.' }));
                return;
            }

            // The root is always treated as a section (see sections.py: NODE_TYPES
            // technically allows any type at the root, but a lone heading or rich
            // text block has no real use as "the whole section", and get_default()
            // always produces one) - so it gets properties + children, no type
            // chooser, no remove/move controls of its own.
            if (state.type !== 'section') state.type = 'section';
            container.appendChild(el('div', { class: 've-sec-root' }, [propertiesForm(state), childrenList(state, 1)]));
        }

        render();
    }

    window.VisualEditorSections = { init: init };
})();
