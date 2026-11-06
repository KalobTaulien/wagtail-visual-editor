"""Admin views for the visual editor: the editor shell plus the JSON endpoints its canvas and sidebar call."""

import json
import logging
import re
import uuid

from django.core.exceptions import PermissionDenied, ValidationError
from django.db import transaction
from django.http import Http404, JsonResponse
from django.shortcuts import get_object_or_404
from django.template.loader import render_to_string
from django.template.response import TemplateResponse
from django.urls import reverse
from django.views.decorators.http import require_GET, require_POST
from wagtail.blocks import BlockWidget
from wagtail.blocks.base import get_error_json_data
from wagtail.models import Page

from visual_editor.instrument import Registry, instrument_page
from visual_editor.placeholders import fill_placeholders
from visual_editor.rich_text import editable_to_database
from visual_editor.snippets import (
    changed_snippets,
    load_snippet,
    prepare_snippets,
    publish_snippets,
    save_snippets,
    snippet_schema,
    usage_count,
)
from visual_editor.state import (
    PageSchema,
    apply_state,
    form_values,
    get_field_value,
    jsonable,
    page_to_state,
    validate_streams,
)

logger = logging.getLogger("cms")

# Form prefix for the block inspector; the block's inputs are named `ve-block-<child>-...`.
BLOCK_PREFIX = "ve-block"

# The editor has its own chrome; Wagtail's userbar would only get in the way on the canvas.
USERBAR = re.compile(r"<!-- Wagtail user bar embed code -->.*?<!-- end Wagtail user bar embed code -->", re.S)


def _get_editable_page(request, page_id):
    page = get_object_or_404(Page, id=page_id).specific
    permissions = page.permissions_for_user(request.user)
    if not permissions.can_edit():
        raise PermissionDenied
    return page, permissions


def _json_body(request):
    try:
        return json.loads(request.body or b"{}")
    except ValueError as e:
        raise Http404("Expected a JSON body") from e


def _working_copy(page, schema, state):
    """The page's latest draft with the editor's state applied. Never saved unless the editor saves."""
    working = page.get_latest_revision_as_object()
    return apply_state(working, schema, state or {})


def _child_block(schema, stream_name, block_type):
    if stream_name not in schema.stream_field_names:
        raise Http404("Unknown stream")
    try:
        return schema.stream_block(stream_name).child_blocks[block_type]
    except KeyError as e:
        raise Http404("Unknown block type") from e


def _status(page):
    return {
        "live": page.live,
        "hasUnpublishedChanges": page.has_unpublished_changes,
        "latestRevisionId": page.latest_revision_id,
        "liveUrl": page.get_url(),
    }


@require_GET
def editor(request, page_id):
    page, permissions = _get_editable_page(request, page_id)
    schema = PageSchema(type(page))
    working = page.get_latest_revision_as_object()

    def url(name):
        return reverse(f"visual_editor_{name}", args=[page.id])

    config = {
        "pageId": page.id,
        "title": working.get_admin_display_title(),
        "pageType": str(page.specific_class._meta.verbose_name).capitalize(),
        "canPublish": permissions.can_publish(),
        "status": _status(page),
        "state": page_to_state(working, schema),
        "streams": schema.describe_streams(),
        "unsupported": schema.unsupported_labels,
        "urls": {
            "render": url("render"),
            "blockForm": url("block_form"),
            "blockValue": url("block_value"),
            "newBlock": url("new_block"),
            "richTextValue": url("rich_text_value"),
            "snippetForm": url("snippet_form"),
            "snippetValue": url("snippet_value"),
            "pageForm": url("page_form"),
            "pageValue": url("page_value"),
            "save": url("save"),
            "imageChooser": reverse("wagtailimages_chooser:choose"),
            "classicEdit": reverse("wagtailadmin_pages:edit", args=[page.id]),
            "explore": reverse("wagtailadmin_explore", args=[page.get_parent().id]),
        },
    }
    return TemplateResponse(
        request,
        "visual_editor/editor.html",
        {
            "page": page,
            "ve_config": config,
            # Everything any block or page-field widget needs, loaded up front so
            # forms fetched into the sidebar later can initialise.
            "media": schema.make_form(working, request.user).media,
        },
    )


