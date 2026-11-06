/*
 * "Open in new tab" for Draftail links (server side: visual_editor/rich_text_links.py).
 *
 * Wagtail's link source opens the link chooser modal (internal page, external
 * URL, email, phone, anchor). This subclass adds an "Open link in a new tab"
 * checkbox to every step of that modal, and records the choice as `newTab` on
 * the LINK entity, which the server stores as target="_blank".
 *
 * Loaded as part of the "link" rich text feature's media, after draftail.js.
 */
(() => {
    const CHECKBOX_ID = 'draftail-link-new-tab';

    function addCheckbox(modal, source) {
        const body = modal.body && (modal.body.jquery ? modal.body[0] : modal.body);
        if (!body || !body.isConnected || body.querySelector(`#${CHECKBOX_ID}`)) return;

        const field = document.createElement('div');
        field.className = 'draftail-link-new-tab';
        field.style.cssText = 'display: flex; align-items: center; gap: .5rem; margin: 0 0 1.25rem;';
        field.innerHTML = `
            <input type="checkbox" id="${CHECKBOX_ID}">
            <label for="${CHECKBOX_ID}" class="w-field__label" style="margin: 0">Open link in a new tab</label>`;
        const checkbox = field.querySelector('input');
        checkbox.checked = source.newTab;
        checkbox.addEventListener('change', () => {
            source.newTab = checkbox.checked;
        });

        // Under the "Internal link | External link | ..." switcher, in the content column.
        const linkTypes = body.querySelector('.link-types');
        if (linkTypes) {
            linkTypes.insertAdjacentElement('afterend', field);
        } else {
            field.style.padding = '1rem 2.5rem 0';
            const header = body.querySelector('header');
            if (header) header.insertAdjacentElement('afterend', field);
            else body.prepend(field);
        }
    }

    function install() {
        const { draftail } = window;
        if (!draftail || !draftail.LinkModalWorkflowSource || window.draftailLinkNewTabInstalled) return Boolean(window.draftailLinkNewTabInstalled);

        class NewTabLinkSource extends draftail.LinkModalWorkflowSource {
            getChooserConfig(entity, selectedText) {
                const config = super.getChooserConfig(entity, selectedText);
                this.newTab = Boolean(entity && entity.getData().newTab);
                // Every step of the modal (browsing pages, the external link form, ...)
                // replaces its content, so add the checkbox after each one loads.
                config.onload = Object.fromEntries(
                    Object.entries(config.onload || {}).map(([step, handler]) => [
                        step,
                        (modal, jsonData) => {
                            handler(modal, jsonData);
                            addCheckbox(modal, this);
                        },
                    ]),
                );
                return config;
            }

            filterEntityData(data) {
                const entityData = super.filterEntityData(data);
                return this.newTab ? { ...entityData, newTab: true } : entityData;
            }
        }

        // registerPlugin returns the live plugin registry; swap the LINK plugin's
        // source, keeping Wagtail's decorator (how links display) and paste handling.
        const plugins = draftail.registerPlugin({ type: '__draftail_link_new_tab__' }, 'entityTypes');
        delete plugins.__draftail_link_new_tab__;
        if (!plugins.LINK) return false;
        plugins.LINK = { ...plugins.LINK, source: NewTabLinkSource };
        window.draftailLinkNewTabInstalled = true;
        return true;
    }

    if (!install()) document.addEventListener('DOMContentLoaded', install);
})();
