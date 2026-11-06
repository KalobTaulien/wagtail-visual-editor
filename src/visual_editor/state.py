"""
The visual editor's JSON state, and moving it on and off page objects.

State shape::

    {
        "fields": {"title": "...", "hero_image": 12, "topics": [1, 3], ...},
        "streams": {"content": [{"type": "...", "id": "...", "value": {...}}, ...], ...},
    }

Stream values are Wagtail's own raw JSON representation (what `get_prep_value`
produces), so the browser can reorder, duplicate and delete blocks without the
server, and the server can rebuild real values with `to_python`.
"""

import enum
import json
from functools import cached_property

from django.core.exceptions import FieldDoesNotExist, ValidationError
from django.core.serializers.json import DjangoJSONEncoder
from django.db import models
from modelcluster.fields import ParentalManyToManyField
from wagtail.admin.panels import FieldPanel
from wagtail.blocks import StreamBlockValidationError, StructBlockValidationError
from wagtail.blocks.list_block import ListBlockValidationError
from wagtail.fields import RichTextField, StreamField

from visual_editor.instrument import is_copy_name

# Scheduling and comment settings belong to the publishing workflow, not the canvas.
EXCLUDED_FIELD_NAMES = {"go_live_at", "expire_at", "comment_notifications"}


class StateJSONEncoder(DjangoJSONEncoder):
    def default(self, o):
        # Some block defaults are plain Enum members (e.g. `ButtonStyle.PRIMARY`).
        if isinstance(o, enum.Enum):
            return o.value
        return super().default(o)


def jsonable(value):
    """Round-trip through JSON so dates, decimals, UUIDs and enums become plain JSON values."""
    return json.loads(json.dumps(value, cls=StateJSONEncoder))


def _leaf_panels(panel):
    """Yield every leaf panel in an edit handler. Inline panels count as leaves."""
    children = getattr(panel, "children", None)
    if children is None or getattr(panel, "relation_name", None):
        yield panel
        return
    for child in children:
        yield from _leaf_panels(child)


class FieldSchema:
    """What the editor needs to know about a model's editable (non-stream) fields."""

    model = None
    simple_field_names = ()

    def model_field(self, name):
        return self.model._meta.get_field(name)

    def is_simple_field(self, field):
        return isinstance(field, ParentalManyToManyField) or (field.concrete and not field.many_to_many)

    @cached_property
    def text_field_names(self):
        """Fields holding visible copy, which the canvas can edit in place."""
        return [
            name
            for name in self.simple_field_names
            if isinstance(self.model_field(name), (models.CharField, models.TextField))
            and not isinstance(self.model_field(name), (models.URLField, models.SlugField, models.EmailField, RichTextField))
            and is_copy_name(name)
        ]

    @cached_property
    def rich_text_field_names(self):
        """RichTextFields, which the canvas edits as rich text."""
        return [name for name in self.simple_field_names if isinstance(self.model_field(name), RichTextField)]

    @cached_property
    def multiline_field_names(self):
        return {name for name in self.text_field_names if isinstance(self.model_field(name), models.TextField)}


class PageSchema(FieldSchema):
    """Which of a page type's fields the visual editor can edit, read from the type's admin edit handler."""

    def __init__(self, page_class):
        self.page_class = page_class
        self.model = page_class
        self.edit_handler = page_class.get_edit_handler()

        # [(tab heading, [field names])] of non-stream fields, in edit-handler order.
        self.field_groups = []
        self.simple_field_names = []
        self.stream_field_names = []
        self.stream_labels = {}
        # Panels this editor can't handle (inline panels, custom panels); listed so editors know.
        self.unsupported_labels = []

        for tab in getattr(self.edit_handler, "children", [self.edit_handler]):
            tab_heading = str(getattr(tab, "heading", "") or "")
            names = []
            for panel in _leaf_panels(tab):
                self._add_panel(panel, names)
            if names:
                self.field_groups.append((tab_heading, names))

    def _add_panel(self, panel, names):
        field_name = getattr(panel, "field_name", None)
        if not isinstance(panel, FieldPanel) or not field_name:
            relation = getattr(panel, "relation_name", None)
            heading = getattr(panel, "heading", "") or relation
            if relation and heading:
                self.unsupported_labels.append(str(heading))
            return
        if field_name in EXCLUDED_FIELD_NAMES:
            return

        try:
            field = self.page_class._meta.get_field(field_name)
        except FieldDoesNotExist:
            return

        if isinstance(field, StreamField):
            self.stream_field_names.append(field_name)
            self.stream_labels[field_name] = str(panel.heading or field.verbose_name).capitalize()
        elif self.is_simple_field(field):
            self.simple_field_names.append(field_name)
            names.append(field_name)
        else:
            self.unsupported_labels.append(str(panel.heading or field_name))

    def stream_block(self, name):
        return self.model_field(name).stream_block

    @cached_property
    def form_class(self):
        return self.edit_handler.get_form_class()

    def make_form(self, page, user, data=None, files=None):
        return self.form_class(data, files, instance=page, for_user=user, parent_page=page.get_parent())

    def describe_streams(self):
        """Block type metadata for the editor's outline and "add block" menu."""
        streams = []
        for name in self.stream_field_names:
            stream_block = self.stream_block(name)
            meta = stream_block.meta
            streams.append(
                {
                    "name": name,
                    "label": self.stream_labels[name],
                    "maxNum": meta.max_num,
                    "blockCounts": meta.block_counts or {},
                    "blockTypes": [
                        {
                            "name": block_name,
                            "label": str(block.label or block_name),
                            "icon": getattr(block.meta, "icon", "placeholder") or "placeholder",
                            "group": str(getattr(block.meta, "group", "") or ""),
                            "description": str(getattr(block.meta, "description", "") or ""),
                            # Still renderable on existing pages, but not offered for new blocks.
                            "deprecated": bool(getattr(block, "deprecated", False)),
                        }
                        for block_name, block in stream_block.child_blocks.items()
                    ],
                }
            )
        return streams


