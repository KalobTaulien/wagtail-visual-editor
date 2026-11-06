"""
Fully custom `<section>` blocks: an arbitrarily nested layout tree stored as JSON.

Why this isn't a StructBlock
----------------------------
Every other block in a Wagtail project declares its shape up front, and that shape
becomes part of the StreamField's migration state. This block is for layout an editor
invents on the page - a three-column grid holding two flex rows, one of which holds
another grid - which has no fixed shape to declare. So the whole tree lives in one
JSON value (`CustomSectionBlock`, a `FieldBlock` over `forms.JSONField`). Adding a
nesting level or a new property changes no schema and needs no migration.

The trade-off is that nothing in Django or Wagtail validates the contents for us, so
this module does it instead: every value an author can set is checked against a
whitelist here before it reaches the page. Unknown keys and invalid values are
reported on save and dropped on render - never passed through.

Two shapes of the same tree
---------------------------
- **Source** - what's stored, and what an author edits:
  `{"type": "section", "display": "grid", "columns": 3, "children": [...]}`.
  `_clean_node` canonicalises this on save: it normalises values ("24" -> "24px"),
  assigns each node a stable `id`, and drops keys it doesn't recognise.
- **Render** - what the template consumes: `{"type", "id", "tag", "classes",
  "style", "children"}`, where `style`/`classes` are finished HTML attribute
  strings. `_render_node` computes this from source on every render. It is
  deliberately total: given any JSON at all it returns something renderable or
  `None`, and never raises, so hand-edited or stale data can't 500 a live page.

How a node becomes CSS
----------------------
`STYLE_PROPERTIES` maps each source key to a real CSS property, a short suffix, and
a validator. For the *base* (desktop and up) values, the matching CSS declarations
go straight into the element's `style` attribute - only the properties actually set,
so a section never resets a property the host's own CSS wanted to control.

Mobile overrides can't go in `style` (there's no media query inside an inline
style), so each one is emitted two ways: the value as a custom property
(`--ve-sec-<suffix>-m`) in the same `style` attribute, and an opt-in class
(`ve-section--m-<suffix>`) that a media query in `static/visual_editor/sections.css`
uses to apply it below the breakpoint. That stylesheet's rules are `!important`
because an inline `style` otherwise wins over any stylesheet rule regardless of
specificity. A property with no mobile override gets neither the variable nor the
class, so it simply keeps its base value at every width.

The breakpoint (60rem / 960px) for *these* properties is the same one
`spacing.SpacingBlock` documents, so the two systems agree on where "mobile" ends.
Note the direction differs: `SpacingBlock` is mobile-first (mobile values are the
base, desktop overrides from 60rem up), while these properties are desktop-first
(the base values apply everywhere, mobile overrides *below* 60rem) - which is what
"all attrs can be overridden for mobile" asks for. The two directions reach the
same place either way: one value above 960px, optionally a different one below it.

Spacing
-------
Margin and padding use `SpacingBlock` itself rather than another property on this
list - the exact same fields, bounds, CSS variables and utility classes as every
other block in this project (`CardBlock`, `HeroBlock`, ...). A node's `spacing` key
holds `SpacingBlock`'s own field names (`desktop_margin_top`, `mobile_padding_top`,
...); `spacing.spacing_lengths`/`spacing_attrs` - factored out of `SpacingValue` for
exactly this reuse - turn it into the same `class="mt-[var(--space-mt)] ..."` /
`style="--space-mt: 24px; ..."` pair a StructBlock's `value.spacing.classes`/`.style`
would produce. `static/css/testsite.css`'s hand-written utilities (see that file's
own comment) already cover these classes, so a custom section's spacing needs no
rule of its own in `sections.css` - only the desktop-first layout properties above
do.

Installing
----------
`static/visual_editor/sections.css` must be included by the host project's *front
end* template (not just the admin) for the layout properties' mobile overrides to
apply - their base styles are inline and work without it, and spacing is covered by
whatever already serves `SpacingBlock`. The visual editor's canvas renders the real
page template, so including it once on the front end covers the editor too.

Authoring
---------
`SectionEditorWidget` (below) renders a structured form - fields for each property,
an "Add section/heading/rich text" menu per level - built entirely in
`static/visual_editor/section_editor.js`, against a hidden textarea holding the
real JSON value. That script duplicates this module's whitelists (`DISPLAY_VALUES`,
`FLEX_DIRECTIONS`, ...) in JS, flagged with a comment, because there's no shared
source between a Python validator and a hand-built form; keep the two in step. The
widget renders a Django `<textarea>` as a form fallback (and as an escape hatch -
the UI keeps a "View as JSON" toggle onto the same element), so nothing here stops
working if the JS fails to load; the UI is progressive enhancement over it, not a
replacement.

`inline_editable = False` keeps `instrument.py` from trying to mark the JSON blob
as editable copy on the canvas; the block is still selectable there, and its
sidebar form is this structured editor.
"""

