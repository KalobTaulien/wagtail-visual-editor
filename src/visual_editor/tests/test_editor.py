import json
import re
import uuid

from django.contrib.auth.models import Group, Permission, User
from django.urls import reverse
from django.utils.text import slugify
from wagtail.models import Locale, Page, Site

from cms.models import FrontPage
from visual_editor.instrument import Registry, is_copy_name
from visual_editor.placeholders import PLACEHOLDER_TEXT
from visual_editor.rich_text import editable_to_database, toolbar_for
from visual_editor.state import PageSchema, page_to_state
from utils.testing import TestCase, UnitTestCase


class InstrumentTest(UnitTestCase):
    def test_marked_text_reports_its_visible_length(self):
        marked = Registry().mark("Pricing", ["fields", "title"])

        self.assertNotEqual(str(marked), "Pricing")
        self.assertEqual(len(marked), len("Pricing"))

    def test_markers_vanish_from_slugs(self):
        """Templates build anchor ids with `|slugify`; markers must not leak into them."""
        marked = Registry().mark("Our Core Values", ["fields", "title"])

        self.assertEqual(slugify(marked), "our-core-values")

    def test_registry_records_where_each_value_lives(self):
        registry = Registry()
        registry.mark("Hello", ["streams", "content", "#abc", "value", "heading"])
        registry.mark("", ["fields", "title"])

        self.assertEqual(
            registry.entries,
            [{"path": ["streams", "content", "#abc", "value", "heading"], "value": "Hello", "multiline": False}],
        )

    def test_markup_and_url_fields_are_not_copy(self):
        self.assertTrue(is_copy_name("title"))
        self.assertTrue(is_copy_name("button_text"))
        self.assertFalse(is_copy_name("external_url"))
        self.assertFalse(is_copy_name("embed_code"))
        self.assertFalse(is_copy_name("video_id"))


def _without_keys(html):
    import re

    return re.sub(r' data-block-key="\w+"', "", html)


class InlineRichTextTest(TestCase):
    def test_page_links_are_restored_to_their_stored_form(self):
        html = '<p>See <a href="/about/" data-ve-link=\'{"linktype": "page", "id": "12"}\'>about us</a></p>'

        self.assertEqual(_without_keys(editable_to_database(html, ["link"])), '<p>See <a linktype="page" id="12">about us</a></p>')

    def test_new_tab_follows_the_link_on_the_canvas(self):
        stored = '{"linktype": "page", "id": "12", "target": "_blank", "rel": "noopener noreferrer"}'
        unticked = f"<p><a href=\"/about/\" data-ve-link='{stored}'>about</a></p>"
        ticked = f"<p><a href=\"/about/\" target=\"_blank\" data-ve-link='{stored}'>about</a></p>"

        self.assertEqual(_without_keys(editable_to_database(unticked, ["link"])), '<p><a linktype="page" id="12">about</a></p>')
        self.assertEqual(
            _without_keys(editable_to_database(ticked, ["link"])),
            '<p><a linktype="page" id="12" target="_blank" rel="noopener noreferrer">about</a></p>',
        )

    def test_embeds_are_restored_to_their_stored_form(self):
        html = '<p>Hi</p><ve-embed data-ve-embed=\'{"embedtype": "media", "url": "https://example.com/v"}\' contenteditable="false"><iframe></iframe></ve-embed>'

        self.assertIn('<embed embedtype="media" url="https://example.com/v"/>', editable_to_database(html, ["embed"]))

    def test_alignment_split_by_the_browser_is_put_back_in_its_paragraph(self):
        html = '<p></p><div class="block text-center">Centered</div><p></p>'

        self.assertEqual(
            _without_keys(editable_to_database(html, ["center-text"])), '<p><div class="block text-center">Centered</div></p>'
        )

    def test_formatting_outside_the_blocks_features_is_dropped(self):
        html = '\n   <p><b>Bold</b> and <i>italic</i></p>\n   <div>stray</div>'

        self.assertEqual(_without_keys(editable_to_database(html, ["italic"])), "<p>Bold and <i>italic</i></p><p>stray</p>")

    def test_toolbar_follows_the_blocks_features(self):
        kinds = {control["name"]: control["kind"] for control in toolbar_for(["h2", "bold", "ul", "link", "hr", "image"])}

        self.assertEqual(kinds, {"h2": "block", "bold": "inline", "ul": "block", "link": "link", "hr": "hr", "image": "sidebar"})


