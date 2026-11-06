"""
Editing the snippets a page shows (e.g. a blog post's author) from the visual editor.

A snippet is shared: editing it here edits it everywhere it's used. So the
editor keeps snippet edits in its state under `snippets` (keyed `app.model:pk`,
holding only the fields changed), shows them on the canvas, and writes them when
the page is saved, after the editor confirms.

Snippets are found where a page chooses them: a page ForeignKey to a snippet
model, or a SnippetChooserBlock in a StreamField. Their text fields are marked
for in-place editing like the page's own (paths `["snippets", key, field]`).

How a snippet is saved follows Wagtail's own snippet editing:

- "drafts" (DraftStateMixin, which needs RevisionMixin): the editor shows and
  edits the snippet's latest draft. Saving the page as a draft saves the
  snippet's edits as a draft revision; publishing the page publishes the
  snippet's latest revision too (any earlier drafts included), if the editor
  may publish it.
- "revisions" (RevisionMixin only): saved live straight away, with a revision
  kept in its history.
- "direct" (neither): saved live straight away.

Snippets the user can't change, or that someone else has locked, aren't edited
here; clicking those leads to the field that chooses them instead.
"""

from functools import lru_cache

from django.apps import apps
from django.core.exceptions import FieldDoesNotExist, PermissionDenied, ValidationError
from django.db import models
from django.http import Http404
from django.urls import NoReverseMatch, reverse
from wagtail import blocks
from wagtail.admin.panels import FieldPanel
from wagtail.blocks.list_block import ListValue
from wagtail.blocks.stream_block import StreamValue
from wagtail.log_actions import log
from wagtail.models import DraftStateMixin, LockableMixin, ReferenceIndex, RevisionMixin
from wagtail.rich_text import RichText
from wagtail.snippets.blocks import SnippetChooserBlock
from wagtail.snippets.models import get_snippet_models

from visual_editor.state import FieldSchema, _leaf_panels, apply_field_values, get_field_value


def snippet_key(obj):
    return f"{obj._meta.label_lower}:{obj.pk}"


def snippet_model(key):
    """The snippet model a state key refers to, and the instance's pk."""
    label, _, pk = (key or "").rpartition(":")
    try:
        model = apps.get_model(label)
    except (LookupError, ValueError) as e:
        raise Http404("Unknown snippet") from e
    if model not in get_snippet_models():
        raise Http404("Not a snippet")
    return model, pk


class SnippetSchema(FieldSchema):
    """A snippet model's editable fields, read from its snippet viewset's edit handler."""

    def __init__(self, model):
        self.model = model
        viewset = model.snippet_viewset
        self.edit_handler = viewset.get_edit_handler()
        self.permission_policy = viewset.permission_policy
        self.verbose_name = str(model._meta.verbose_name)
        if issubclass(model, DraftStateMixin):
            self.mode = "drafts"
        elif issubclass(model, RevisionMixin):
            self.mode = "revisions"
        else:
            self.mode = "direct"
        self.simple_field_names = []
        for panel in _leaf_panels(self.edit_handler):
            field_name = getattr(panel, "field_name", None)
            if not isinstance(panel, FieldPanel) or not field_name:
                continue
            try:
                field = self.model_field(field_name)
            except FieldDoesNotExist:
                continue
            if self.is_simple_field(field):
                self.simple_field_names.append(field_name)

    def make_form(self, obj, user, data=None, files=None):
        return self.edit_handler.get_form_class()(data, files, instance=obj, for_user=user)

    def can_edit(self, user, obj=None):
        if obj is not None and isinstance(obj, LockableMixin):
            lock = obj.get_lock()
            if lock and lock.for_user(user):
                return False
        return self.permission_policy.user_has_permission(user, "change")

    def can_publish(self, user):
        """Only draft snippets are published separately; the others go live when saved."""
        return self.mode != "drafts" or self.permission_policy.user_has_permission(user, "publish")

    def editable_object(self, obj):
        """What the editor edits: a draft snippet's latest revision, otherwise the snippet itself."""
        return obj.get_latest_revision_as_object() if self.mode == "drafts" else obj

    def edit_url(self, obj):
        try:
            return reverse(self.model.snippet_viewset.get_url_name("edit"), args=[obj.pk])
        except NoReverseMatch:
            return None


@lru_cache(maxsize=None)
def snippet_schema(model):
    return SnippetSchema(model)


def _setter(container, key):
    def replace(new):
        container[key] = new

    return replace


def _attr_setter(obj, name):
    def replace(new):
        setattr(obj, name, new)

    return replace


def _block_snippets(block, value, owner, replace):
    """
    Yield `(instance, owner, replace)` for snippets chosen anywhere inside a block
    value; `replace(other)` puts another instance in the chosen one's place.
    """
    if value is None:
        return
    if isinstance(block, SnippetChooserBlock):
        if isinstance(value, models.Model):
            yield value, {**owner, "field": block.name}, replace
    elif isinstance(block, blocks.StructBlock):
        for name, child_block in block.child_blocks.items():
            yield from _block_snippets(child_block, value.get(name), owner, _setter(value, name))
    elif isinstance(block, blocks.ListBlock) and isinstance(value, ListValue):
        for item in value.bound_blocks:
            yield from _block_snippets(block.child_block, item.value, owner, _attr_setter(item, "value"))
    elif isinstance(block, blocks.StreamBlock) and isinstance(value, StreamValue):
        for child in value:
            yield from _block_snippets(child.block, child.value, owner, _attr_setter(child, "value"))


