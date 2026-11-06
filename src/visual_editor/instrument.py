"""Mark up a page's values so the rendered HTML can be mapped back to fields and blocks."""

import logging

from django.utils.html import format_html
from django.utils.safestring import mark_safe
from wagtail import blocks
from wagtail.blocks.list_block import ListValue
from wagtail.blocks.stream_block import StreamValue
from wagtail.rich_text import RichText

from visual_editor.rich_text import MarkedRichText, toolbar_for

logger = logging.getLogger("cms")

# Supplementary Private Use Area-A code points: invisible in practice, never escaped
# by Django, and stripped by `slugify`, so anchor ids built from marked text stay
# intact. (Not the BMP Private Use Area: icon fonts like FontAwesome live there.)
START = "\U000f0000"
SEP = "\U000f0001"
END = "\U000f0002"
DIGIT_ZERO = 0xF0010

# Name parts of text fields that end up in URLs, embed markup or attributes rather
# than visible copy. Wrapping those in markers would corrupt the markup.
NON_COPY_NAME_PARTS = {
    "anchor",
    "class",
    "code",
    "color",
    "colour",
    "css",
    "email",
    "embed",
    "href",
    "html",
    "icon",
    "id",
    "js",
    "script",
    "slug",
    "style",
    "url",
}


def is_copy_name(name: str | None) -> bool:
    """Return whether a field/block name looks like visible copy rather than markup or a URL."""
    return not any(part in NON_COPY_NAME_PARTS for part in (name or "").lower().split("_"))


class MarkedStr(str):
    """
    A string carrying invisible markers.

    `len()` (and so the `|length` filter and truthiness) report the visible text,
    so templates like `{% if page.title|length > 30 %}` behave as they do live.
    """

    visible = ""

    def __len__(self):
        return len(self.visible)


class Registry:
    """Hands out marker ids for text values and remembers where each value lives in the editor state."""

    def __init__(self):
        self.entries = []

    def mark(self, value, path, multiline=False, readonly=False, choices=None, numeric=False):
        """`readonly` values are still mapped (clicking them selects what they belong to) but not editable.

        `choices` (a list of `(value, label)` pairs) marks the value as a choice field: the canvas
        shows an inline dropdown instead of letting it be typed into. `numeric` hints that only digits
        (and `.`/`-`) should be accepted when it's typed into in place.
        """
        if not isinstance(value, str) or isinstance(value, MarkedStr) or not value.strip():
            return value

        index = len(self.entries)
        entry = {"path": path, "value": str(value), "multiline": multiline}
        if readonly:
            entry["readonly"] = True
        if choices is not None:
            entry["choices"] = choices
        if numeric:
            entry["numeric"] = True
        self.entries.append(entry)
        digits = "".join(chr(DIGIT_ZERO + int(digit)) for digit in str(index))
        marked = MarkedStr(f"{START}{digits}{SEP}{value}{END}")
        marked.visible = str(value)
        return marked

    def mark_rich_text(self, value, path, features, readonly=False):
        """Rich text is bracketed with `<template>` markers rather than text markers, since it renders HTML."""
        if not isinstance(value, RichText) or isinstance(value, MarkedRichText) or not value.source.strip():
            return value
        index = len(self.entries)
        self.entries.append(
            {
                "path": path,
                "value": value.source,
                "kind": "richtext",
                "features": features,
                "toolbar": toolbar_for(features),
                **({"readonly": True} if readonly else {}),
            }
        )
        return MarkedRichText(value.source, index)


# FieldBlocks whose value is a bare number: edited in place like text, but
# the canvas restricts what can be typed to digits, "." and "-".
NUMERIC_BLOCKS = (blocks.IntegerBlock, blocks.FloatBlock, blocks.DecimalBlock)


def _choice_pairs(block):
    """Flatten a ChoiceBlock's `choices` (which may use Django's optgroup format) to `(value, label)` pairs."""
    pairs = []
    for value, label in block.field.choices:
        if isinstance(label, (list, tuple)):
            pairs.extend((str(group_value), str(group_label)) for group_value, group_label in label)
        else:
            pairs.append((str(value), str(label)))
    return pairs


