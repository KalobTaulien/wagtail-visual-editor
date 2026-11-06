"""
Point-and-click visual editor for Wagtail pages (prototype).

The editor renders the page's real template in an iframe and lets editors click
straight into it: text is edited in place, StreamField blocks are selected,
reordered, added and configured from a sidebar, and every change re-renders the
preview.

How the canvas maps rendered HTML back to fields:

- Free-text values (CharBlock/TextBlock values and page-level CharField/TextField
  values) are wrapped in invisible Private Use Area markers before rendering
  (`instrument.Registry`). The browser finds those markers in text nodes and
  turns the surrounding element into an inline-editable region.
- Every top-level StreamField block's rendered HTML is bracketed with
  `<template data-ve-start>`/`<template data-ve-end>` markers, which the
  browser uses to tag the block's elements and then removes.

Nothing here touches the stored page until the editor saves: each render builds
a throwaway page object from the editor's JSON state (`state.py`).

Modules:

- `views.py`, `urls.py`, `wagtail_hooks.py`: the admin views under
  `/cms-admin/visual-editor/`, and the "Visual editor" page buttons.
- `instrument.py`, `placeholders.py`: marking a page's values for the canvas, and
  "Insert text here" for empty required text.
- `state.py`: the editor's JSON state, and moving it on and off page objects.
- `rich_text.py`: inline rich text editing, back to Wagtail's stored format.
- `snippets.py`: editing (and drafting) the snippets a page shows.
- `rich_text_links.py`: the "Open link in a new tab" rich text link option.
- `spacing.py`: `SpacingBlock`, the per-block spacing options the editor's
  Spacing panel edits.
- `templates/visual_editor/`, `static/visual_editor/`: the editor's shell and
  its browser code.

See README.md for installing it in a project.
"""
