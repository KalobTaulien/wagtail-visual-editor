from django.urls import path

from visual_editor import views

urlpatterns = [
    path("pages/<int:page_id>/", views.editor, name="visual_editor"),
    path("pages/<int:page_id>/render/", views.render_preview, name="visual_editor_render"),
    path("pages/<int:page_id>/block-form/", views.block_form, name="visual_editor_block_form"),
    path("pages/<int:page_id>/block-value/", views.block_value, name="visual_editor_block_value"),
    path("pages/<int:page_id>/new-block/", views.new_block, name="visual_editor_new_block"),
    path("pages/<int:page_id>/rich-text-value/", views.rich_text_value, name="visual_editor_rich_text_value"),
    path("pages/<int:page_id>/page-form/", views.page_form, name="visual_editor_page_form"),
    path("pages/<int:page_id>/page-value/", views.page_value, name="visual_editor_page_value"),
    path("pages/<int:page_id>/snippet-form/", views.snippet_form, name="visual_editor_snippet_form"),
    path("pages/<int:page_id>/snippet-value/", views.snippet_value, name="visual_editor_snippet_value"),
    path("pages/<int:page_id>/save/", views.save, name="visual_editor_save"),
]
