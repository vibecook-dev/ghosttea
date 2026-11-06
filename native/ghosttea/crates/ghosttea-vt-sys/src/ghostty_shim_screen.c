#include "ghostty_shim_internal.h"

#include <stdint.h>
#include <string.h>

static EgCharsetState eg_charset_state(GhosttyTerminalCharsetState source) {
  EgCharsetState result = {
      .g0 = (uint8_t)source.g0,
      .g1 = (uint8_t)source.g1,
      .g2 = (uint8_t)source.g2,
      .g3 = (uint8_t)source.g3,
      .gl = (uint8_t)source.gl,
      .gr = (uint8_t)source.gr,
      .single_shift = source.has_single_shift
          ? (uint8_t)source.single_shift
          : UINT8_MAX,
  };
  return result;
}

size_t eg_utf8_encode(uint32_t codepoint, uint8_t out[4]) {
  if (codepoint <= 0x7f) {
    out[0] = (uint8_t)codepoint;
    return 1;
  }
  if (codepoint <= 0x7ff) {
    out[0] = (uint8_t)(0xc0 | (codepoint >> 6));
    out[1] = (uint8_t)(0x80 | (codepoint & 0x3f));
    return 2;
  }
  if (codepoint <= 0xffff) {
    out[0] = (uint8_t)(0xe0 | (codepoint >> 12));
    out[1] = (uint8_t)(0x80 | ((codepoint >> 6) & 0x3f));
    out[2] = (uint8_t)(0x80 | (codepoint & 0x3f));
    return 3;
  }
  out[0] = (uint8_t)(0xf0 | (codepoint >> 18));
  out[1] = (uint8_t)(0x80 | ((codepoint >> 12) & 0x3f));
  out[2] = (uint8_t)(0x80 | ((codepoint >> 6) & 0x3f));
  out[3] = (uint8_t)(0x80 | (codepoint & 0x3f));
  return 4;
}

