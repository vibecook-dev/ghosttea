#include "ghostty_shim_internal.h"

#include <stdint.h>

static int eg_emit_hyperlink_identity(
    EgTerminal* state,
    const GhosttyGridRef* ref,
    uint32_t row,
    uint16_t column,
    uint16_t span,
    EgHyperlinkIdentityFn identity_fn,
    void* userdata) {
  GhosttyHyperlinkIdentity identity =
      GHOSTTY_INIT_SIZED(GhosttyHyperlinkIdentity);
  size_t id_len = 0;
  GhosttyResult result = ghostty_grid_ref_hyperlink_identity(
      ref, NULL, 0, &id_len, &identity);
  if (result != GHOSTTY_SUCCESS && result != GHOSTTY_OUT_OF_SPACE)
    return result;
  if (identity.tag == GHOSTTY_HYPERLINK_IDENTITY_NONE)
    return GHOSTTY_SUCCESS;
  if (identity.tag != GHOSTTY_HYPERLINK_IDENTITY_EXPLICIT &&
      identity.tag != GHOSTTY_HYPERLINK_IDENTITY_IMPLICIT)
    return GHOSTTY_INVALID_VALUE;
  if (identity.tag == GHOSTTY_HYPERLINK_IDENTITY_EXPLICIT && id_len != 0) {
    if (!eg_buffer_reserve(&state->hyperlink_id, id_len))
      return GHOSTTY_OUT_OF_MEMORY;
    result = ghostty_grid_ref_hyperlink_identity(
        ref, state->hyperlink_id.ptr, state->hyperlink_id.cap, &id_len,
        &identity);
    if (result != GHOSTTY_SUCCESS) return result;
  }
  identity_fn(
      userdata, row, column, span, (uint8_t)identity.tag,
      identity.tag == GHOSTTY_HYPERLINK_IDENTITY_EXPLICIT
          ? state->hyperlink_id.ptr
          : NULL,
      identity.tag == GHOSTTY_HYPERLINK_IDENTITY_EXPLICIT ? id_len : 0,
      identity.implicit_token);
  return GHOSTTY_SUCCESS;
}

int eg_terminal_screen_hyperlink_identities(
    EgTerminal* state,
    uint8_t screen,
    EgHyperlinkIdentityFn identity_fn,
    void* userdata) {
  if (state == NULL || identity_fn == NULL || screen > 1) return -1;
  GhosttyTerminalScreenState screen_state =
      GHOSTTY_INIT_SIZED(GhosttyTerminalScreenState);
  GhosttyResult result = ghostty_terminal_screen_get(
      state->terminal, (GhosttyTerminalScreen)screen, &screen_state);
  if (result == GHOSTTY_NO_VALUE) return 0;
  if (result != GHOSTTY_SUCCESS) return -1;
  GhosttyTerminalScreenRowIterator iterator = NULL;
  result = ghostty_terminal_screen_row_iterator_new(
      NULL, state->terminal, (GhosttyTerminalScreen)screen, &iterator);
  if (result == GHOSTTY_NO_VALUE) return 0;
  if (result != GHOSTTY_SUCCESS) return -1;

  uint64_t row = 0;
  int status = -1;
  for (;;) {
    GhosttyGridRef row_ref = {0};
    bool has_row = false;
    result = ghostty_terminal_screen_row_iterator_next(
        iterator, &row_ref, &has_row);
    if (result != GHOSTTY_SUCCESS) goto identity_cleanup;
    if (!has_row) break;
    if (row > UINT32_MAX) goto identity_cleanup;
    for (uint16_t column = 0; column < screen_state.cols; column++) {
      GhosttyGridRef ref = row_ref;
      ref.x = column;
      GhosttyCell cell = 0;
      result = ghostty_grid_ref_cell(&ref, &cell);
      if (result != GHOSTTY_SUCCESS) goto identity_cleanup;
      bool has_hyperlink = false;
      result = ghostty_cell_get(
          cell, GHOSTTY_CELL_DATA_HAS_HYPERLINK, &has_hyperlink);
      if (result != GHOSTTY_SUCCESS) goto identity_cleanup;
      if (!has_hyperlink) continue;
      GhosttyCellWide wide = GHOSTTY_CELL_WIDE_NARROW;
      result = ghostty_cell_get(cell, GHOSTTY_CELL_DATA_WIDE, &wide);
      if (result != GHOSTTY_SUCCESS) goto identity_cleanup;
      if (wide == GHOSTTY_CELL_WIDE_SPACER_TAIL ||
          wide == GHOSTTY_CELL_WIDE_SPACER_HEAD)
        continue;
      const uint16_t span = wide == GHOSTTY_CELL_WIDE_WIDE ? 2 : 1;
      result = eg_emit_hyperlink_identity(
          state, &ref, (uint32_t)row, column, span, identity_fn, userdata);
      if (result != GHOSTTY_SUCCESS) goto identity_cleanup;
    }
    row += 1;
  }
  if (row != screen_state.total_rows) goto identity_cleanup;
  status = 1;

identity_cleanup:
  ghostty_terminal_screen_row_iterator_free(iterator);
  return status;
}

int eg_terminal_screen_cursor_hyperlink(
    EgTerminal* state,
    uint8_t screen,
    EgCursorHyperlinkFn hyperlink_fn,
    void* userdata) {
  if (state == NULL || hyperlink_fn == NULL || screen > 1) return -1;
  GhosttyHyperlinkIdentity identity =
      GHOSTTY_INIT_SIZED(GhosttyHyperlinkIdentity);
  size_t uri_len = 0;
  size_t id_len = 0;
  GhosttyResult result = ghostty_terminal_screen_cursor_hyperlink(
      state->terminal, (GhosttyTerminalScreen)screen,
      NULL, 0, &uri_len, NULL, 0, &id_len, &identity);
  if (result == GHOSTTY_NO_VALUE) return 0;
  if (result != GHOSTTY_SUCCESS && result != GHOSTTY_OUT_OF_SPACE) return -1;
  if (identity.tag != GHOSTTY_HYPERLINK_IDENTITY_EXPLICIT &&
      identity.tag != GHOSTTY_HYPERLINK_IDENTITY_IMPLICIT)
    return -1;
  if (!eg_buffer_reserve(&state->hyperlink_uri, uri_len) ||
      !eg_buffer_reserve(&state->hyperlink_id, id_len))
    return -1;
  result = ghostty_terminal_screen_cursor_hyperlink(
      state->terminal, (GhosttyTerminalScreen)screen,
      state->hyperlink_uri.ptr, state->hyperlink_uri.cap, &uri_len,
      state->hyperlink_id.ptr, state->hyperlink_id.cap, &id_len, &identity);
  if (result != GHOSTTY_SUCCESS) return -1;
  hyperlink_fn(
      userdata, state->hyperlink_uri.ptr, uri_len, (uint8_t)identity.tag,
      identity.tag == GHOSTTY_HYPERLINK_IDENTITY_EXPLICIT
          ? state->hyperlink_id.ptr
          : NULL,
      identity.tag == GHOSTTY_HYPERLINK_IDENTITY_EXPLICIT ? id_len : 0,
      identity.implicit_token);
  return 1;
}