import json
import uuid

from django import forms
from django.core.exceptions import ValidationError
from django.template.loader import render_to_string
from django.utils.safestring import mark_safe
from wagtail.blocks import FieldBlock
from wagtail.rich_text import RichText

from visual_editor.spacing import SPACING_UTILITIES, parse_length, spacing_attrs

# The same pattern SpacingBlock accepts, so a length means the same thing in both
# places ("24" -> 24px, "1.5REM" -> 1.5rem). Only the bounds differ here, per
# property: a 1440px container is ordinary, a 1440px margin is a typo. (Margin and
# padding use `spacing.parse_length` directly instead - see the Spacing section
# above - so this is only for `container` and `gap`.)
from visual_editor.spacing import LENGTH as LENGTH_PATTERN

# A section nested this many levels deep stops accepting children. Guards against a
# pasted tree (or a cycle introduced by hand) walking the renderer into a stack
# overflow; five levels is far past anything a real layout needs.
MAX_DEPTH = 5

# Grid column counts beyond this are almost certainly a typo, and each one costs
# layout work on every render.
MAX_COLUMNS = 12

NODE_TYPES = ("section", "heading", "rich_text")

HEADING_LEVELS = ("h1", "h2", "h3", "h4", "h5", "h6")

# `display` values worth offering. Table and ruby displays are left out: they only
# behave sensibly with matching child displays, which this block can't guarantee.
DISPLAY_VALUES = (
    "block",
    "flex",
    "grid",
    "inline",
    "inline-block",
    "inline-flex",
    "inline-grid",
    "flow-root",
    "contents",
    "none",
)

FLEX_DIRECTIONS = ("row", "row-reverse", "column", "column-reverse")

# Both the modern (`start`/`end`) and flex-prefixed spellings, since authors reach
# for either and browsers accept both.
ALIGN_VALUES = ("start", "end", "center", "stretch", "baseline", "flex-start", "flex-end")

JUSTIFY_VALUES = (
    "start",
    "end",
    "center",
    "stretch",
    "space-between",
    "space-around",
    "space-evenly",
    "flex-start",
    "flex-end",
)

TEXT_ALIGN_VALUES = ("left", "center", "right", "justify", "start", "end")


# Validators below return a *canonical source* value - what gets stored - which for
# most properties is already the CSS value. Where it isn't (a column count, a wrap
# boolean), a separate `to_css` converter in STYLE_PROPERTIES turns it into one.
#
# Keeping those two steps apart is what makes clean and render idempotent: cleaning
# already-clean data is a no-op, and the renderer re-validates stored source rather
# than trying to re-parse CSS it emitted earlier.


def _keyword(allowed, label):
    """A validator accepting one of `allowed` (case-insensitively), or nothing."""

    def validate(value):
        text = str(value if value is not None else "").strip().lower()
        if not text:
            return None
        if text not in allowed:
            raise ValueError(f"{label} must be one of: {', '.join(allowed)}.")
        return text

    return validate


