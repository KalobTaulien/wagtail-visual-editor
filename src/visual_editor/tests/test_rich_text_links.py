import re

from wagtail.admin.rich_text.converters.contentstate import ContentstateConverter
from wagtail.models import Locale, Page
from wagtail.rich_text import expand_db_html
from wagtail.rich_text import features as feature_registry

from cms.models import FrontPage
from visual_editor.rich_text_links import NewTabPageLinkHandler
from utils.testing import TestCase


def _without_keys(html):
    return re.sub(r' data-block-key="\w+"', "", html)


class LinkNewTabTest(TestCase):
    @classmethod
    def setUpTestData(cls):
        super().setUpTestData()
        locale, _ = Locale.objects.get_or_create(language_code="en")
        root = Page.get_first_root_node() or Page.add_root(instance=Page(title="Root", slug="root", locale=locale))
        cls.target = root.add_child(instance=FrontPage(title="Target", slug="target", locale=locale))

    def round_trip(self, html):
        converter = ContentstateConverter(["link"])
        return _without_keys(converter.to_database_format(converter.from_database_format(html)))

    def test_link_feature_is_replaced(self):
        self.assertIs(feature_registry.get_link_types()["page"], NewTabPageLinkHandler)
        self.assertIn("visual_editor/draftail_link_new_tab.js", feature_registry.get_editor_plugin("draftail", "link").js)

    def test_external_new_tab_links_survive_a_draftail_save(self):
        html = '<p><a href="https://example.com" target="_blank" rel="noopener noreferrer">New tab</a></p>'

        self.assertEqual(self.round_trip(html), html)

    def test_page_new_tab_links_survive_a_draftail_save(self):
        html = f'<p><a linktype="page" id="{self.target.id}" target="_blank" rel="noopener noreferrer">New tab</a></p>'

        self.assertEqual(self.round_trip(html), html)

    def test_links_without_new_tab_are_unchanged(self):
        html = f'<p><a href="https://example.com">Same tab</a> <a linktype="page" id="{self.target.id}">Page</a></p>'

        self.assertEqual(self.round_trip(html), html)

    def test_page_links_render_with_target_and_rel(self):
        html = expand_db_html(f'<a linktype="page" id="{self.target.id}" target="_blank">New tab</a>')

        self.assertIn('target="_blank" rel="noopener noreferrer"', html)
        self.assertIn(f'href="{self.target.url}"', html)
        self.assertNotIn("target", expand_db_html(f'<a linktype="page" id="{self.target.id}">Same tab</a>'))