def page_snippets(page, schema):
    """
    Yield `(instance, owner, replace)` for every snippet the page chooses: `owner`
    says where it's chosen, and `replace(other)` swaps in another instance there.
    """
    snippet_models = set(get_snippet_models())
    for name in schema.simple_field_names:
        field = schema.model_field(name)
        if field.many_to_one and field.related_model in snippet_models:
            obj = getattr(page, name)
            if obj is not None:
                owner = {"kind": "field", "name": name, "label": str(field.verbose_name).capitalize()}
                yield obj, owner, _attr_setter(page, name)
    for name in schema.stream_field_names:
        for child in getattr(page, name):
            if child.id:
                owner = {"kind": "block", "stream": name, "id": child.id, "label": str(child.block.label)}
                yield from _block_snippets(child.block, child.value, owner, _attr_setter(child, "value"))


def prepare_snippets(page, schema, state, registry, user):
    """
    Apply the editor's unsaved snippet edits to the snippets the page will render,
    and mark their text for the canvas. Returns what the editor needs to know
    about each snippet, keyed like the state.
    """
    overrides = state.get("snippets") or {}
    described = {}
    editing = {}  # key -> the instance the canvas shows, shared by every place it's chosen
    marked = set()
    for chosen, owner, replace in page_snippets(page, schema):
        key = snippet_key(chosen)
        snippet = snippet_schema(type(chosen))
        if key not in editing:
            # Draft snippets show their latest draft, as the page shows its own.
            editing[key] = apply_field_values(snippet.editable_object(chosen), snippet, overrides.get(key))
            described[key] = {
                "key": key,
                "label": snippet.verbose_name.capitalize(),
                "title": str(editing[key]),
                "mode": snippet.mode,
                "live": getattr(chosen, "live", True),
                "hasUnpublishedChanges": bool(getattr(chosen, "has_unpublished_changes", False)),
                "editable": snippet.can_edit(user, chosen),
                "canPublish": snippet.can_publish(user),
                "owners": [],
            }
        obj = editing[key]
        if obj is not chosen:
            replace(obj)
        described[key]["owners"].append(owner)
        if id(obj) in marked:
            continue
        marked.add(id(obj))
        readonly = not described[key]["editable"]
        for name in snippet.text_field_names:
            value = getattr(obj, name)
            if isinstance(value, str):
                multiline = name in snippet.multiline_field_names
                setattr(obj, name, registry.mark(value, ["snippets", key, name], multiline=multiline, readonly=readonly))
        for name in snippet.rich_text_field_names:
            value = getattr(obj, name)
            if isinstance(value, str):
                features = getattr(snippet.model_field(name), "features", None)
                path = ["snippets", key, name]
                setattr(obj, name, registry.mark_rich_text(RichText(value), path, features, readonly=readonly))
    return described


def load_snippet(key, state, user):
    """The stored snippet for a state key, with the editor's unsaved edits applied."""
    model, pk = snippet_model(key)
    try:
        obj = model.objects.get(pk=pk)
    except (model.DoesNotExist, ValueError) as e:
        raise Http404("Snippet not found") from e
    schema = snippet_schema(model)
    if not schema.permission_policy.user_has_permission(user, "change"):
        raise PermissionDenied
    obj = schema.editable_object(obj)
    apply_field_values(obj, schema, ((state or {}).get("snippets") or {}).get(key))
    return obj, schema


def usage_count(obj):
    """How many objects (pages, other snippets) use this snippet."""
    return ReferenceIndex.get_grouped_references_to(obj).count()


def changed_snippets(state, user):
    """
    The snippets whose edits differ from what's stored, validated and ready to
    save: `(instances, errors)`, with errors keyed by snippet key then field.
    """
    instances, errors = [], {}
    for key, values in ((state or {}).get("snippets") or {}).items():
        model, pk = snippet_model(key)
        schema = snippet_schema(model)
        stored = model.objects.get(pk=pk)
        if not schema.can_edit(user, stored):
            raise PermissionDenied
        obj = schema.editable_object(stored)
        before = {name: get_field_value(obj, schema, name) for name in schema.simple_field_names}
        apply_field_values(obj, schema, values)
        if before == {name: get_field_value(obj, schema, name) for name in schema.simple_field_names}:
            continue
        try:
            obj.full_clean()
        except ValidationError as e:
            errors[key] = e.message_dict if hasattr(e, "error_dict") else {"__all__": e.messages}
            continue
        instances.append(obj)
    return instances, errors


def save_snippets(instances, user):
    """Save edited snippets the way Wagtail's snippet editor would, for each one's mode."""
    for obj in instances:
        mode = snippet_schema(type(obj)).mode
        if mode == "drafts":
            # A draft revision; the live snippet is untouched until it's published.
            obj.save_revision(user=user, log_action=True)
        elif mode == "revisions":
            obj.save()
            obj.save_revision(user=user, log_action=True)
        else:
            obj.save()
            log(instance=obj, action="wagtail.edit", user=user)


def publish_snippets(page, schema, user):
    """
    After publishing the page, publish the draft snippets it shows that have
    unpublished changes. Returns `(published, skipped)`; snippets are skipped when
    the user may not publish them or someone else has them locked.
    """
    published, skipped, seen = [], [], set()
    for chosen, _owner, _replace in page_snippets(page, schema):
        snippet = snippet_schema(type(chosen))
        key = snippet_key(chosen)
        if snippet.mode != "drafts" or key in seen:
            continue
        seen.add(key)
        stored = type(chosen).objects.get(pk=chosen.pk)
        if not stored.has_unpublished_changes or not stored.latest_revision:
            continue
        if not (snippet.can_publish(user) and snippet.can_edit(user, stored)):
            skipped.append(stored)
            continue
        stored.latest_revision.publish(user=user)
        published.append(stored)
    return published, skipped
