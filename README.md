# Visual editor

A point-and-click editor for Wagtail pages: the page's real template is rendered
in the admin, and editors click into it to edit text, rich text, StreamField
blocks, page settings, the snippets the page shows, and block spacing. Changes
show on the canvas straight away and are saved as a page revision (or
published) from the editor's top bar.

It's a self-contained Django app (`visual_editor`) with its own
templates, static files, Wagtail hooks and tests. It has no models or
migrations.

## Requirements

- Django 5.2, Wagtail 7.3
- `django.contrib.staticfiles` with `AppDirectoriesFinder`, and template loading
  from app directories (`APP_DIRS` or the app directories loader).

## Installing

1. Add the app to `INSTALLED_APPS`, after Wagtail's apps:

   ```python
   INSTALLED_APPS = [
       # ...
       "wagtail",
       "visual_editor.apps.VisualEditorConfig",
   ]
   ```

   Wagtail finds `visual_editor/wagtail_hooks.py` itself. The hooks
   add the editor's admin URLs (`/<admin>/visual-editor/pages/<id>/`), a
   "Visual editor" button on page headers and listings, and the "Open link in a
   new tab" option for rich text links.

2. That's all the editor needs. To give a block the spacing options, see below.

## Block spacing

`spacing.py` provides `SpacingBlock`: margin and padding above and below a
block, for desktop and mobile, as custom `px`/`rem` values. Blank values keep
the template's own spacing. The editor shows a ⚙ Spacing panel (with drag
handles on the canvas) for any block that has one.

To add spacing to a block:

```python
from visual_editor.spacing import SpacingBlock, with_spacing_settings

class StepsListBlock(StructBlock):
    heading = CharBlock()
    steps_list = ListBlock(StepsBlock())
    spacing = SpacingBlock()

    class Meta:
        form_layout = with_spacing_settings("heading", "steps_list")
```

and apply it to the outermost element of the block's template:

```django
<section{% if value.spacing.classes %} class="{{ value.spacing.classes }}"{% endif %} style="{{ value.spacing.style }}">
```

Values are applied through CSS variables read by the UnoCSS utilities listed in
`SPACING_UTILITIES`. UnoCSS must scan `spacing.py` to generate them
(`vite/uno-content-globs.ts` includes `src/visual_editor/**/*.py`),
and utilities must be `!important` (UnoCSS `important: true`) to override the
template's own spacing. Adding `SpacingBlock` to a block changes its
StreamField definitions, so run `makemigrations` for the app that owns them.

## Project hooks the editor reads

- Blocks with a truthy `deprecated` attribute aren't offered in the "Add block"
  menu (here, `your project's DeprecatedBlockMixin`).
- Blocks with `inline_editable = False` aren't edited in place on the canvas
  (e.g. `SpacingLengthBlock`, whose value is a CSS length rather than copy).
- During editor renders, `request.is_visual_editor` is `True`.

## Tests

```sh
python manage.py test visual_editor
```

The tests use this project's page and snippet models (`FrontPage`,
`PreFooterCTA`, `StepsListBlock`) as fixtures. `tests/draftable_snippets.py`
defines test-only snippet models with drafts and revisions; their tables are
created and dropped around the tests that use them.