def _length(label, max_px, max_rem, allow_negative=True):
    """A validator for a CSS length in px or rem, bounded per property."""

    def validate(value):
        text = str(value if value is not None else "").strip().lower().replace(" ", "")
        if not text:
            return None
        match = LENGTH_PATTERN.match(text)
        if not match:
            raise ValueError("enter a size in px or rem, like 24px or 1.5rem.")
        number = float(match["number"])
        unit = match["unit"] or "px"
        if number < 0 and not allow_negative:
            raise ValueError(f"{label} can’t be negative.")
        if abs(number) > (max_px if unit == "px" else max_rem):
            raise ValueError(f"{label} must be within {max_px}px or {max_rem}rem.")
        return f"{number:g}{unit}"

    return validate


def _column_count(value):
    """A grid column count, stored as the integer the author chose."""
    text = str(value if value is not None else "").strip()
    if not text:
        return None
    try:
        count = int(text)
    except ValueError as e:
        raise ValueError("Columns must be a whole number.") from e
    if not 1 <= count <= MAX_COLUMNS:
        raise ValueError(f"Columns must be between 1 and {MAX_COLUMNS}.")
    return count


def _columns_to_css(count):
    """`minmax(0, 1fr)` rather than a bare `1fr` so a long word or wide image in one
    column can't push its track past its share of the row."""
    return f"repeat({count}, minmax(0, 1fr))"


def _wrap(value):
    """Whether flex children wrap. Absent means "not set"; anything else is a boolean."""
    if value is None or value == "":
        return None
    if isinstance(value, str):
        return value.strip().lower() in ("true", "yes", "on", "1", "wrap")
    return bool(value)


# Source key -> (CSS property, suffix used in the mobile variable and class,
#                source validator, source -> CSS converter).
#
# Adding a row here is all it takes to offer a new property, with one caveat: the
# mobile half also needs a rule in `static/visual_editor/sections.css` keyed on
# `ve-section--m-<suffix>`, or the override will validate and store but do nothing.
# Margin/padding aren't here - see the Spacing section of this module's docstring.
#
# `container`'s bound is deliberately far looser than a length typically gets (a
# 1440px content column is ordinary) but still bounded, so the value can't be used
# to blow out a layout.
STYLE_PROPERTIES = {
    "display": ("display", "display", _keyword(DISPLAY_VALUES, "Display"), str),
    "container": ("max-width", "container", _length("Container", 4000, 250, allow_negative=False), str),
    "gap": ("gap", "gap", _length("Gap", 1000, 60, allow_negative=False), str),
    "columns": ("grid-template-columns", "columns", _column_count, _columns_to_css),
    "direction": ("flex-direction", "direction", _keyword(FLEX_DIRECTIONS, "Direction"), str),
    "wrap": ("flex-wrap", "wrap", _wrap, lambda value: "wrap" if value else "nowrap"),
    "align": ("align-items", "align", _keyword(ALIGN_VALUES, "Align"), str),
    "justify": ("justify-content", "justify", _keyword(JUSTIFY_VALUES, "Justify"), str),
    "text_align": ("text-align", "text-align", _keyword(TEXT_ALIGN_VALUES, "Text align"), str),
}

# Keys that mean something on a node but aren't style properties, so that anything
# *else* an author typed can be reported as a mistake rather than silently ignored.
STRUCTURAL_KEYS = frozenset({"type", "id", "mobile", "spacing", "children", "level", "text", "value"})

# The base class each node type gets, as a styling hook for the host project.
BASE_CLASSES = {
    "section": "ve-section",
    "heading": "ve-section__heading",
    "rich_text": "ve-section__text",
}


def _style_values(raw, errors, path):
    """Validate the style keys of one node (or of its `mobile` dict).

    Returns `{source key: CSS value}` for the keys that were set and valid. Invalid
    values are appended to `errors` and left out, so a single bad length doesn't
    discard the rest of the node's styling.
    """
    values = {}
    if not isinstance(raw, dict):
        return values
    for key, (_css_property, _suffix, validate, _to_css) in STYLE_PROPERTIES.items():
        if key not in raw:
            continue
        try:
            value = validate(raw[key])
        except ValueError as e:
            errors.append(f"{path}{key}: {e}")
            continue
        if value is not None:
            values[key] = value
    return values