class PageRichTextFieldTest(UnitTestCase):
    def test_page_rich_text_fields_are_rich_text_not_plain_text(self):
        from cms.models.above_the_fold_models import AboveTheFoldPage

        schema = PageSchema(AboveTheFoldPage)

        self.assertIn("final_message_body", schema.rich_text_field_names)
        self.assertNotIn("final_message_body", schema.text_field_names)


class VisualEditorViewsTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        Site.objects.all().delete()
        locale, _ = Locale.objects.get_or_create(language_code="en")
        root = Page.get_first_root_node() or Page.add_root(instance=Page(title="Root", slug="root", locale=locale))
        Site.objects.create(hostname="localhost", port=80, root_page=root, is_default_site=True)

        cls.faq_id = str(uuid.uuid4())
        cls.page = FrontPage(
            title="Kitchen Sink",
            slug="kitchen-sink",
            locale=locale,
            content=[
                {
                    "type": "faq_block",
                    "id": cls.faq_id,
                    "value": {"heading": "Common questions", "faqs": [{"question": "Why?", "answer": "<p>Because.</p>"}]},
                }
            ],
            pre_footer_transition=[{"type": "transition", "value": {}}],
        )
        root.add_child(instance=cls.page)
        cls.page.save_revision().publish()

        cls.admin = User.objects.create_superuser("visual-admin", "visual-admin@example.com", "password")

    def setUp(self):
        self.client.force_login(self.admin)

    def url(self, name):
        return reverse(name, args=[self.page.id])

    def post_json(self, name, body):
        return self.client.post(self.url(name), json.dumps(body), content_type="application/json")

    def state(self):
        page = Page.objects.get(id=self.page.id).specific
        return page_to_state(page.get_latest_revision_as_object(), PageSchema(FrontPage))

    def test_editor_shell_renders(self):
        response = self.client.get(self.url("visual_editor"))

        self.assertEqual(response.status_code, 200)
        self.assertContains(response, 'id="ve-config"')

    def test_editors_without_edit_permission_are_refused(self):
        admin_only = Group.objects.create(name="Admin access only")
        admin_only.permissions.add(Permission.objects.get(codename="access_admin"))
        user = User.objects.create_user("no-page-perms", "no-page-perms@example.com", "password")
        user.groups.add(admin_only)
        self.client.force_login(user)

        response = self.client.get(self.url("visual_editor"))

        # Wagtail's admin turns PermissionDenied into a redirect to the dashboard.
        self.assertRedirects(response, reverse("wagtailadmin_home"), fetch_redirect_response=False)

    def test_render_marks_blocks_and_text_without_saving(self):
        state = self.state()
        state["fields"]["title"] = "Unsaved title"
        revisions_before = self.page.revisions.count()

        data = self.post_json("visual_editor_render", {"state": state}).json()

        self.assertEqual(data["status"], 200)
        self.assertIn(f'data-ve-start="content:{self.faq_id}"', data["html"])
        paths = [entry["path"] for entry in data["registry"]]
        self.assertIn(["fields", "title"], paths)
        self.assertIn(["streams", "content", f"#{self.faq_id}", "value", "heading"], paths)
        self.assertNotIn("wagtail-userbar", data["html"])
        self.assertEqual(self.page.revisions.count(), revisions_before)
        self.assertEqual(Page.objects.get(id=self.page.id).title, "Kitchen Sink")

    def test_new_blocks_get_placeholder_text_for_required_fields(self):
        data = self.post_json("visual_editor_new_block", {"stream": "content", "type": "faq_block"}).json()

        block = data["block"]
        self.assertEqual(block["type"], "faq_block")
        self.assertEqual(block["value"]["faqs"][0]["value"]["question"], PLACEHOLDER_TEXT)
        self.assertIn(PLACEHOLDER_TEXT, block["value"]["faqs"][0]["value"]["answer"])

    def test_rich_text_renders_as_an_editable_region(self):
        data = self.post_json("visual_editor_render", {"state": self.state()}).json()

        entry = next(entry for entry in data["registry"] if entry.get("kind") == "richtext")
        self.assertEqual(entry["path"][-1], "answer")
        self.assertIn("Because.", entry["value"])
        self.assertTrue(any(control["kind"] == "inline" for control in entry["toolbar"]))
        self.assertIn("data-ve-rt-start=", data["html"])

    def test_rich_text_value_converts_canvas_html(self):
        response = self.post_json(
            "visual_editor_rich_text_value", {"html": "<p>Edited <b>inline</b></p>", "features": ["bold"]}
        )

        self.assertEqual(_without_keys(response.json()["value"]), "<p>Edited <b>inline</b></p>")

    def test_unknown_block_types_are_rejected(self):
        response = self.post_json("visual_editor_new_block", {"stream": "content", "type": "nope"})

        self.assertEqual(response.status_code, 404)

    def test_block_form_returns_wagtail_block_definition(self):
        data = self.post_json(
            "visual_editor_block_form",
            {"stream": "content", "type": "button_link", "value": {"text": "Go", "url": "https://example.com"}},
        ).json()

        self.assertEqual(data["prefix"], "ve-block")
        self.assertEqual(data["state"]["text"], "Go")
        self.assertIsNone(data["error"])

    def test_block_value_converts_submitted_form_data(self):
        response = self.client.post(
            self.url("visual_editor_block_value"),
            {"__stream": "content", "__type": "button_link", "ve-block-text": "Read more", "ve-block-url": "https://example.com"},
        )

        self.assertEqual(response.json()["value"], {"text": "Read more", "url": "https://example.com"})

    def test_save_draft_creates_a_revision_with_the_edits(self):
        state = self.state()
        state["fields"]["title"] = "Edited visually"
        state["streams"]["content"][0]["value"]["heading"] = "Edited heading"

        response = self.post_json(
            "visual_editor_save", {"state": state, "action": "draft", "baseRevisionId": self.page.latest_revision_id}
        )

        self.assertEqual(response.status_code, 200, response.content)
        page = Page.objects.get(id=self.page.id).specific
        self.assertTrue(page.has_unpublished_changes)
        self.assertEqual(page.title, "Kitchen Sink")
        draft = page.get_latest_revision_as_object()
        self.assertEqual(draft.title, "Edited visually")
        self.assertEqual(draft.content[0].value["heading"], "Edited heading")

    def test_publish_makes_the_edits_live(self):
        state = self.state()
        state["fields"]["title"] = "Published visually"

        response = self.post_json(
            "visual_editor_save", {"state": state, "action": "publish", "baseRevisionId": self.page.latest_revision_id}
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertEqual(Page.objects.get(id=self.page.id).title, "Published visually")

    def test_invalid_blocks_are_reported_by_id(self):
        state = self.state()
        state["streams"]["content"][0]["value"]["faqs"][0]["value"]["question"] = ""

        response = self.post_json(
            "visual_editor_save", {"state": state, "action": "draft", "baseRevisionId": self.page.latest_revision_id}
        )

        self.assertEqual(response.status_code, 400)
        messages = response.json()["errors"]["streams"]["content"]["blocks"][self.faq_id]
        self.assertTrue(any("Question" in message for message in messages), messages)

    def test_saving_over_someone_elses_newer_revision_needs_confirmation(self):
        state = self.state()
        stale_revision_id = self.page.latest_revision_id
        Page.objects.get(id=self.page.id).specific.save_revision()

        response = self.post_json(
            "visual_editor_save", {"state": state, "action": "draft", "baseRevisionId": stale_revision_id}
        )
        self.assertEqual(response.status_code, 409)

        response = self.post_json(
            "visual_editor_save", {"state": state, "action": "draft", "baseRevisionId": stale_revision_id, "force": True}
        )
        self.assertEqual(response.status_code, 200)


class SnippetEditingTest(TestCase):
    """Snippets a page shows (here a FrontPage's pre-footer CTA) can be edited from the visual editor."""

    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        from cms.models import PreFooterCTA

        Site.objects.all().delete()
        locale, _ = Locale.objects.get_or_create(language_code="en")
        root = Page.get_first_root_node() or Page.add_root(instance=Page(title="Root", slug="root", locale=locale))
        Site.objects.create(hostname="localhost", port=80, root_page=root, is_default_site=True)

        cls.cta = PreFooterCTA.objects.create(headline="Ready to get started?", button_label="Go")
        cls.key = f"cms.prefootercta:{cls.cta.pk}"
        cls.page = FrontPage(
            title="With a CTA",
            slug="with-a-cta",
            locale=locale,
            pre_footer_cta=cls.cta,
            pre_footer_transition=[{"type": "transition", "value": {}}],
        )
        root.add_child(instance=cls.page)
        cls.page.save_revision().publish()
        cls.admin = User.objects.create_superuser("snippet-admin", "snippet-admin@example.com", "password")

    def setUp(self):
        self.client.force_login(self.admin)

    def url(self, name):
        return reverse(name, args=[self.page.id])

    def post_json(self, name, body):
        return self.client.post(self.url(name), json.dumps(body), content_type="application/json")

    def state(self, **snippet_values):
        page = Page.objects.get(id=self.page.id).specific
        state = page_to_state(page.get_latest_revision_as_object(), PageSchema(FrontPage))
        if snippet_values:
            state["snippets"] = {self.key: snippet_values}
        return state

    def test_snippet_text_is_marked_and_unsaved_edits_are_shown(self):
        data = self.post_json("visual_editor_render", {"state": self.state(headline="Let’s talk")}).json()

        self.assertEqual(data["snippets"][self.key]["owners"], [{"kind": "field", "name": "pre_footer_cta", "label": "Pre footer cta"}])
        self.assertTrue(data["snippets"][self.key]["editable"])
        self.assertIn(["snippets", self.key, "headline"], [entry["path"] for entry in data["registry"]])
        self.assertIn("Let’s talk", re.sub("[\U000f0000-\U000f00ff]", "", data["html"]))
        self.cta.refresh_from_db()
        self.assertEqual(self.cta.headline, "Ready to get started?")

    def test_snippet_form_includes_unsaved_edits(self):
        data = self.post_json("visual_editor_snippet_form", {"key": self.key, "state": self.state(headline="Let’s talk")}).json()

        self.assertEqual(data["values"]["headline"], "Let’s talk")
        self.assertEqual(data["usage"], 1)
        self.assertIn('data-field-name="headline"', data["html"])

    def test_saving_the_page_saves_the_snippet(self):
        response = self.post_json(
            "visual_editor_save",
            {"state": self.state(headline="Let’s talk"), "action": "draft", "baseRevisionId": self.page.latest_revision_id},
        )

        self.assertEqual(response.status_code, 200, response.content)
        self.assertIn("Updated", response.json()["message"])
        self.cta.refresh_from_db()
        self.assertEqual(self.cta.headline, "Let’s talk")
        self.assertTrue(Page.objects.get(id=self.page.id).has_unpublished_changes)

    def test_invalid_snippet_edits_save_nothing(self):
        revisions = self.page.revisions.count()

        response = self.post_json(
            "visual_editor_save",
            {"state": self.state(headline=""), "action": "draft", "baseRevisionId": self.page.latest_revision_id},
        )

        self.assertEqual(response.status_code, 400)
        self.assertIn("headline", response.json()["errors"]["snippets"][self.key])
        self.assertEqual(self.page.revisions.count(), revisions)

    def test_editors_without_snippet_permission_cannot_change_it(self):
        from wagtail.models import GroupPagePermission

        editors = Group.objects.create(name="Page editors only")
        editors.permissions.add(Permission.objects.get(codename="access_admin"))
        GroupPagePermission.objects.create(
            group=editors, page=Page.get_first_root_node(), permission=Permission.objects.get(codename="change_page")
        )
        editor = User.objects.create_user("page-editor", "page-editor@example.com", "password")
        editor.groups.add(editors)
        self.client.force_login(editor)

        data = self.post_json("visual_editor_render", {"state": self.state()}).json()
        self.assertFalse(data["snippets"][self.key]["editable"])

        response = self.post_json(
            "visual_editor_save",
            {"state": self.state(headline="Sneaky"), "action": "draft", "baseRevisionId": self.page.latest_revision_id},
        )
        self.assertNotEqual(response.status_code, 200)
        self.cta.refresh_from_db()
        self.assertEqual(self.cta.headline, "Ready to get started?")
