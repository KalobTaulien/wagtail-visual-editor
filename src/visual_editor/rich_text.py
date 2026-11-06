"""
Inline rich text editing on the canvas.

Rich text renders on the canvas as normal front-end HTML, except that each
page/document link carries its stored attributes (`data-ve-link`) and each
embed (images, media) is wrapped in a non-editable `<ve-embed>` carrying its
`<embed>` attributes. That lets the browser edit the HTML in place and send it
back; `editable_to_database` restores the stored link and embed forms and runs
the result through Draftail's own converter, so what's saved is exactly what
Draftail would save, limited to the block's features.
"""

import json
from functools import lru_cache

from bs4 import BeautifulSoup, Comment, NavigableString
from django.utils.html import format_html
from django.utils.safestring import mark_safe
from wagtail.admin.rich_text.converters.contentstate import ContentstateConverter
from wagtail.rich_text import RichText
from wagtail.rich_text import features as feature_registry
from wagtail.rich_text.rewriters import EmbedRewriter, LinkRewriter, MultiRuleRewriter


def _feature_names(features):
    return list(features) if features is not None else feature_registry.get_default_features()


def _tag_links(expand_many):
    """Wrap a link handler so each opening `<a>` it produces also records the stored attributes."""

    def rule(attrs_list):
        tags = expand_many(attrs_list)
        return [
            tag[:2] + format_html(' data-ve-link="{}"', json.dumps(attrs)) + tag[2:] if tag.startswith("<a") else tag
            for tag, attrs in zip(tags, attrs_list)
        ]

    return rule


def _tag_embeds(expand_many):
    """Wrap an embed handler so its output sits in a non-editable `<ve-embed>` recording the `<embed>`."""

    def rule(attrs_list):
        return [
            format_html(
                '<ve-embed data-ve-embed="{}" contenteditable="false">{}</ve-embed>', json.dumps(attrs), mark_safe(html)
            )
            for html, attrs in zip(expand_many(attrs_list), attrs_list)
        ]

    return rule


@lru_cache(maxsize=None)
def _editable_rewriter():
    """Like `wagtail.rich_text.get_rewriter`, with links and embeds tagged for round-tripping."""
    return MultiRuleRewriter(
        [
            LinkRewriter(
                bulk_rules={
                    linktype: _tag_links(handler.expand_db_attributes_many)
                    for linktype, handler in feature_registry.get_link_types().items()
                }
            ),
            EmbedRewriter(
                bulk_rules={
                    embedtype: _tag_embeds(handler.expand_db_attributes_many)
                    for embedtype, handler in feature_registry.get_embed_types().items()
                }
            ),
        ]
    )


class MarkedRichText(RichText):
    """A RichText that renders editable HTML bracketed by `<template data-ve-rt-*>` markers for the canvas."""

    def __init__(self, source, index):
        super().__init__(source)
        self.ve_index = index

    def __html__(self):
        return (
            f'<template data-ve-rt-start="{self.ve_index}"></template>'
            f"{_editable_rewriter()(self.source)}"
            f'<template data-ve-rt-end="{self.ve_index}"></template>'
        )


def _spec(value):
    return {"element": value} if isinstance(value, str) else dict(value)


@lru_cache(maxsize=None)
def _toolbar(features):
    controls = []
    for name in features:
        plugin = feature_registry.get_editor_plugin("draftail", name)
        to_db = (feature_registry.get_converter_rule("contentstate", name) or {}).get("to_database_format", {})
        data = getattr(plugin, "data", None) or {}
        icon = data.get("icon")
        control = {
            "name": name,
            "description": str(data.get("description") or name),
            "label": str(data.get("label") or ""),
            "icon": icon if isinstance(icon, str) else None,
        }
        if "style_map" in to_db:
            spec = _spec(next(iter(to_db["style_map"].values())))
            control.update(kind="inline", element=spec["element"], attrs=spec.get("props", {}))
        elif "block_map" in to_db:
            spec = _spec(next(iter(to_db["block_map"].values())))
            control.update(kind="block", element=spec["element"], wrapper=spec.get("wrapper"))
        elif data.get("type") == "LINK":
            control.update(kind="link", pageChooser=(data.get("chooserUrls") or {}).get("pageChooser"))
        elif "HORIZONTAL_RULE" in to_db.get("entity_decorators", {}):
            control.update(kind="hr", description="Horizontal line", label="―")
        elif to_db.get("entity_decorators"):
            # Images, embeds, documents: these need Wagtail's choosers, so they're added from the sidebar.
            control.update(kind="sidebar")
        else:
            continue
        controls.append(control)
    return controls


def toolbar_for(features):
    """The canvas toolbar controls for a rich text block's features, derived from Draftail's feature registry."""
    return _toolbar(tuple(_feature_names(features)))


def editable_to_database(html, features):
    """Convert HTML edited on the canvas back to Wagtail's stored rich text format."""
    soup = BeautifulSoup(html, "html.parser")

    for node in soup.select("ve-embed"):
        try:
            attrs = json.loads(node.get("data-ve-embed", ""))
        except ValueError:
            node.decompose()
            continue
        node.replace_with(soup.new_tag("embed", attrs={key: str(value) for key, value in attrs.items()}))

    for link in soup.select("a[data-ve-link]"):
        # Whether it opens in a new tab is whatever the link says now, not what was stored.
        new_tab = link.get("target") == "_blank"
        try:
            stored = json.loads(link["data-ve-link"])
        except ValueError:
            del link["data-ve-link"]
            continue
        link.attrs = {key: str(value) for key, value in stored.items() if key not in ("target", "rel")}
        if new_tab:
            link["target"] = "_blank"

    # Template indentation around the rich text arrives as top-level whitespace,
    # which the converter would turn into empty paragraphs.
    for node in list(soup.contents):
        if isinstance(node, NavigableString) and not isinstance(node, Comment) and not node.strip():
            node.extract()

    # Browsers copy block keys when splitting paragraphs; let Draftail assign fresh ones.
    for node in soup.find_all(attrs={"data-block-key": True}):
        del node["data-block-key"]

    # Classed divs are the alignment features (`<p><div class="block text-center">`).
    # Browsers can't nest a div in a paragraph, so they parse that as
    # `<p></p><div …></div><p></p>`; put the div back inside its paragraph.
    for node in soup.find_all("div", recursive=False):
        if not node.get("class"):
            continue
        before = node.find_previous_sibling()
        after = node.find_next_sibling()
        if before is not None and before.name == "p" and not before.contents:
            before.append(node.extract())
            if after is not None and after.name == "p" and not after.contents:
                after.decompose()

    # A bare div is browser editing debris (and would be read as an alignment style).
    for node in soup.find_all("div"):
        if not node.get("class"):
            node.unwrap()

    converter = ContentstateConverter(_feature_names(features))
    return converter.to_database_format(converter.from_database_format(str(soup)))