def _unknown_keys(raw, path, errors):
    """Report keys that are neither a style property nor structural, so typos surface."""
    if not isinstance(raw, dict):
        return
    for key in raw:
        if key not in STYLE_PROPERTIES and key not in STRUCTURAL_KEYS:
            errors.append(f"{path}{key}: not a property this block understands.")


def _clean_spacing(raw, errors, path):
    """
    Validate a node's `spacing` dict against exactly `SpacingBlock`'s own fields,
    using `spacing.parse_length` directly - the same bounds and px/rem rules as
    every other block's spacing, because it's the same function.
    """
    if raw is None:
        return None
    if not isinstance(raw, dict):
        errors.append(f"{path}spacing: must be a JSON object.")
        return None
    cleaned = {}
    for name in SPACING_UTILITIES:
        if name not in raw:
            continue
        try:
            length = parse_length(raw[name], allow_negative="margin" in name)
        except ValueError as e:
            errors.append(f"{path}spacing {name.replace('_', ' ')}: {e}")
            continue
        if length:
            cleaned[name] = length
    for key in raw:
        if key not in SPACING_UTILITIES:
            errors.append(f"{path}spacing {key}: not a spacing field.")
    return cleaned or None


def _attributes(base, mobile, spacing, node_type):
    """Turn validated base, mobile and spacing source values into finished `style`/`class` strings.

    Base values become plain declarations; mobile values become the custom properties
    that `sections.css` reads, plus the per-property class that opts each one in.
    Spacing is delegated to `spacing.spacing_attrs` - see this module's docstring.
    """
    declarations = []
    for key, value in base.items():
        css_property, _suffix, _validate, to_css = STYLE_PROPERTIES[key]
        declarations.append(f"{css_property}: {to_css(value)}")
        # "Container size" means a centred column, not just a width cap.
        if key == "container":
            declarations += ["margin-left: auto", "margin-right: auto"]

    classes = [BASE_CLASSES[node_type]]
    for key, value in mobile.items():
        _css_property, suffix, _validate, to_css = STYLE_PROPERTIES[key]
        declarations.append(f"--ve-sec-{suffix}-m: {to_css(value)}")
        classes.append(f"ve-section--m-{suffix}")

    spacing_classes, spacing_style = spacing_attrs(spacing)
    if spacing_classes:
        classes.append(spacing_classes)

    style = "; ".join(declarations)
    style = f"{style};" if style else ""
    if spacing_style:
        style = f"{style} {spacing_style}".strip()
    return style, " ".join(classes)


def _node_type(raw, path, errors):
    """The node's type, defaulting to `section`. Returns None if it's not a usable node."""
    if not isinstance(raw, dict):
        errors.append(f"{path or 'root'}: each node must be a JSON object.")
        return None
    node_type = str(raw.get("type") or "section").strip().lower()
    if node_type not in NODE_TYPES:
        errors.append(f"{path}type: unknown node type “{node_type}”. Use one of: {', '.join(NODE_TYPES)}.")
        return None
    return node_type


def _heading_level(raw, path, errors):
    level = str(raw.get("level") or "h2").strip().lower()
    if level not in HEADING_LEVELS:
        errors.append(f"{path}level: must be one of: {', '.join(HEADING_LEVELS)}.")
        return "h2"
    return level


def _child_path(path, index):
    return f"{path}child {index + 1} "


