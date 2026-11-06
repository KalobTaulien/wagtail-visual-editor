"""
Snippet models with revisions and drafts, only for tests: none of the project's
snippets use RevisionMixin or DraftStateMixin yet. Their tables are created by
`DraftSnippetTestMixin` for the test classes that need them (there are no
migrations for these models).
"""

from django.db import connection, models
from wagtail.models import DraftStateMixin, LockableMixin, RevisionMixin
from wagtail.snippets.models import register_snippet


class DraftableTestSnippet(DraftStateMixin, LockableMixin, RevisionMixin, models.Model):
    title = models.CharField(max_length=100)

    class Meta:
        app_label = "visual_editor"

    def __str__(self):
        return self.title


class RevisionedTestSnippet(RevisionMixin, models.Model):
    title = models.CharField(max_length=100)

    class Meta:
        app_label = "visual_editor"

    def __str__(self):
        return self.title


TEST_SNIPPET_MODELS = [DraftableTestSnippet, RevisionedTestSnippet]
for _model in TEST_SNIPPET_MODELS:
    register_snippet(_model)


class DraftSnippetTestMixin:
    """Create the test snippet tables before the test class's transaction, and drop them after."""

    @classmethod
    def setUpClass(cls):
        with connection.schema_editor() as editor:
            for model in TEST_SNIPPET_MODELS:
                editor.create_model(model)
        super().setUpClass()

    @classmethod
    def tearDownClass(cls):
        super().tearDownClass()
        with connection.schema_editor() as editor:
            for model in TEST_SNIPPET_MODELS:
                editor.delete_model(model)