static int eg_screen_cell(EgTerminal* state,
                          const GhosttyGridRef* ref,
                          GhosttyCell cell,
                          uint32_t row,
                          uint16_t column,
                          EgScreenCellFn cell_fn,
                          EgHyperlinkUriFn hyperlink_fn,
                          void* userdata) {
  GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
  GhosttyResult result = ghostty_cell_get(cell, GHOSTTY_CELL_DATA_WIDE, &wide);
  if (result != GHOSTTY_SUCCESS) return result;
  if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL ||
      wide == GHOSTTY_CELL_WIDE_SPACER_HEAD)
    return GHOSTTY_SUCCESS;

  bool has_text = false;
  bool has_styling = false;
  bool has_hyperlink = false;
  bool protected_cell = false;
  GhosttyCellSemanticContent semantic = GHOSTTY_CELL_SEMANTIC_OUTPUT;
  GhosttyCellContentTag content_tag = GHOSTTY_CELL_CONTENT_CODEPOINT;
  result = ghostty_cell_get(cell, GHOSTTY_CELL_DATA_HAS_TEXT, &has_text);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_cell_get(cell, GHOSTTY_CELL_DATA_HAS_STYLING, &has_styling);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_cell_get(
      cell, GHOSTTY_CELL_DATA_HAS_HYPERLINK, &has_hyperlink);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_cell_get(
      cell, GHOSTTY_CELL_DATA_PROTECTED, &protected_cell);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_cell_get(
      cell, GHOSTTY_CELL_DATA_SEMANTIC_CONTENT, &semantic);
  if (result != GHOSTTY_SUCCESS) return result;
  result = ghostty_cell_get(cell, GHOSTTY_CELL_DATA_CONTENT_TAG, &content_tag);
  if (result != GHOSTTY_SUCCESS) return result;

  const size_t start = state->row.len;
  if (!has_text) {
    const uint8_t space = ' ';
    if (!eg_buffer_append(&state->row, &space, 1))
      return GHOSTTY_OUT_OF_MEMORY;
  } else {
    size_t codepoint_count = 0;
    result = ghostty_grid_ref_graphemes(ref, NULL, 0, &codepoint_count);
    if (result != GHOSTTY_SUCCESS && result != GHOSTTY_OUT_OF_SPACE)
      return result;
    if (codepoint_count > SIZE_MAX / sizeof(uint32_t))
      return GHOSTTY_OUT_OF_MEMORY;
    const size_t required = codepoint_count * sizeof(uint32_t);
    if (!eg_buffer_reserve(&state->grapheme, required))
      return GHOSTTY_OUT_OF_MEMORY;
    result = ghostty_grid_ref_graphemes(
        ref, (uint32_t*)state->grapheme.ptr,
        state->grapheme.cap / sizeof(uint32_t), &codepoint_count);
    if (result != GHOSTTY_SUCCESS) return result;
    const uint32_t* codepoints = (const uint32_t*)state->grapheme.ptr;
    for (size_t index = 0; index < codepoint_count; index++) {
      uint8_t encoded[4];
      const size_t len = eg_utf8_encode(codepoints[index], encoded);
      if (!eg_buffer_append(&state->row, encoded, len))
        return GHOSTTY_OUT_OF_MEMORY;
    }
  }

  // Default blank cells are implicit. Preserve only cells carrying content or
  // behavior, so large blank scrollback does not allocate per-column strings.
  const bool non_default = has_text || has_styling || has_hyperlink ||
      protected_cell || semantic != GHOSTTY_CELL_SEMANTIC_OUTPUT ||
      content_tag != GHOSTTY_CELL_CONTENT_CODEPOINT;
  GhosttyStyle raw_style = GHOSTTY_INIT_SIZED(GhosttyStyle);
  if (has_styling) {
    result = ghostty_grid_ref_style(ref, &raw_style);
    if (result != GHOSTTY_SUCCESS) return result;
  }
  if (content_tag == GHOSTTY_CELL_CONTENT_BG_COLOR_PALETTE) {
    raw_style.bg_color.tag = GHOSTTY_STYLE_COLOR_PALETTE;
    result = ghostty_cell_get(
        cell, GHOSTTY_CELL_DATA_COLOR_PALETTE,
        &raw_style.bg_color.value.palette);
    if (result != GHOSTTY_SUCCESS) return result;
  } else if (content_tag == GHOSTTY_CELL_CONTENT_BG_COLOR_RGB) {
    raw_style.bg_color.tag = GHOSTTY_STYLE_COLOR_RGB;
    result = ghostty_cell_get(
        cell, GHOSTTY_CELL_DATA_COLOR_RGB, &raw_style.bg_color.value.rgb);
    if (result != GHOSTTY_SUCCESS) return result;
  }
  EgTerminalStyle style;
  eg_terminal_style(raw_style, &style);
  const uint16_t span = wide == GHOSTTY_CELL_WIDE_WIDE ? 2 : 1;
  if (non_default) {
    const uint8_t* text = has_text ? state->row.ptr + start : NULL;
    const size_t text_len = has_text ? state->row.len - start : 0;
    cell_fn(userdata, row, column, span, text, text_len, &style,
            protected_cell, (uint8_t)semantic);
  }
  if (has_hyperlink) {
    result = eg_emit_hyperlink_uri(
        state, ref, row, column, span, hyperlink_fn, userdata);
    if (result != GHOSTTY_SUCCESS) return result;
  }
  return GHOSTTY_SUCCESS;
}