@require_POST
def render_preview(request, page_id):
    page, _permissions = _get_editable_page(request, page_id)
    schema = PageSchema(type(page))
    state = _json_body(request).get("state") or {}
    working = _working_copy(page, schema, state)

    registry = Registry()
    snippets = prepare_snippets(working, schema, state, registry, request.user)
    instrument_page(working, schema, registry)
    response = working.make_preview_request(
        request, working.default_preview_mode, extra_request_attrs={"is_visual_editor": True}
    )
    return JsonResponse(
        {
            "html": USERBAR.sub("", response.content.decode(response.charset or "utf-8")),
            "status": response.status_code,
            "registry": registry.entries,
            "snippets": snippets,
        }
    )


@require_POST
def block_form(request, page_id):
    """The native Wagtail form for one block, for the inspector sidebar."""
    page, _permissions = _get_editable_page(request, page_id)
    schema = PageSchema(type(page))
    data = _json_body(request)
    block = _child_block(schema, data.get("stream"), data.get("type"))
    value = block.to_python(data.get("value"))

    error = None
    if data.get("validate"):
        try:
            block.clean(value)
        except ValidationError as e:
            error = e

    # Returned as data rather than BlockWidget's `w-block` markup: that Stimulus
    # controller assumes the root block has a container element, which a
    # StructBlock root doesn't. The editor calls telepath's render() itself.
    return JsonResponse(
        {
            "prefix": BLOCK_PREFIX,
            "blockDef": json.loads(BlockWidget(block).block_json),
            "state": block.get_form_state(value),
            "error": get_error_json_data(error) if error else None,
        }
    )


@require_POST
def block_value(request, page_id):
    """Turn the inspector form's submitted data back into the block's raw JSON value."""
    page, _permissions = _get_editable_page(request, page_id)
    schema = PageSchema(type(page))
    block = _child_block(schema, request.POST.get("__stream"), request.POST.get("__type"))
    value = block.value_from_datadict(request.POST, request.FILES, BLOCK_PREFIX)
    return JsonResponse({"value": jsonable(block.get_prep_value(value))})


@require_POST
def rich_text_value(request, page_id):
    """Convert rich text edited on the canvas into its stored form, using the block's Draftail features."""
    _get_editable_page(request, page_id)
    data = _json_body(request)
    features = data.get("features")
    if features is not None and not (isinstance(features, list) and all(isinstance(name, str) for name in features)):
        raise Http404("Invalid features")
    return JsonResponse({"value": editable_to_database(data.get("html") or "", features)})


@require_POST
def new_block(request, page_id):
    page, _permissions = _get_editable_page(request, page_id)
    schema = PageSchema(type(page))
    data = _json_body(request)
    block_type = data.get("type")
    block = _child_block(schema, data.get("stream"), block_type)
    value = fill_placeholders(block, block.get_default())
    return JsonResponse(
        {"block": {"type": block_type, "id": str(uuid.uuid4()), "value": jsonable(block.get_prep_value(value))}}
    )


@require_POST
def page_form(request, page_id):
    """The page-level (non-StreamField) fields, rendered with Wagtail's own widgets."""
    page, _permissions = _get_editable_page(request, page_id)
    schema = PageSchema(type(page))
    working = _working_copy(page, schema, _json_body(request).get("state"))
    form = schema.make_form(working, request.user)
    groups = [(heading, [form[name] for name in names if name in form.fields]) for heading, names in schema.field_groups]
    html = render_to_string(
        "visual_editor/page_form.html",
        {"groups": groups, "unsupported": schema.unsupported_labels},
        request=request,
    )
    return JsonResponse({"html": html})


@require_POST
def page_value(request, page_id):
    """Read the page-level form's submitted data back into JSON state values."""
    page, _permissions = _get_editable_page(request, page_id)
    schema = PageSchema(type(page))
    form = schema.make_form(page, request.user, data=request.POST, files=request.FILES)
    fields, errors = form_values(form, schema)
    return JsonResponse({"fields": fields, "errors": errors})


