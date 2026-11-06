import uuid

from django.contrib.auth.models import Permission, User
from django.contrib.contenttypes.models import ContentType
from wagtail.blocks import StreamBlock
from wagtail.blocks.stream_block import StreamValue
from wagtail.snippets.blocks import SnippetChooserBlock

from cms.models import PreFooterCTA
from visual_editor.tests.draftable_snippets import DraftableTestSnippet, DraftSnippetTestMixin, RevisionedTestSnippet
from visual_editor.instrument import Registry
from visual_editor.snippets import (
    changed_snippets,
    load_snippet,
    prepare_snippets,
    publish_snippets,
    save_snippets,
    snippet_key,
    snippet_schema,
)
from utils.testing import TestCase

STREAM_BLOCK = StreamBlock([("snippet", SnippetChooserBlock(DraftableTestSnippet))])


class FakeSchema:
    """Just enough of a PageSchema for a page that chooses snippets in one StreamField."""

    simple_field_names = []
    stream_field_names = ["body"]


class FakePage:
    def __init__(self, *snippets):
        self.body = StreamValue(STREAM_BLOCK, [("snippet", snippet, str(uuid.uuid4())) for snippet in snippets])


class SnippetDraftsTest(DraftSnippetTestMixin, TestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        cls.admin = User.objects.create_superuser("drafts-admin", "drafts-admin@example.com", "password")

    def setUp(self):
        self.snippet = DraftableTestSnippet.objects.create(title="Live title", live=True)
        self.snippet.save_revision(user=self.admin).publish(user=self.admin)
        self.key = snippet_key(self.snippet)

    def save_draft(self, title):
        draft = self.snippet.get_latest_revision_as_object()
        draft.title = title
        draft.save_revision(user=self.admin)

    def editor_with(self, *codenames):
        user = User.objects.create_user(f"user-{len(codenames)}", password="password")
        content_type = ContentType.objects.get_for_model(DraftableTestSnippet)
        for codename in codenames:
            permission, _ = Permission.objects.get_or_create(
                codename=f"{codename}_draftabletestsnippet", content_type=content_type, defaults={"name": codename}
            )
            user.user_permissions.add(permission)
        return User.objects.get(pk=user.pk)

    def test_modes_follow_the_mixins(self):
        self.assertEqual(snippet_schema(DraftableTestSnippet).mode, "drafts")
        self.assertEqual(snippet_schema(RevisionedTestSnippet).mode, "revisions")
        self.assertEqual(snippet_schema(PreFooterCTA).mode, "direct")

    def test_the_editor_edits_the_latest_draft(self):
        self.save_draft("Draft title")

        obj, _schema = load_snippet(self.key, None, self.admin)

        self.assertEqual(obj.title, "Draft title")

    def test_the_canvas_shows_the_draft_where_the_snippet_is_chosen(self):
        self.save_draft("Draft title")
        page = FakePage(DraftableTestSnippet.objects.get(pk=self.snippet.pk))

        described = prepare_snippets(page, FakeSchema(), {}, Registry(), self.admin)

        # The draft is what's chosen now, with its title marked for in-place editing.
        self.assertEqual(page.body[0].value.title.visible, "Draft title")
        self.assertEqual(described[self.key]["mode"], "drafts")
        self.assertTrue(described[self.key]["hasUnpublishedChanges"])

    def test_saving_keeps_edits_as_a_draft(self):
        instances, errors = changed_snippets({"snippets": {self.key: {"title": "Edited"}}}, self.admin)
        save_snippets(instances, self.admin)

        self.assertEqual(errors, {})
        self.snippet.refresh_from_db()
        self.assertEqual(self.snippet.title, "Live title")
        self.assertTrue(self.snippet.has_unpublished_changes)
        self.assertEqual(self.snippet.get_latest_revision_as_object().title, "Edited")

    def test_publishing_the_page_publishes_its_draft_snippets(self):
        self.save_draft("Draft title")

        published, skipped = publish_snippets(FakePage(self.snippet), FakeSchema(), self.admin)

        self.assertEqual([obj.pk for obj in published], [self.snippet.pk])
        self.assertEqual(skipped, [])
        self.snippet.refresh_from_db()
        self.assertEqual(self.snippet.title, "Draft title")
        self.assertFalse(self.snippet.has_unpublished_changes)

    def test_snippets_without_drafts_are_not_published_again(self):
        published, skipped = publish_snippets(FakePage(self.snippet), FakeSchema(), self.admin)

        self.assertEqual((published, skipped), ([], []))

    def test_editors_who_cannot_publish_the_snippet_leave_it_as_a_draft(self):
        self.save_draft("Draft title")
        editor = self.editor_with("change")

        published, skipped = publish_snippets(FakePage(self.snippet), FakeSchema(), editor)

        self.assertEqual(published, [])
        self.assertEqual([obj.pk for obj in skipped], [self.snippet.pk])
        self.snippet.refresh_from_db()
        self.assertEqual(self.snippet.title, "Live title")

    def test_editors_who_can_publish_the_snippet_publish_it(self):
        self.save_draft("Draft title")

        published, _skipped = publish_snippets(FakePage(self.snippet), FakeSchema(), self.editor_with("change", "publish"))

        self.assertEqual(len(published), 1)

    def test_snippets_locked_by_someone_else_are_not_editable(self):
        other = self.editor_with("change", "publish")
        self.snippet.locked = True
        self.snippet.locked_by = other
        self.snippet.save()

        page = FakePage(DraftableTestSnippet.objects.get(pk=self.snippet.pk))
        described = prepare_snippets(page, FakeSchema(), {}, Registry(), self.admin)

        self.assertFalse(described[self.key]["editable"])

    def test_revisioned_snippets_go_live_and_keep_a_revision(self):
        snippet = RevisionedTestSnippet.objects.create(title="Before")
        key = snippet_key(snippet)

        instances, _errors = changed_snippets({"snippets": {key: {"title": "After"}}}, self.admin)
        save_snippets(instances, self.admin)

        snippet.refresh_from_db()
        self.assertEqual(snippet.title, "After")
        self.assertEqual(snippet.revisions.count(), 1)
