#include "ghostty_shim_internal.h"

#include <stdint.h>

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

// Every piece of terminal state a recovery stream restores. The extras are
// named one by one rather than taken as GHOSTTY_FORMATTER_EXTRAS_ALL, so an
// extra that a later libghostty adds does not join the stream unreviewed.
static const GhosttyFormatterExtras eg_recovery_extras =
    GHOSTTY_FORMATTER_EXTRA_PALETTE |
    GHOSTTY_FORMATTER_EXTRA_MODES |
    GHOSTTY_FORMATTER_EXTRA_SCROLLING_REGION |
    GHOSTTY_FORMATTER_EXTRA_TABSTOPS |
    GHOSTTY_FORMATTER_EXTRA_PWD |
    GHOSTTY_FORMATTER_EXTRA_KEYBOARD |
    GHOSTTY_FORMATTER_EXTRA_CURSOR |
    GHOSTTY_FORMATTER_EXTRA_STYLE |
    GHOSTTY_FORMATTER_EXTRA_HYPERLINK |
    GHOSTTY_FORMATTER_EXTRA_PROTECTION |
    GHOSTTY_FORMATTER_EXTRA_KITTY_KEYBOARD |
    GHOSTTY_FORMATTER_EXTRA_CHARSETS;

size_t eg_format_recovery(EgTerminal* state,
                          bool state_only,
                          uint8_t* out,
                          size_t cap) {
  if (state == NULL || (out == NULL && cap != 0)) return SIZE_MAX;
  GhosttyFormatter formatter = NULL;
  GhosttyResult result = state_only
      ? ghostty_formatter_terminal_state_new(NULL, &formatter, state->terminal)
      : ghostty_formatter_terminal_new(NULL, &formatter, state->terminal);
  if (result != GHOSTTY_SUCCESS) return SIZE_MAX;

  // VT output that keeps trailing blanks, so the stream fills the same rows
  // as the screen. Lines stay wrapped as they are, which is the default.
  const GhosttyFormatterFormat emit = GHOSTTY_FORMATTER_FORMAT_VT;
  const bool trim = false;
  result = ghostty_formatter_set(formatter, GHOSTTY_FORMATTER_OPT_EMIT, &emit);
  if (result == GHOSTTY_SUCCESS)
    result = ghostty_formatter_set(formatter, GHOSTTY_FORMATTER_OPT_TRIM, &trim);
  if (result == GHOSTTY_SUCCESS)
    result = ghostty_formatter_set(
        formatter, GHOSTTY_FORMATTER_OPT_EXTRAS, &eg_recovery_extras);
  size_t written = 0;
  if (result == GHOSTTY_SUCCESS)
    result = ghostty_formatter_format_buf(formatter, out, cap, &written);
  ghostty_formatter_free(formatter);
  if (result != GHOSTTY_SUCCESS && result != GHOSTTY_OUT_OF_SPACE)
    return SIZE_MAX;
  return written;
}

size_t eg_terminal_recovery_state(EgTerminal* state,
                                  uint8_t* out,
                                  size_t cap) {
  return eg_format_recovery(state, true, out, cap);
}

int eg_terminal_saved_cursor(EgTerminal* state,
                             uint8_t screen,
                             EgSavedCursor* out) {
  if (state == NULL || out == NULL || screen > 1) return -1;
  GhosttyTerminalSavedCursor cursor =
      GHOSTTY_INIT_SIZED(GhosttyTerminalSavedCursor);
  GhosttyResult result = ghostty_terminal_saved_cursor(
      state->terminal, (GhosttyTerminalScreen)screen, &cursor);
  if (result == GHOSTTY_NO_VALUE) return 0;
  if (result != GHOSTTY_SUCCESS) return -1;
  out->x = cursor.x;
  out->y = cursor.y;
  eg_terminal_style(cursor.style, &out->style);
  out->protected_cell = cursor.protected_cell;
  out->pending_wrap = cursor.pending_wrap;
  out->origin = cursor.origin;
  out->charset = eg_charset_state(cursor.charset);
  return 1;
}
