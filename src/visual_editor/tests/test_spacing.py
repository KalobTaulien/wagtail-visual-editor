from pathlib import Path

from django.core.exceptions import ValidationError

from cms.models.blocks_models import StepsListBlock
from visual_editor.spacing import SPACING_UTILITIES, SpacingBlock, parse_length
from utils.testing import UnitTestCase


class ParseLengthTest(UnitTestCase):
    def test_lengths_are_normalised(self):
        self.assertEqual(parse_length("24"), "24px")
        self.assertEqual(parse_length(" 1.50REM "), "1.5rem")
        self.assertEqual(parse_length("0"), "0px")
        self.assertEqual(parse_length("-8px"), "-8px")
        self.assertIsNone(parse_length(""))

    def test_anything_else_is_refused(self):
        for value in ["24em", "big", "1px; color: red", "calc(1px)", "2000px", "100rem"]:
            with self.subTest(value=value), self.assertRaises(ValueError):
                parse_length(value)

    def test_padding_cannot_be_negative(self):
        with self.assertRaises(ValueError):
            parse_length("-8px", allow_negative=False)


class SpacingBlockTest(UnitTestCase):
    def value(self, **sizes):
        return SpacingBlock().to_python(sizes)

    def test_blank_sizes_leave_the_templates_spacing_alone(self):
        value = self.value()

        self.assertEqual((value.classes, value.style), ("", ""))

    def test_custom_sizes_set_variables_read_by_utilities(self):
        value = self.value(desktop_padding_top="3rem", mobile_margin_bottom="24")

        self.assertEqual(set(value.classes.split()), {"md:pt-[var(--space-pt-desktop)]", "mb-[var(--space-mb)]"})
        self.assertIn("--space-pt-desktop: 3rem;", value.style)
        self.assertIn("--space-mb: 24px;", value.style)

    def test_invalid_values_are_never_written_into_the_style(self):
        """The visual editor renders unsaved values, so the style must not trust them."""
        value = self.value(mobile_padding_top="1px; background: red", mobile_margin_top="-8px", mobile_padding_bottom="-8px")

        self.assertEqual(value.style, "--space-mt: -8px; ")

    def test_saving_validates_and_normalises(self):
        cleaned = SpacingBlock().clean(self.value(desktop_margin_top=" 2REM ", mobile_padding_top="16"))
        self.assertEqual((cleaned["desktop_margin_top"], cleaned["mobile_padding_top"]), ("2rem", "16px"))

        with self.assertRaises(ValidationError):
            SpacingBlock().clean(self.value(mobile_padding_bottom="-4px"))

    def test_every_field_has_a_utility(self):
        self.assertEqual(set(SPACING_UTILITIES), set(SpacingBlock.base_blocks))

    def test_classes_are_written_out_for_unocss(self):
        """UnoCSS only generates utilities it finds as literal text, so none may be built from parts."""
        source = Path(SpacingBlock.__module__.replace(".", "/") + ".py")
        text = next(p for p in [Path("src") / source, source] if p.exists()).read_text()
        for css_class, variable in SPACING_UTILITIES.values():
            self.assertIn(f'"{css_class}"', text)
            self.assertIn(variable, css_class)


class StepsListSpacingTest(UnitTestCase):
    def render(self, spacing=None):
        block = StepsListBlock()
        raw = {"heading": "", "steps_list": [{"type": "item", "value": {"heading": "One", "text": ""}}]}
        if spacing is not None:
            raw["spacing"] = spacing
        return block.render(block.to_python(raw), context={"content_bg_color": "--color-white", "page": None})

    def test_spacing_is_applied_to_the_section(self):
        html = self.render({"desktop_padding_top": "96px"})

        self.assertIn('<section class="md:pt-[var(--space-pt-desktop)]" style="--space-pt-desktop: 96px; background-color', html)

    def test_existing_content_without_spacing_renders_as_before(self):
        self.assertIn('<section style="background-color', self.render())

    def test_spacing_is_in_the_blocks_settings(self):
        self.assertEqual(StepsListBlock().meta.form_layout.settings, ["spacing"])