def get_field_value(obj, schema, name):
    field = schema.model_field(name)
    if isinstance(field, ParentalManyToManyField):
        return [related.pk for related in getattr(obj, name).all()]
    return jsonable(field.value_from_object(obj))


def get_stream_value(page, schema, name):
    stream = getattr(page, name)
    # Converting every child first means list items come back in the current
    # `{"type": "item", "id": ...}` format, so every item has a stable id.
    for _child in stream:
        pass
    return jsonable(schema.stream_block(name).get_prep_value(stream))


def page_to_state(page, schema):
    return {
        "fields": {name: get_field_value(page, schema, name) for name in schema.simple_field_names},
        "streams": {name: get_stream_value(page, schema, name) for name in schema.stream_field_names},
        # Edits to snippets the page uses, keyed "app.model:pk"; see snippets.py.
        "snippets": {},
    }


def apply_field_values(obj, schema, values):
    """Copy JSON field values onto a model instance in memory. Fields the schema doesn't edit are ignored."""
    for name, value in (values or {}).items():
        if name not in schema.simple_field_names:
            continue
        field = schema.model_field(name)
        if isinstance(field, ParentalManyToManyField):
            pks = value or []
            objects = {related.pk: related for related in field.related_model.objects.filter(pk__in=pks)}
            setattr(obj, name, [objects[pk] for pk in pks if pk in objects])
        elif field.is_relation:
            setattr(obj, field.attname, value or None)
        else:
            if value is None and not field.null and isinstance(field, (models.CharField, models.TextField)):
                value = ""
            setattr(obj, name, field.to_python(value))
    return obj


def apply_state(page, schema, state):
    """Copy editor state onto `page` in memory. Unknown keys are ignored."""
    apply_field_values(page, schema, state.get("fields"))

    for name, value in (state.get("streams") or {}).items():
        if name in schema.stream_field_names:
            setattr(page, name, value or [])
    return page


def form_values(form, schema):
    """Read each editable field's submitted value from a (possibly partial) form: `(values, errors)`."""
    values, errors = {}, {}
    for name in schema.simple_field_names:
        if name not in form.fields:
            continue
        bound_field = form[name]
        widget = bound_field.field.widget
        if widget.value_omitted_from_data(form.data, form.files, bound_field.html_name):
            continue
        try:
            value = bound_field.field.clean(widget.value_from_datadict(form.data, form.files, bound_field.html_name))
        except ValidationError as e:
            errors[name] = e.messages
            continue
        values[name] = form_value_to_state(value)
    return values, errors


def form_value_to_state(value):
    """Convert a cleaned form-field value to its JSON state representation."""
    if isinstance(value, models.Model):
        return value.pk
    if isinstance(value, models.QuerySet) or (
        isinstance(value, (list, tuple)) and value and isinstance(value[0], models.Model)
    ):
        return [obj.pk for obj in value]
    return jsonable(value)


CONTAINER_ERRORS = (StructBlockValidationError, ListBlockValidationError, StreamBlockValidationError)


def _non_block_messages(error):
    return [message for non_block_error in error.non_block_errors.as_data() for message in non_block_error.messages]


def _failing_children(block, error, value):
    """Yield `(label, child block, child error, child value)` for each failing child of a container block."""
    for key, child_error in error.block_errors.items():
        if isinstance(error, StructBlockValidationError):
            child_block = block.child_blocks.get(key) if block is not None else None
            label = str(child_block.label) if child_block is not None else key
            child_value = value.get(key) if hasattr(value, "get") else None
        elif isinstance(error, ListBlockValidationError):
            child_block = getattr(block, "child_block", None)
            label = f"Item {key + 1}"
            child_value = value[key] if value is not None and key < len(value) else None
        else:
            child = value[key] if value is not None and key < len(value) else None
            child_block = child.block if child is not None else None
            label = str(child_block.label) if child is not None else f"Block {key + 1}"
            child_value = child.value if child is not None else None
        yield label, child_block, child_error, child_value


def _labelled(labels, message):
    return f"{' › '.join(labels)}: {message}" if labels else message


def block_error_messages(block, error, value=None, labels=()):
    """Flatten a nested block validation error into lines like "FAQs › Item 2 › Question: This field is required."."""
    if not isinstance(error, CONTAINER_ERRORS):
        return [_labelled(labels, message) for message in getattr(error, "messages", [str(error)])]

    messages = [_labelled(labels, message) for message in _non_block_messages(error)]
    for label, child_block, child_error, child_value in _failing_children(block, error, value):
        messages += block_error_messages(child_block, child_error, child_value, (*labels, label))
    return messages


def validate_streams(page, schema):
    """
    Run every stream through its block validation, swapping in cleaned values.

    Returns `{stream name: {"blocks": {block id: [messages]}, "messages": [...]}}`
    for streams that failed.
    """
    errors = {}
    for name in schema.stream_field_names:
        stream_block = schema.stream_block(name)
        value = getattr(page, name)
        try:
            setattr(page, name, stream_block.clean(value))
        except StreamBlockValidationError as e:
            children = list(value)
            errors[name] = {
                "blocks": {
                    children[index].id: block_error_messages(
                        children[index].block, child_error, children[index].value
                    )
                    for index, child_error in e.block_errors.items()
                    if index < len(children)
                },
                "messages": _non_block_messages(e),
            }
        except ValidationError as e:
            errors[name] = {"blocks": {}, "messages": e.messages}
    return errors