def _clean_node(raw, errors, path="", depth=0):
    """
    Canonicalise one source node: normalised values, a stable `id`, no unknown keys.

    Used by `CustomSectionBlock.clean`, so `errors` collecting anything means the save
    is rejected and the author is told what to fix. Returns None for a node that isn't
    salvageable (its parent leaves it out).
    """
    node_type = _node_type(raw, path, errors)
    if node_type is None:
        return None
    _unknown_keys(raw, path, errors)

    node = {"type": node_type, "id": str(raw.get("id") or uuid.uuid4())}
    node.update(_style_values(raw, errors, path))

    mobile = _style_values(raw.get("mobile"), errors, f"{path}mobile ")
    _unknown_keys(raw.get("mobile"), f"{path}mobile ", errors)
    if mobile:
        node["mobile"] = mobile

    spacing = _clean_spacing(raw.get("spacing"), errors, path)
    if spacing:
        node["spacing"] = spacing

    if node_type == "heading":
        node["level"] = _heading_level(raw, path, errors)
        text = str(raw.get("text") or "").strip()
        if not text:
            errors.append(f"{path}text: a heading needs some text.")
        node["text"] = text
    elif node_type == "rich_text":
        value = raw.get("value")
        node["value"] = value.source if isinstance(value, RichText) else str(value or "")
    else:
        children = raw.get("children") or []
        if not isinstance(children, list):
            errors.append(f"{path}children: must be a list of nodes.")
            children = []
        if children and depth >= MAX_DEPTH:
            errors.append(f"{path}children: sections can only be nested {MAX_DEPTH} levels deep.")
            children = []
        cleaned_children = []
        for index, item in enumerate(children):
            child = _clean_node(item, errors, _child_path(path, index), depth + 1)
            if child is not None:
                cleaned_children.append(child)
        node["children"] = cleaned_children

    return node


def _render_node(raw, depth=0):
    """
    Build one node's template context from its source.

    Tolerant by design: it shares the validators with `_clean_node` but throws the
    error messages away, so anything invalid is simply left out. Whatever is in the
    database - including data written before a validator got stricter - renders as
    much of itself as is still valid, and never raises.
    """
    discarded = []
    node_type = _node_type(raw, "", discarded)
    if node_type is None:
        return None

    base = _style_values(raw, discarded, "")
    mobile = _style_values(raw.get("mobile"), discarded, "")
    style, classes = _attributes(base, mobile, raw.get("spacing"), node_type)

    node = {
        "type": node_type,
        "id": str(raw.get("id") or ""),
        "style": style,
        "classes": classes,
    }

    if node_type == "heading":
        level = str(raw.get("level") or "h2").strip().lower()
        node["tag"] = level if level in HEADING_LEVELS else "h2"
        node["text"] = str(raw.get("text") or "")
    elif node_type == "rich_text":
        value = raw.get("value")
        # RichText renders through Wagtail's own `expand_db_html`, which resolves
        # internal links/embeds and is the only path by which author HTML reaches
        # the page. Nothing else in this module emits author-supplied markup.
        node["html"] = value if isinstance(value, RichText) else RichText(str(value or ""))
    else:
        children = raw.get("children")
        children = children if isinstance(children, list) else []
        node["children"] = (
            []
            if depth >= MAX_DEPTH
            else [child for child in (_render_node(item, depth + 1) for item in children) if child is not None]
        )

    return node


class PrettyJSONField(forms.JSONField):
    """A JSONField whose textarea shows indented JSON, so a tree is readable by hand."""

    def prepare_value(self, value):
        if isinstance(value, forms.fields.InvalidJSONInput):
            # What the author typed, so a syntax error doesn't discard their work.
            return value
        if value is None:
            return ""
        return json.dumps(value, indent=2, ensure_ascii=False, cls=self.encoder)


class SectionEditorWidget(forms.Widget):
    """
    Renders the hidden textarea `PrettyJSONField`'s value lives in, plus a container
    that `static/visual_editor/section_editor.js` fills with a structured form the
    moment this widget's HTML is inserted into the page.

    No custom telepath adapter is needed. This is a plain `forms.Widget` subclass,
    so Wagtail's generic adapter for `forms.widgets.Widget` already applies - telepath
    looks one up by walking `cls.__mro__` - and packs this widget exactly like any
    other: the rendered HTML, verbatim, with `__NAME__`/`__ID__` placeholders. The
    generic JS `Widget.render()` that unpacks it already runs any inline `<script>`
    the HTML carries (`runInlineScripts`, the same mechanism core Wagtail widgets use
    for their own JS setup), which is what boots `section_editor.js` below - in the
    visual editor's sidebar and in Wagtail's classic page editor alike, since both
    share that one client-side `Widget` class.

    The *value* this widget carries is unaffected by any of this: it is still just
    the one hidden textarea Django's form machinery reads from, so
    `value_from_datadict`, `CustomSectionBlock.value_from_form` and `.clean()` don't
    need to know this widget exists. The structured UI is a presentation layer on
    top of that textarea, not a replacement for it - see this module's docstring.
    """

    template_name = "visual_editor/section_editor_widget.html"

    def render(self, name, value, attrs=None, renderer=None):
        attrs = attrs or {}
        return mark_safe(
            render_to_string(
                self.template_name,
                {"name": name, "id": attrs.get("id", ""), "value": value or ""},
            )
        )

    @property
    def media(self):
        return forms.Media(
            css={"all": ["visual_editor/section_editor.css"]},
            js=["visual_editor/section_editor.js"],
        )