@require_POST
def snippet_form(request, page_id):
    """A snippet's own edit form (with the editor's unsaved edits), for the inspector sidebar."""
    _get_editable_page(request, page_id)
    data = _json_body(request)
    obj, snippet = load_snippet(data.get("key"), data.get("state"), request.user)
    form = snippet.make_form(obj, request.user)
    html = render_to_string(
        "visual_editor/page_form.html",
        {"groups": [("", [form[name] for name in snippet.simple_field_names if name in form.fields])]},
        request=request,
    )
    return JsonResponse(
        {
            "html": html,
            "label": snippet.verbose_name.capitalize(),
            "title": str(obj),
            "editable": snippet.can_edit(request.user),
            "usage": usage_count(obj),
            "editUrl": snippet.edit_url(obj),
            "values": {name: get_field_value(obj, snippet, name) for name in snippet.simple_field_names},
        }
    )


@require_POST
def snippet_value(request, page_id):
    """Read the snippet form's submitted data back into JSON values."""
    _get_editable_page(request, page_id)
    obj, snippet = load_snippet(request.POST.get("__key"), None, request.user)
    form = snippet.make_form(obj, request.user, data=request.POST, files=request.FILES)
    fields, errors = form_values(form, snippet)
    return JsonResponse({"fields": fields, "errors": errors})


@require_POST
def save(request, page_id):
    page, permissions = _get_editable_page(request, page_id)
    schema = PageSchema(type(page))
    data = _json_body(request)
    publish = data.get("action") == "publish"

    if publish and not permissions.can_publish():
        raise PermissionDenied

    lock = page.get_lock()
    if lock and lock.for_user(request.user):
        return JsonResponse({"ok": False, "message": str(lock.get_message(request.user))}, status=423)

    if page.latest_revision_id != data.get("baseRevisionId") and not data.get("force"):
        return JsonResponse(
            {
                "ok": False,
                "conflict": True,
                "message": "Someone else saved this page after you opened it. Saving will overwrite their changes.",
            },
            status=409,
        )

    working = _working_copy(page, schema, data.get("state"))
    stream_errors = validate_streams(working, schema)
    snippets, snippet_errors = changed_snippets(data.get("state"), request.user)
    if stream_errors or snippet_errors:
        return JsonResponse(
            {"ok": False, "errors": {"streams": stream_errors, "fields": {}, "snippets": snippet_errors}}, status=400
        )

    # Snippet edits are saved with the page, in one transaction: draft snippets as
    # draft revisions (published below with the page), the others live.
    published_snippets, skipped_snippets = [], []
    try:
        with transaction.atomic():
            save_snippets(snippets, request.user)
            revision = working.save_revision(user=request.user, log_action=True)
            if publish:
                revision.publish(user=request.user)
                published_snippets, skipped_snippets = publish_snippets(working, schema, request.user)
    except ValidationError as e:
        field_errors = e.message_dict if hasattr(e, "error_dict") else {"__all__": e.messages}
        return JsonResponse({"ok": False, "errors": {"streams": {}, "fields": field_errors, "snippets": {}}}, status=400)

    def describe(objects):
        return ", ".join(f"{obj._meta.verbose_name} “{obj}”" for obj in objects)

    page.refresh_from_db()
    message = f"“{page.get_admin_display_title()}” has been {'published' if publish else 'saved as a draft'}."
    live_now = [obj for obj in snippets if snippet_schema(type(obj)).mode != "drafts"]
    drafted = [obj for obj in snippets if snippet_schema(type(obj)).mode == "drafts" and not publish]
    if live_now:
        message += f" Updated {describe(live_now)}."
    if drafted:
        message += f" Saved draft changes to {describe(drafted)}."
    if published_snippets:
        message += f" Published {describe(published_snippets)}."
    if skipped_snippets:
        message += f" {describe(skipped_snippets).capitalize()} still has unpublished changes you can’t publish."
    return JsonResponse(
        {
            "ok": True,
            "message": message,
            "status": _status(page),
            "state": page_to_state(page.get_latest_revision_as_object(), schema),
        }
    )