int eg_terminal_screen_snapshot(EgTerminal* state,
                                uint8_t screen,
                                EgScreenMeta* meta,
                                EgRowFn row_fn,
                                EgScreenCellFn cell_fn,
                                EgHyperlinkUriFn hyperlink_fn,
                                void* userdata) {
  if (state == NULL || meta == NULL || row_fn == NULL || cell_fn == NULL ||
      screen > 1)
    return -1;
  GhosttyTerminalScreenState raw =
      GHOSTTY_INIT_SIZED(GhosttyTerminalScreenState);
  GhosttyResult result = ghostty_terminal_screen_get(
      state->terminal, (GhosttyTerminalScreen)screen, &raw);
  if (result == GHOSTTY_NO_VALUE) return 0;
  if (result != GHOSTTY_SUCCESS) return -1;

  meta->cols = raw.cols;
  meta->rows = raw.rows;
  meta->total_rows = raw.total_rows;
  meta->scrollback_rows = raw.scrollback_rows;
  meta->cursor_x = raw.cursor_x;
  meta->cursor_y = raw.cursor_y;
  meta->cursor_visual_style = (uint8_t)raw.cursor_visual_style;
  eg_terminal_style(raw.cursor_style, &meta->cursor_style);
  meta->cursor_protected = raw.cursor_protected;
  meta->cursor_pending_wrap = raw.cursor_pending_wrap;
  meta->charset = eg_charset_state(raw.charset);
  meta->kitty_keyboard_flags = raw.kitty_keyboard_flags;
  meta->viewport_offset = raw.viewport_offset;
  meta->cursor_semantic_content = (uint8_t)raw.cursor_semantic_content;
  meta->cursor_semantic_content_clear_eol =
      raw.cursor_semantic_content_clear_eol;
  meta->hyperlink_implicit_id = raw.hyperlink_implicit_id;
  meta->protected_mode = (uint8_t)raw.protected_mode;
  memcpy(meta->kitty_keyboard_stack, raw.kitty_keyboard_stack,
         sizeof(meta->kitty_keyboard_stack));
  meta->kitty_keyboard_index = raw.kitty_keyboard_index;
  meta->semantic_prompt_seen = raw.semantic_prompt_seen;
  meta->semantic_prompt_click = (uint8_t)raw.semantic_prompt_click;

  GhosttyTerminalScreenRowIterator iterator = NULL;
  result = ghostty_terminal_screen_row_iterator_new(
      NULL, state->terminal, (GhosttyTerminalScreen)screen, &iterator);
  if (result != GHOSTTY_SUCCESS) return -1;

  uint64_t row = 0;
  int status = -1;
  for (;;) {
    GhosttyGridRef row_ref = GHOSTTY_INIT_SIZED(GhosttyGridRef);
    bool has_row = false;
    result = ghostty_terminal_screen_row_iterator_next(
        iterator, &row_ref, &has_row);
    if (result != GHOSTTY_SUCCESS) goto cleanup;
    if (!has_row) break;
    if (row > UINT32_MAX || row >= raw.total_rows) goto cleanup;
    state->row.len = 0;
    bool wrap = false;
    bool wrap_continuation = false;
    GhosttyRowSemanticPrompt semantic_prompt = GHOSTTY_ROW_SEMANTIC_NONE;
    GhosttyRow raw_row = 0;
    result = ghostty_grid_ref_row(&row_ref, &raw_row);
    if (result != GHOSTTY_SUCCESS) goto cleanup;
    result = ghostty_row_get(raw_row, GHOSTTY_ROW_DATA_WRAP, &wrap);
    if (result != GHOSTTY_SUCCESS) goto cleanup;
    result = ghostty_row_get(
        raw_row, GHOSTTY_ROW_DATA_WRAP_CONTINUATION, &wrap_continuation);
    if (result != GHOSTTY_SUCCESS) goto cleanup;
    result = ghostty_row_get(
        raw_row, GHOSTTY_ROW_DATA_SEMANTIC_PROMPT, &semantic_prompt);
    if (result != GHOSTTY_SUCCESS) goto cleanup;

    for (uint16_t column = 0; column < raw.cols; column++) {
      GhosttyGridRef ref = row_ref;
      ref.x = column;
      GhosttyCell cell = 0;
      result = ghostty_grid_ref_cell(&ref, &cell);
      if (result != GHOSTTY_SUCCESS) goto cleanup;
      result = eg_screen_cell(
          state, &ref, cell, (uint32_t)row, column, cell_fn,
          hyperlink_fn, userdata);
      if (result != GHOSTTY_SUCCESS) goto cleanup;
    }
    while (state->row.len > 0 && state->row.ptr[state->row.len - 1] == ' ')
      state->row.len -= 1;
    row_fn(userdata, (uint32_t)row, state->row.ptr, state->row.len, true,
           wrap, wrap_continuation, (uint8_t)semantic_prompt);
    row += 1;
  }
  if (row != raw.total_rows) goto cleanup;
  status = 1;

cleanup:
  ghostty_terminal_screen_row_iterator_free(iterator);
  return status;
}
