"""Wagtail hooks for the visual editor, found by Wagtail because the app is installed."""

from django.urls import include, path, reverse
from wagtail import hooks
from wagtail.admin.widgets.button import Button

from visual_editor import urls
from visual_editor.rich_text_links import register_link_new_tab


@hooks.register("register_admin_urls")
def register_visual_editor_urls():
    return [path("visual-editor/", include(urls))]


def _visual_editor_button(page, user, priority):
    if page.is_root() or not page.permissions_for_user(user).can_edit():
        return None
    return Button(
        "Visual editor",
        reverse("visual_editor", args=[page.id]),
        icon_name="desktop",
        priority=priority,
    )


@hooks.register("register_page_header_buttons")
def visual_editor_header_button(page, user, view_name, next_url=None):
    button = _visual_editor_button(page, user, priority=11)
    if button:
        yield button


@hooks.register("register_page_listing_more_buttons")
def visual_editor_listing_button(page, user, next_url=None):
    button = _visual_editor_button(page, user, priority=3)
    if button:
        yield button


@hooks.register("register_rich_text_features", order=100)
def register_link_new_tab_feature(features):
    """Let rich text links open in a new tab. Ordered after Wagtail's own "link" feature, which this replaces."""
    register_link_new_tab(features)
