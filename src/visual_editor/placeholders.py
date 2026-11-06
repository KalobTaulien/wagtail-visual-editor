"""Default values for newly added blocks, with required copy pre-filled so templates have something to render."""

from wagtail import blocks
from wagtail.blocks.list_block import ListValue
from wagtail.blocks.stream_block import StreamValue
from wagtail.rich_text import RichText

PLACEHOLDER_TEXT = "Insert text here"


def _first_choice(block):
    for value, _label in getattr(block.field, "choices", []):
        # Skip the blank option and optgroups (whose "value" is a list of choices).
        if value not in ("", None) and not isinstance(value, (list, tuple)):
            return value
    return None


def _is_empty(value):
    if isinstance(value, RichText):
        return not value.source.strip()
    return value in (None, "")


def fill_placeholders(block, value):
    """Return `value` with required text filled in, required choices picked, and minimum list/stream sizes met."""
    if isinstance(block, blocks.StructBlock):
        for name, child_block in block.child_blocks.items():
            value[name] = fill_placeholders(child_block, value.get(name))
        return value

    if isinstance(block, blocks.ListBlock):
        if not isinstance(value, ListValue):
            value = block.normalize(value or [])
        min_num = block.meta.min_num or 0
        while len(value) < min_num:
            value.append(block.child_block.get_default())
        for item in value.bound_blocks:
            item.value = fill_placeholders(block.child_block, item.value)
        return value

    if isinstance(block, blocks.StreamBlock):
        if not isinstance(value, StreamValue):
            value = block.normalize(value or [])
        min_num = block.meta.min_num or 0
        first_type = next(iter(block.child_blocks), None)
        if first_type:
            while len(value) < min_num:
                value.append((first_type, block.child_blocks[first_type].get_default()))
        for child in value:
            child.value = fill_placeholders(child.block, child.value)
        return value

    if not getattr(block, "required", False) or not _is_empty(value):
        return value

    if isinstance(block, (blocks.CharBlock, blocks.TextBlock)):
        return PLACEHOLDER_TEXT
    if isinstance(block, blocks.RichTextBlock):
        return RichText(f"<p>{PLACEHOLDER_TEXT}</p>")
    if isinstance(block, (blocks.ChoiceBlock,)):
        return _first_choice(block) or value
    return value