class CustomSectionBlock(FieldBlock):
    """
    A `<section>` whose layout, nesting and content are all author-defined JSON.

    See this module's docstring for the stored shape, the property whitelist and how
    mobile overrides work.
    """

    # The block's text lives inside a JSON value, not in a CharBlock/RichTextBlock,
    # so there is nothing for `instrument.py` to mark as in-place editable copy.
    inline_editable = False

    def __init__(self, required=False, help_text=None, **kwargs):
        self.field = PrettyJSONField(
            required=required,
            help_text=help_text or "A section tree. See visual_editor/sections.py for the shape.",
            widget=SectionEditorWidget(),
        )
        super().__init__(**kwargs)

    def value_from_form(self, value):
        """
        Parse the textarea's text into the tree.

        `forms.JSONField` does its parsing in `to_python`, which only runs during
        `clean` - so the widget hands back raw text and `FieldBlock`'s default
        `value_from_form` would pass that straight through as the block's value. The
        editor reads sidebar forms back without cleaning (it validates separately),
        so without this a sidebar edit would store a JSON *string* and the section
        would quietly render nothing.

        Unparseable text is returned as Django's own `InvalidJSONInput`, a `str`
        subclass: `clean` then raises the usual "Enter a valid JSON" error and the
        author's typing is echoed back into the textarea rather than discarded.
        """
        if not isinstance(value, str):
            return value
        if not value.strip():
            return None
        try:
            return json.loads(value)
        except ValueError:
            return forms.fields.InvalidJSONInput(value)

    def get_default(self):
        """A small but complete tree, so a newly added block renders something real."""
        return {
            "type": "section",
            "id": str(uuid.uuid4()),
            "display": "block",
            "container": "960px",
            "spacing": {
                "desktop_padding_top": "48px",
                "desktop_padding_bottom": "48px",
                "mobile_padding_top": "24px",
                "mobile_padding_bottom": "24px",
            },
            "children": [
                {"type": "heading", "id": str(uuid.uuid4()), "level": "h2", "text": "Section heading"},
                {"type": "rich_text", "id": str(uuid.uuid4()), "value": "<p>Add your content here.</p>"},
            ],
        }

    def clean(self, value):
        value = super().clean(value)
        if not value:
            if self.field.required:
                raise ValidationError("This section needs some content.")
            return None

        errors = []
        cleaned = _clean_node(value, errors)
        if errors:
            raise ValidationError(errors)
        return cleaned

    def get_context(self, value, parent_context=None):
        context = super().get_context(value, parent_context)
        context["node"] = _render_node(value) if isinstance(value, dict) else None
        return context

    def get_searchable_content(self, value):
        """Headings and rich text from the whole tree, so custom sections are searchable."""
        if not isinstance(value, dict):
            return []

        def walk(node):
            if not isinstance(node, dict):
                return
            if node.get("text"):
                yield str(node["text"])
            if node.get("value"):
                source = node["value"]
                yield source.source if isinstance(source, RichText) else str(source)
            for child in node.get("children") or []:
                yield from walk(child)

        return list(walk(value))

    class Meta:
        icon = "grid"
        label = "Custom section"
        template = "visual_editor/custom_section.html"
        description = "A section whose layout, nesting and content are all defined inline."
