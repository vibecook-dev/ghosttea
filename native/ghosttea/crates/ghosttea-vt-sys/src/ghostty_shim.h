#ifndef GHOSTTEA_GHOSTTY_SHIM_H
#define GHOSTTEA_GHOSTTY_SHIM_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

typedef struct EgTerminal EgTerminal;
typedef struct EgTrackedSelection EgTrackedSelection;

enum {
  EG_EFFECT_BELL = 1 << 0,
  EG_EFFECT_TITLE = 1 << 1,
  EG_EFFECT_PWD = 1 << 2,
  EG_EFFECT_CLIPBOARD = 1 << 3,
};

typedef struct {
  uint16_t cols;
  uint16_t rows;
  uint16_t cursor_x;
  uint16_t cursor_y;
  uint8_t cursor_visible;
  uint8_t cursor_style;
  uint8_t cursor_blinking;
  uint8_t full_dirty;
  uint16_t dirty_count;
  uint32_t effects;
} EgSnapshotMeta;

typedef void (*EgRowFn)(void* userdata,
                        uint32_t row,
                        const uint8_t* text,
                        size_t text_len,
                        bool dirty,
                        bool wrap,
                        bool wrap_continuation,
                        uint8_t semantic_prompt);

typedef struct {
  uint8_t flags;
  uint8_t fg_kind;
  uint8_t fg_palette;
  uint8_t fg_r;
  uint8_t fg_g;
  uint8_t fg_b;
  uint8_t bg_kind;
  uint8_t bg_palette;
  uint8_t bg_r;
  uint8_t bg_g;
  uint8_t bg_b;
} EgCellStyle;

typedef void (*EgCellFn)(void* userdata,
                         uint32_t row,
                         uint16_t column,
                         uint16_t cell_span,
                         const uint8_t* text,
                         size_t text_len,
                         const EgCellStyle* style);

enum {
  EG_HYPERLINK_NONE = 0,
  EG_HYPERLINK_EXPLICIT = 1,
  EG_HYPERLINK_IMPLICIT = 2,
};

typedef void (*EgHyperlinkUriFn)(void* userdata,
                                 uint32_t row,
                                 uint16_t column,
                                 uint16_t cell_span,
                                 const uint8_t* uri,
                                 size_t uri_len);

typedef void (*EgHyperlinkIdentityFn)(void* userdata,
                                      uint32_t row,
                                      uint16_t column,
                                      uint16_t cell_span,
                                      uint8_t identity_kind,
                                      const uint8_t* explicit_id,
                                      size_t explicit_id_len,
                                      uint64_t implicit_token);

typedef void (*EgCursorHyperlinkFn)(void* userdata,
                                    const uint8_t* uri,
                                    size_t uri_len,
                                    uint8_t identity_kind,
                                    const uint8_t* explicit_id,
                                    size_t explicit_id_len,
                                    uint64_t implicit_token);

typedef struct {
  uint8_t kind;
  uint8_t palette;
  uint8_t r;
  uint8_t g;
  uint8_t b;
} EgStyleColor;

typedef struct {
  uint16_t flags;
  int32_t underline;
  EgStyleColor foreground;
  EgStyleColor background;
  EgStyleColor underline_color;
} EgTerminalStyle;

typedef struct {
  uint8_t g0;
  uint8_t g1;
  uint8_t g2;
  uint8_t g3;
  uint8_t gl;
  uint8_t gr;
  uint8_t single_shift;
} EgCharsetState;

typedef struct {
  uint16_t x;
  uint16_t y;
  EgTerminalStyle style;
  bool protected_cell;
  bool pending_wrap;
  bool origin;
  EgCharsetState charset;
} EgSavedCursor;

typedef struct {
  uint16_t cols;
  uint16_t rows;
  uint64_t total_rows;
  uint64_t scrollback_rows;
  uint16_t cursor_x;
  uint16_t cursor_y;
  uint8_t cursor_visual_style;
  EgTerminalStyle cursor_style;
  bool cursor_protected;
  bool cursor_pending_wrap;
  EgCharsetState charset;
  uint8_t kitty_keyboard_flags;
  uint64_t viewport_offset;
  uint8_t cursor_semantic_content;
  bool cursor_semantic_content_clear_eol;
  uint64_t hyperlink_implicit_id;
  uint8_t protected_mode;
  uint8_t kitty_keyboard_stack[8];
  uint8_t kitty_keyboard_index;
  bool semantic_prompt_seen;
  uint8_t semantic_prompt_click;
} EgScreenMeta;

typedef void (*EgScreenCellFn)(void* userdata,
                               uint32_t row,
                               uint16_t column,
                               uint16_t cell_span,
                               const uint8_t* text,
                               size_t text_len,
                               const EgTerminalStyle* style,
                               bool protected_cell,
                               uint8_t semantic_content);

typedef struct {
  uint64_t total;
  uint64_t offset;
  uint64_t len;
} EgScrollbar;

typedef struct {
  uint16_t start_column;
  uint32_t start_row;
  uint16_t end_column;
  uint32_t end_row;
} EgSelection;

