"""
Spacing options for StreamField blocks: margin and padding above and below a
block, for mobile and desktop, as custom CSS lengths (`24px`, `1.5rem`).

Every option defaults to blank, which keeps whatever spacing the block's
template already has. A value is applied through a CSS variable: the block's
outermost element gets the utility class for that side (which reads the
variable) and an inline style setting it, e.g.
`class="md:pt-[var(--space-pt-desktop)]" style="--space-pt-desktop: 3rem;"`.
Utilities are `!important` in this project, so they override the template's own
spacing.

Mobile values apply at every screen width unless a desktop value is set too;
desktop values apply from the `md` breakpoint (60rem, 960px) up.

To add spacing to a block: give it `spacing = SpacingBlock()`, put "spacing" in
its form layout's `settings` (see `with_spacing_settings`), and add
`{{ value.spacing.classes }}` to the class and `{{ value.spacing.style }}` to the
style of its template's outermost element.

The class names below are written out in full on purpose: UnoCSS only generates
utilities it finds as literal text in the files it scans
(`vite/uno-content-globs.ts` includes `src/visual_editor/visual_editor/**/*.py`).
"""

import re

from django.core.exceptions import ValidationError
from wagtail.blocks import BlockGroup, CharBlock, StructBlock, StructValue

# Field name -> (utility class reading the variable, CSS variable).
SPACING_UTILITIES = {
    "mobile_margin_top": ("mt-[var(--space-mt)]", "--space-mt"),
    "mobile_padding_top": ("pt-[var(--space-pt)]", "--space-pt"),
    "mobile_padding_bottom": ("pb-[var(--space-pb)]", "--space-pb"),
    "mobile_margin_bottom": ("mb-[var(--space-mb)]", "--space-mb"),
    "desktop_margin_top": ("md:mt-[var(--space-mt-desktop)]", "--space-mt-desktop"),
    "desktop_padding_top": ("md:pt-[var(--space-pt-desktop)]", "--space-pt-desktop"),
    "desktop_padding_bottom": ("md:pb-[var(--space-pb-desktop)]", "--space-pb-desktop"),
    "desktop_margin_bottom": ("md:mb-[var(--space-mb-desktop)]", "--space-mb-desktop"),
}

LENGTH = re.compile(r"^(?P<number>-?(?:\d+(?:\.\d+)?|\.\d+))(?P<unit>px|rem)?$")
MAX_PX = 1000
MAX_REM = 60


def parse_length(value, allow_negative=True):
    """
    Normalise a typed length to `"<number><unit>"`: `"24"` -> `"24px"`, `" 1.5REM "` ->
    `"1.5rem"`, `"0"` -> `"0px"`. Returns None for blank; raises ValueError if invalid.
    """
    text = (value or "").strip().lower().replace(" ", "")
    if not text:
        return None
    match = LENGTH.match(text)
    if not match:
        raise ValueError("Enter a size in px or rem, like 24px or 1.5rem.")
    number = float(match["number"])
    unit = match["unit"] or "px"
    if number < 0 and not allow_negative:
        raise ValueError("Padding can’t be negative.")
    if abs(number) > (MAX_PX if unit == "px" else MAX_REM):
        raise ValueError(f"That’s too big; keep it within {MAX_PX}px or {MAX_REM}rem.")
    return f"{number:g}{unit}"


class SpacingLengthBlock(CharBlock):
    """A CSS length in px or rem; blank keeps the template's spacing."""

    # A CSS value, not copy: the visual editor mustn't mark it for in-place text editing.
    inline_editable = False

    def __init__(self, allow_negative=True, **kwargs):
        self.allow_negative = allow_negative
        super().__init__(required=False, max_length=16, **kwargs)

    def clean(self, value):
        value = super().clean(value)
        try:
            return parse_length(value, self.allow_negative) or ""
        except ValueError as e:
            raise ValidationError(str(e)) from e


def _allow_negative(field_name: str) -> bool:
    """Margins can pull a block closer (negative); paddings can't push content outside it."""
    return "margin" in field_name


def spacing_lengths(data):
    """
    Each of `data`'s eight `SPACING_UTILITIES` fields, normalised and paired with the
    utility that applies it. `data` is any `{field name: raw value}` mapping - a
    `SpacingValue`'s `.get(name)` and a plain `dict.get(name)` both work - so this one
    function is the single source of truth for both `SpacingValue` below and anything
    else (`sections.CustomSectionBlock`) that wants this exact spacing vocabulary
    without going through a `SpacingBlock` StructBlock value. Invalid values (e.g.
    unsaved previews) are left out rather than raised, and so is anything not
    dict-like - callers that render untrusted/stale data (`sections._render_node`)
    rely on this never raising, whatever shape `data` turns out to be.
    """
    get = getattr(data, "get", None)
    if not callable(get):
        return
    for name, (css_class, variable) in SPACING_UTILITIES.items():
        try:
            length = parse_length(get(name), _allow_negative(name))
        except ValueError:
            continue
        if length:
            yield css_class, variable, length


def spacing_attrs(data):
    """`(classes, style)` for a plain `{field name: raw value}` mapping - see `spacing_lengths`."""
    lengths = list(spacing_lengths(data))
    classes = " ".join(css_class for css_class, _variable, _length in lengths)
    style = "".join(f"{variable}: {length}; " for _css_class, variable, length in lengths)
    return classes, style


class SpacingValue(StructValue):
    @property
    def classes(self) -> str:
        """The utility classes for the sides that are set; empty when everything is left to the template."""
        classes, _style = spacing_attrs(self)
        return classes

    @property
    def style(self) -> str:
        """Inline CSS setting the variables those classes read, e.g. `--space-pt: 24px; `."""
        _classes, style = spacing_attrs(self)
        return style


def _margin(label):
    return SpacingLengthBlock(label=label, help_text="e.g. 24px or 1.5rem. Negative values pull the block closer.")


def _padding(label):
    return SpacingLengthBlock(allow_negative=False, label=label, help_text="e.g. 24px or 1.5rem.")


class SpacingBlock(StructBlock):
    desktop_margin_top = _margin("Margin top")
    desktop_padding_top = _padding("Padding top")
    desktop_padding_bottom = _padding("Padding bottom")
    desktop_margin_bottom = _margin("Margin bottom")
    mobile_margin_top = _margin("Margin top")
    mobile_padding_top = _padding("Padding top")
    mobile_padding_bottom = _padding("Padding bottom")
    mobile_margin_bottom = _margin("Margin bottom")

    class Meta:
        icon = "expand-right"
        label = "Spacing"
        help_text = "Sizes in px or rem. Leave a size blank to keep the block's usual spacing."
        value_class = SpacingValue
        form_layout = BlockGroup(
            children=[
                BlockGroup(
                    children=["desktop_margin_top", "desktop_padding_top", "desktop_padding_bottom", "desktop_margin_bottom"],
                    heading="Desktop",
                    help_text="Screens 960px and wider.",
                ),
                BlockGroup(
                    children=["mobile_margin_top", "mobile_padding_top", "mobile_padding_bottom", "mobile_margin_bottom"],
                    heading="Mobile",
                    help_text="Smaller screens, and desktop too where no desktop size is set.",
                ),
            ]
        )


def with_spacing_settings(*children):
    """A block form layout showing `children`, with the spacing options in the block's settings."""
    return BlockGroup(children=list(children), settings=["spacing"])