def mark_block_value(block, value, path, registry):
    """
    Wrap every free-text value inside a block value in markers, recursively.

    `path` addresses the value inside the editor state: dict keys for struct
    children, and `#<id>` segments for list items and stream children.
    """
    if value is None:
        return value

    if isinstance(block, blocks.StructBlock):
        for name, child_block in block.child_blocks.items():
            if name in value:
                value[name] = mark_block_value(child_block, value[name], [*path, name], registry)
        return value

    if isinstance(block, blocks.ListBlock):
        if isinstance(value, ListValue):
            for item in value.bound_blocks:
                item.value = mark_block_value(block.child_block, item.value, [*path, f"#{item.id}", "value"], registry)
        return value

    if isinstance(block, blocks.StreamBlock):
        if isinstance(value, StreamValue):
            for child in value:
                if child.id:
                    child.value = mark_block_value(child.block, child.value, [*path, f"#{child.id}", "value"], registry)
        return value

    if isinstance(block, blocks.RichTextBlock):
        return registry.mark_rich_text(value, path, block.features)

    # Blocks can opt out of in-place editing (`inline_editable = False`), e.g. a
    # spacing field: its value is a CSS length, not text shown on the page.
    if not getattr(block, "inline_editable", True):
        return value

    if isinstance(block, (blocks.CharBlock, blocks.TextBlock)) and is_copy_name(block.name):
        return registry.mark(value, path, multiline=isinstance(block, blocks.TextBlock))

    if isinstance(block, NUMERIC_BLOCKS):
        return registry.mark(str(value), path, numeric=True)

    # Not MultipleChoiceBlock: its value is a list of choices, not a single one,
    # so it isn't offered the inline dropdown (it isn't a ChoiceBlock subclass anyway).
    if isinstance(block, blocks.ChoiceBlock):
        return registry.mark(str(value), path, choices=_choice_pairs(block))

    return value


class MarkedStreamChild(StreamValue.StreamChild):
    """
    A top-level stream child whose rendered HTML is bracketed with `<template>` markers.

    `<template>` survives the BeautifulSoup round trips some template tags put
    block HTML through (HTML comments would not), and renders nothing. The
    browser removes the markers once it has tagged the block's elements.

    Rendering errors are caught so one broken block can't take down the whole
    canvas, and empty output gets a placeholder so the block is still clickable.
    """

    ve_key = ""

    def _bracket(self, render, *args):
        label = self.block.label or self.block_type
        try:
            html = render(*args)
        except Exception as e:  # noqa: BLE001 - surfaced on the canvas instead
            logger.warning("Visual editor: block %s failed to render", self.ve_key, exc_info=True)
            html = format_html(
                '<div class="ve-block-placeholder ve-block-placeholder--error">'
                "<strong>{}</strong> can’t be previewed yet. Click it and fill in its options."
                '<br><small style="opacity:.7">{}</small></div>',
                label,
                f"{type(e).__name__}: {e}",
            )
        if not str(html).strip():
            html = format_html(
                '<div class="ve-block-placeholder"><strong>{}</strong> has nothing to show yet. '
                "Click to edit it.</div>",
                label,
            )
        return mark_safe(
            f'<template data-ve-start="{self.ve_key}"></template>{html}<template data-ve-end="{self.ve_key}"></template>'
        )

    def render(self, context=None):
        return self._bracket(super().render, context)

    def render_as_block(self, context=None):
        return self._bracket(super().render_as_block, context)

    def __str__(self):
        return self._bracket(super().__str__)


def instrument_page(page, schema, registry):
    """Mark the page's text fields and stream blocks in place. `page` must be a throwaway copy."""
    for name in schema.text_field_names:
        value = getattr(page, name, None)
        if isinstance(value, str):
            setattr(page, name, registry.mark(value, ["fields", name], multiline=name in schema.multiline_field_names))

    # Templates render these with `|richtext`, which passes a RichText straight through.
    for name in schema.rich_text_field_names:
        value = getattr(page, name, None)
        if isinstance(value, str):
            features = getattr(schema.model_field(name), "features", None)
            setattr(page, name, registry.mark_rich_text(RichText(value), ["fields", name], features))

    for name in schema.stream_field_names:
        stream = getattr(page, name)
        for child in stream:
            if not child.id:
                continue
            child.value = mark_block_value(
                child.block, child.value, ["streams", name, f"#{child.id}", "value"], registry
            )
            child.__class__ = MarkedStreamChild
            child.ve_key = f"{name}:{child.id}"