EgTerminal* eg_terminal_new(uint16_t cols, uint16_t rows, size_t max_scrollback);
void eg_terminal_free(EgTerminal* terminal);
void eg_terminal_write(EgTerminal* terminal, const uint8_t* data, size_t len);
int eg_terminal_resize(EgTerminal* terminal, uint16_t cols, uint16_t rows);
int eg_terminal_set_colors(EgTerminal* terminal,
                           uint8_t fg_r, uint8_t fg_g, uint8_t fg_b,
                           uint8_t bg_r, uint8_t bg_g, uint8_t bg_b,
                           uint8_t cursor_r, uint8_t cursor_g, uint8_t cursor_b);
int eg_terminal_set_palette(EgTerminal* terminal,
                            const uint8_t* indices,
                            const uint8_t* colors,
                            size_t len);
int eg_default_palette(uint8_t* colors, size_t len);
void eg_terminal_scroll(EgTerminal* terminal, intptr_t rows);
void eg_terminal_scroll_to(EgTerminal* terminal, size_t row);
int eg_terminal_compress_scrollback_full(EgTerminal* terminal);
bool eg_terminal_scrollbar(EgTerminal* terminal, EgScrollbar* scrollbar);
bool eg_terminal_mouse_tracking(EgTerminal* terminal);
bool eg_terminal_alternate_scroll(EgTerminal* terminal);
int eg_terminal_mode_get_raw(EgTerminal* terminal,
                             uint16_t value,
                             bool ansi,
                             bool* out_value);
int eg_terminal_pending_wrap(EgTerminal* terminal, bool* out_value);
EgTrackedSelection* eg_terminal_track_selection(EgTerminal* terminal,
                                                uint16_t start_column,
                                                uint32_t start_row,
                                                uint16_t end_column,
                                                uint32_t end_row,
                                                bool select_all);
void eg_tracked_selection_free(EgTrackedSelection* selection);
bool eg_terminal_tracked_selection_points(
    EgTerminal* terminal,
    const EgTrackedSelection* selection,
    EgSelection* points);
size_t eg_terminal_tracked_selection_text(
    EgTerminal* terminal,
    const EgTrackedSelection* selection,
    uint8_t* out,
    size_t cap);
size_t eg_terminal_selection_text(EgTerminal* terminal,
                                  uint16_t start_column,
                                  uint32_t start_row,
                                  uint16_t end_column,
                                  uint32_t end_row,
                                  bool select_all,
                                  uint8_t* out,
                                  size_t cap);
int eg_terminal_snapshot(EgTerminal* terminal,
                         EgSnapshotMeta* meta,
                         EgRowFn row_fn,
                         EgCellFn cell_fn,
                         EgHyperlinkUriFn hyperlink_fn,
                         void* userdata);
size_t eg_terminal_recovery_fragment(EgTerminal* terminal,
                                     uint8_t* out,
                                     size_t cap);
size_t eg_terminal_recovery_state(EgTerminal* terminal,
                                  uint8_t* out,
                                  size_t cap);
int eg_terminal_saved_cursor(EgTerminal* terminal,
                             uint8_t screen,
                             EgSavedCursor* out_cursor);
int eg_terminal_screen_snapshot(EgTerminal* terminal,
                                uint8_t screen,
                                EgScreenMeta* meta,
                                EgRowFn row_fn,
                                EgScreenCellFn cell_fn,
                                EgHyperlinkUriFn hyperlink_fn,
                                void* userdata);
int eg_terminal_screen_hyperlink_identities(
    EgTerminal* terminal,
    uint8_t screen,
    EgHyperlinkIdentityFn identity_fn,
    void* userdata);
int eg_terminal_screen_cursor_hyperlink(
    EgTerminal* terminal,
    uint8_t screen,
    EgCursorHyperlinkFn hyperlink_fn,
    void* userdata);
size_t eg_terminal_take_response(EgTerminal* terminal, uint8_t* out, size_t cap);
size_t eg_terminal_title(EgTerminal* terminal, uint8_t* out, size_t cap);
size_t eg_terminal_pwd(EgTerminal* terminal, uint8_t* out, size_t cap);
size_t eg_terminal_take_clipboard(EgTerminal* terminal, uint8_t* out, size_t cap);
int eg_terminal_encode_key(EgTerminal* terminal,
                           const uint8_t* code,
                           size_t code_len,
                           const uint8_t* text,
                           size_t text_len,
                           uint32_t unshifted_codepoint,
                           uint16_t mods,
                           bool option_as_alt,
                           uint8_t action,
                           uint8_t* out,
                           size_t cap,
                           size_t* out_len);
int eg_terminal_encode_mouse(EgTerminal* terminal,
                             uint8_t action,
                             uint8_t button,
                             uint16_t mods,
                             float x,
                             float y,
                             uint32_t screen_width,
                             uint32_t screen_height,
                             uint32_t cell_width,
                             uint32_t cell_height,
                             uint32_t padding_left,
                             uint32_t padding_top,
                             uint8_t* out,
                             size_t cap,
                             size_t* out_len);
int eg_terminal_encode_focus(EgTerminal* terminal,
                             bool focused,
                             uint8_t* out,
                             size_t cap,
                             size_t* out_len);
int eg_terminal_encode_paste(EgTerminal* terminal,
                             const uint8_t* data,
                             size_t data_len,
                             uint8_t* out,
                             size_t cap,
                             size_t* out_len);

#endif
