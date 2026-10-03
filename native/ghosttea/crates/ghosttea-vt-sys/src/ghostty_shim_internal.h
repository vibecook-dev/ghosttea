#ifndef GHOSTTEA_GHOSTTY_SHIM_INTERNAL_H
#define GHOSTTEA_GHOSTTY_SHIM_INTERNAL_H

#include "ghostty_shim.h"

#include <ghostty/vt.h>

typedef struct {
  uint8_t* ptr;
  size_t len;
  size_t cap;
} EgBuffer;

struct EgTerminal {
  GhosttyTerminal terminal;
  GhosttyRenderState render;
  GhosttyRenderStateRowIterator rows;
  GhosttyRenderStateRowCells cells;
  GhosttyKeyEncoder key_encoder;
  GhosttyKeyEvent key_event;
  GhosttyMouseEncoder mouse_encoder;
  GhosttyMouseEvent mouse_event;
  EgBuffer response;
  EgBuffer row;
  EgBuffer clipboard;
  EgBuffer hyperlink_uri;
  EgBuffer hyperlink_id;
  EgBuffer grapheme;
  bool mouse_pressed;
  uint32_t effects;
  // Derived from the embedder's default background; answers CSI ? 996 n and
  // drives mode-2031 reports when a theme change flips it.
  GhosttyColorScheme color_scheme;
};

bool eg_buffer_reserve(EgBuffer* buffer, size_t required);
bool eg_buffer_append(EgBuffer* buffer, const uint8_t* data, size_t len);
void eg_terminal_style(GhosttyStyle source, EgTerminalStyle* out);
int eg_emit_hyperlink_uri(EgTerminal* state,
                          const GhosttyGridRef* ref,
                          uint32_t row,
                          uint16_t column,
                          uint16_t span,
                          EgHyperlinkUriFn hyperlink_fn,
                          void* userdata);

#endif
