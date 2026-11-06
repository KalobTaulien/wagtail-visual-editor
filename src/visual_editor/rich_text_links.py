"""
"Open in new tab" for rich text links.

Wagtail's link feature only keeps a link's URL (or page id) when Draftail
converts rich text to and from its stored HTML, so a `target` attribute would be
dropped on the next save. This replaces the link feature's pieces so the choice
survives every save and reaches the front end:

- stored as `target="_blank" rel="noopener noreferrer"` on the `<a>`, for
  external links and page links (`<a linktype="page" id="3" target="_blank" …>`);
- carried in Draftail as `newTab: true` on the LINK entity, which the link
  chooser modal can set (see visual_editor/draftail_link_new_tab.js);
- rendered on page links by `NewTabPageLinkHandler`. External links are
  rendered as stored, so their attributes come through as they are.

Registered from `visual_editor.wagtail_hooks`, after Wagtail's own link feature.
"""

from django.urls import reverse_lazy
from django.utils.translation import gettext_lazy as _
from draftjs_exporter.dom import DOM
from wagtail.admin.rich_text.converters.contentstate import link_entity
from wagtail.admin.rich_text.converters.html_to_contentstate import (
    ExternalLinkElementHandler,
    PageLinkElementHandler,
)
from wagtail.admin.rich_text.editors.draftail import features as draftail_features
from wagtail.rich_text.pages import PageLinkHandler
from wagtail.whitelist import check_url

NEW_TAB_ATTRS = {"target": "_blank", "rel": "noopener noreferrer"}


def opens_in_new_tab(attrs):
    return attrs.get("target") == "_blank"


class NewTabExternalLinkElementHandler(ExternalLinkElementHandler):
    def get_attribute_data(self, attrs):
        data = super().get_attribute_data(attrs)
        if opens_in_new_tab(attrs):
            data["newTab"] = True
        return data


class NewTabPageLinkElementHandler(PageLinkElementHandler):
    def get_attribute_data(self, attrs):
        data = super().get_attribute_data(attrs)
        if opens_in_new_tab(attrs):
            data["newTab"] = True
        return data


def new_tab_link_entity(props):
    """Wagtail's `link_entity`, plus `target`/`rel` when the link opens in a new tab."""
    if not props.get("newTab"):
        return link_entity(props)
    if props.get("id") is not None:
        attrs = {"linktype": "page", "id": props["id"]}
    else:
        attrs = {"href": check_url(props.get("url"))}
    return DOM.create_element("a", {**attrs, **NEW_TAB_ATTRS}, props["children"])


class NewTabPageLinkHandler(PageLinkHandler):
    """Renders page links like Wagtail does, keeping `target`/`rel` for links that open in a new tab."""

    @classmethod
    def expand_db_attributes_many(cls, attrs_list):
        tags = super().expand_db_attributes_many(attrs_list)
        return [
            f'{tag[:-1]} target="_blank" rel="noopener noreferrer">' if opens_in_new_tab(attrs) and tag != "<a>" else tag
            for tag, attrs in zip(tags, attrs_list)
        ]


def register_link_new_tab(features):
    """Replace the "link" feature's editor plugin, converter rule and page link handler with new-tab-aware ones."""
    features.register_link_type(NewTabPageLinkHandler)

    features.register_editor_plugin(
        "draftail",
        "link",
        draftail_features.EntityFeature(
            {
                "type": "LINK",
                "icon": "link",
                "description": _("Link"),
                # As Wagtail's own, plus `newTab` so it survives pasting links between editors.
                "attributes": ["url", "id", "parentId", "newTab"],
                "allowlist": {"href": "^(http:|https:|undefined$)"},
                "chooserUrls": {
                    "pageChooser": reverse_lazy("wagtailadmin_choose_page"),
                    "externalLinkChooser": reverse_lazy("wagtailadmin_choose_page_external_link"),
                    "emailLinkChooser": reverse_lazy("wagtailadmin_choose_page_email_link"),
                    "phoneLinkChooser": reverse_lazy("wagtailadmin_choose_page_phone_link"),
                    "anchorLinkChooser": reverse_lazy("wagtailadmin_choose_page_anchor_link"),
                },
            },
            js=[
                "wagtailadmin/js/page-chooser-modal.js",
                "visual_editor/draftail_link_new_tab.js",
            ],
        ),
    )

    features.register_converter_rule(
        "contentstate",
        "link",
        {
            "from_database_format": {
                "a[href]": NewTabExternalLinkElementHandler("LINK"),
                'a[linktype="page"]': NewTabPageLinkElementHandler("LINK"),
            },
            "to_database_format": {"entity_decorators": {"LINK": new_tab_link_entity}},
        },
    )
