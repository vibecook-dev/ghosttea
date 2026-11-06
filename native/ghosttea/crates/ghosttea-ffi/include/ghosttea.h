#ifndef GHOSTTEA_H
#define GHOSTTEA_H

#include <stdbool.h>
#include <stddef.h>
#include <stdint.h>

#ifdef __cplusplus
extern "C" {
#endif

#define GHOSTTEA_ABI_VERSION 1u

typedef struct ghosttea_runtime ghosttea_runtime_t;
typedef struct ghosttea_terminal ghosttea_terminal_t;
typedef struct ghosttea_replica ghosttea_replica_t;
typedef struct ghosttea_config_manager ghosttea_config_manager_t;

typedef enum ghosttea_status {
  GHOSTTEA_STATUS_OK = 0,
  GHOSTTEA_STATUS_INVALID_ARGUMENT = 1,
  GHOSTTEA_STATUS_INVALID_STATE = 2,
  GHOSTTEA_STATUS_INTERNAL = 3,
  GHOSTTEA_STATUS_PANIC = 4,
} ghosttea_status_t;

typedef enum ghosttea_render_request {
  GHOSTTEA_RENDER_NONE = 0,
  GHOSTTEA_RENDER_DAMAGE = 1,
  GHOSTTEA_RENDER_FULL = 2,
} ghosttea_render_request_t;

typedef enum ghosttea_font_role {
  GHOSTTEA_FONT_REGULAR = 0,
  GHOSTTEA_FONT_BOLD = 1,
  GHOSTTEA_FONT_ITALIC = 2,
  GHOSTTEA_FONT_BOLD_ITALIC = 3,
  GHOSTTEA_FONT_FALLBACK = 4,
  GHOSTTEA_FONT_FALLBACK_TEXT = 5,
  GHOSTTEA_FONT_FALLBACK_EMOJI = 6,
} ghosttea_font_role_t;

typedef enum ghosttea_effect_kind {
  GHOSTTEA_EFFECT_WRITE_TO_TRANSPORT = 1,
  GHOSTTEA_EFFECT_METADATA_CHANGED_JSON = 2,
  GHOSTTEA_EFFECT_BELL = 3,
  GHOSTTEA_EFFECT_CLIPBOARD_WRITE = 4,
  GHOSTTEA_EFFECT_FRAME_READY = 5,
  GHOSTTEA_EFFECT_LOGICAL_SNAPSHOT_JSON = 6,
} ghosttea_effect_kind_t;

typedef struct ghosttea_bytes_view {
  const uint8_t *data;
  size_t len;
} ghosttea_bytes_view_t;

typedef struct ghosttea_owned_bytes {
  uint8_t *data;
  size_t len;
  size_t capacity;
} ghosttea_owned_bytes_t;

typedef struct ghosttea_font {
  ghosttea_bytes_view_t data;
  uint32_t face_index;
  uint32_t role;
} ghosttea_font_t;

typedef struct ghosttea_palette_entry {
  uint8_t index;
  uint8_t red;
  uint8_t green;
  uint8_t blue;
} ghosttea_palette_entry_t;

typedef struct ghosttea_runtime_config {
  uint32_t abi_version;
  uint32_t struct_size;
  const ghosttea_font_t *fonts;
  size_t font_count;
  float font_size_px;
  float cell_width_px;
  float line_height_px;
  float baseline_px;
  float raster_scale;
} ghosttea_runtime_config_t;

typedef struct ghosttea_terminal_config {
  uint32_t abi_version;
  uint32_t struct_size;
  uint64_t session_handle;
  uint64_t session_epoch;
  uint64_t layout_epoch;
  uint64_t scrollback_bytes;
  uint16_t cols;
  uint16_t rows;
  uint32_t reserved;
} ghosttea_terminal_config_t;

typedef struct ghosttea_effect {
  uint32_t sequence;
  uint32_t kind;
  uint32_t payload_offset;
  uint32_t payload_length;
} ghosttea_effect_t;

/* storage owns the complete aligned arena. Payload offsets are relative to
 * storage.data. Only ghosttea_update_destroy may release this storage. */
typedef struct ghosttea_update {
  ghosttea_owned_bytes_t storage;
  const ghosttea_effect_t *effects;
  size_t effect_count;
} ghosttea_update_t;

/* Latest completed coarse text-engine lock interval for one serialized model.
 * sequence advances only when an operation acquires the shared text engine. */
typedef struct ghosttea_text_engine_performance {
  uint64_t sequence;
  uint64_t acquisition_count;
  uint64_t wait_nanoseconds;
  uint64_t hold_nanoseconds;
} ghosttea_text_engine_performance_t;

/* Bits of ghosttea_key_event_t.flags. Zero keeps Option acting as Alt; a bit
 * not defined here is GHOSTTEA_STATUS_INVALID_ARGUMENT. */
typedef enum ghosttea_key_flag {
  /* macOS Option types the keyboard layout's characters instead of acting as
   * Alt, for this one key: Ghostty's macos-option-as-alt = false. */
  GHOSTTEA_KEY_FLAG_OPTION_TYPES_TEXT = 1 << 0,
} ghosttea_key_flag_t;

typedef struct ghosttea_key_event {
  uint32_t abi_version;
  uint32_t struct_size;
  ghosttea_bytes_view_t code_utf8;
  ghosttea_bytes_view_t text_utf8;
  uint32_t unshifted_codepoint;
  uint16_t modifiers;
  uint8_t action;
  uint8_t flags; /* ghosttea_key_flag_t bits */
} ghosttea_key_event_t;

typedef struct ghosttea_mouse_event {
  uint32_t abi_version;
  uint32_t struct_size;
  float x;
  float y;
  uint32_t screen_width;
  uint32_t screen_height;
  uint32_t cell_width;
  uint32_t cell_height;
  uint32_t padding_left;
  uint32_t padding_top;
  uint16_t modifiers;
  uint8_t action;
  uint8_t button;
} ghosttea_mouse_event_t;

uint32_t ghosttea_abi_version(void);
const char *ghosttea_last_error_message(void);

/* Resolves Ghostty's standard config sources followed by an optional
 * Ghosttea-owned overlay and returns a ghosttea-config/v1 JSON snapshot.
 * Pass an empty byte view for no overlay. */
ghosttea_status_t ghosttea_config_load_json(
    ghosttea_bytes_view_t overlay_path_utf8, bool load_default_files,
    ghosttea_owned_bytes_t *out_json);

/* Retained configuration/document API. Only the explicit overlay is editable;
 * imported Ghostty sources and includes remain read-only. All JSON buffers are
 * released with ghosttea_owned_bytes_free. */
ghosttea_status_t ghosttea_config_manager_create(
    ghosttea_bytes_view_t overlay_path_utf8, bool load_default_files,
    ghosttea_config_manager_t **out_manager);
void ghosttea_config_manager_destroy(ghosttea_config_manager_t *manager);
ghosttea_status_t ghosttea_config_manager_snapshot_json(
    ghosttea_config_manager_t *manager, ghosttea_owned_bytes_t *out_json);
ghosttea_status_t ghosttea_config_manager_reload_json(
    ghosttea_config_manager_t *manager, ghosttea_owned_bytes_t *out_json);
ghosttea_status_t ghosttea_config_manager_document_json(
    ghosttea_config_manager_t *manager, ghosttea_owned_bytes_t *out_json);
ghosttea_status_t ghosttea_config_manager_validate_document_json(
    ghosttea_config_manager_t *manager, ghosttea_bytes_view_t contents_utf8,
    ghosttea_owned_bytes_t *out_json);
ghosttea_status_t ghosttea_config_manager_replace_document_json(
    ghosttea_config_manager_t *manager,
    ghosttea_bytes_view_t expected_revision_utf8,
    ghosttea_bytes_view_t contents_utf8, ghosttea_owned_bytes_t *out_json);

ghosttea_status_t ghosttea_runtime_create(const ghosttea_runtime_config_t *config,
                                          ghosttea_runtime_t **out_runtime);
void ghosttea_runtime_destroy(ghosttea_runtime_t *runtime);
bool ghosttea_runtime_is_poisoned(const ghosttea_runtime_t *runtime);

ghosttea_status_t ghosttea_terminal_create(ghosttea_runtime_t *runtime,
                                           const ghosttea_terminal_config_t *config,
                                           ghosttea_terminal_t **out_terminal);
void ghosttea_terminal_destroy(ghosttea_terminal_t *terminal);
bool ghosttea_terminal_is_poisoned(const ghosttea_terminal_t *terminal);
ghosttea_status_t ghosttea_terminal_text_engine_performance(
    ghosttea_terminal_t *terminal,
    ghosttea_text_engine_performance_t *out_performance);

/* A replica consumes logical snapshot/patch JSON from a remote authoritative
 * Ghosttea session and renders local TRF1 with this runtime's fonts. */
ghosttea_status_t ghosttea_replica_create(ghosttea_runtime_t *runtime,
                                          uint64_t session_handle,
                                          ghosttea_replica_t **out_replica);
void ghosttea_replica_destroy(ghosttea_replica_t *replica);
bool ghosttea_replica_is_poisoned(const ghosttea_replica_t *replica);
ghosttea_status_t ghosttea_replica_text_engine_performance(
    ghosttea_replica_t *replica,
    ghosttea_text_engine_performance_t *out_performance);
ghosttea_status_t ghosttea_replica_publish_snapshot_json(
    ghosttea_replica_t *replica, ghosttea_bytes_view_t snapshot_json,
    ghosttea_update_t *out_update);
ghosttea_status_t ghosttea_replica_publish_patch_json(
    ghosttea_replica_t *replica, ghosttea_bytes_view_t patch_json,
    ghosttea_update_t *out_update);
ghosttea_status_t ghosttea_replica_publish_selection(
    ghosttea_replica_t *replica, bool has_selection,
    uint16_t anchor_column, uint32_t anchor_row,
    uint16_t focus_column, uint32_t focus_row,
    ghosttea_update_t *out_update);
/* Atomically re-resolves retained logical state with a sparse device palette.
 * Pass NULL for runtime to retain current text metrics. A non-NULL runtime
 * performs one full local re-shape without resetting logical patch state. */
ghosttea_status_t ghosttea_replica_reconfigure(
    ghosttea_replica_t *replica, ghosttea_runtime_t *runtime,
    const ghosttea_palette_entry_t *palette, size_t palette_count,
    ghosttea_update_t *out_update);
ghosttea_status_t ghosttea_replica_refresh(ghosttea_replica_t *replica,
                                           ghosttea_update_t *out_update);

ghosttea_status_t ghosttea_terminal_feed(ghosttea_terminal_t *terminal,
                                         ghosttea_bytes_view_t bytes,
                                         uint32_t render_request,
                                         ghosttea_update_t *out_update);
ghosttea_status_t ghosttea_terminal_refresh(ghosttea_terminal_t *terminal,
                                            uint32_t render_request,
                                            ghosttea_update_t *out_update);
ghosttea_status_t ghosttea_terminal_resize(ghosttea_terminal_t *terminal,
                                           uint16_t cols,
                                           uint16_t rows,
                                           uint64_t layout_epoch,
                                           uint32_t render_request,
                                           ghosttea_update_t *out_update);
ghosttea_status_t ghosttea_terminal_set_colors(ghosttea_terminal_t *terminal,
                                               const uint8_t foreground[3],
                                               const uint8_t background[3],
                                               const uint8_t cursor[3],
                                               uint32_t render_request,
                                               ghosttea_update_t *out_update);
ghosttea_status_t ghosttea_terminal_set_appearance(
    ghosttea_terminal_t *terminal, const uint8_t foreground[3],
    const uint8_t background[3], const uint8_t cursor[3],
    const uint8_t *palette_indices, const uint8_t *palette_colors_rgb,
    size_t palette_count, uint32_t render_request,
    ghosttea_update_t *out_update);
ghosttea_status_t ghosttea_terminal_scroll(ghosttea_terminal_t *terminal,
                                           int64_t rows,
                                           uint32_t render_request,
                                           ghosttea_update_t *out_update);
ghosttea_status_t ghosttea_terminal_scroll_to(ghosttea_terminal_t *terminal,
                                              uint64_t row,
                                              uint32_t render_request,
                                              ghosttea_update_t *out_update);
/* Synchronously compresses eligible scrollback without changing logical
 * contents. out_supported is false only when the linked Ghostty build does not
 * provide compression. */
ghosttea_status_t ghosttea_terminal_compress_scrollback_full(
    ghosttea_terminal_t *terminal, bool *out_supported);

ghosttea_status_t ghosttea_terminal_encode_paste(ghosttea_terminal_t *terminal,
                                                 ghosttea_bytes_view_t text_utf8,
                                                 ghosttea_owned_bytes_t *out_bytes);
ghosttea_status_t ghosttea_terminal_encode_key(ghosttea_terminal_t *terminal,
                                               const ghosttea_key_event_t *event,
                                               ghosttea_owned_bytes_t *out_bytes);
ghosttea_status_t ghosttea_terminal_encode_mouse(ghosttea_terminal_t *terminal,
                                                 const ghosttea_mouse_event_t *event,
                                                 ghosttea_owned_bytes_t *out_bytes);
ghosttea_status_t ghosttea_terminal_encode_focus(ghosttea_terminal_t *terminal,
                                                 bool focused,
                                                 ghosttea_owned_bytes_t *out_bytes);
ghosttea_status_t ghosttea_terminal_alternate_scroll(ghosttea_terminal_t *terminal,
                                                     bool *out_enabled);

ghosttea_status_t ghosttea_terminal_selection_text(ghosttea_terminal_t *terminal,
                                                   uint16_t start_column,
                                                   uint32_t start_row,
                                                   uint16_t end_column,
                                                   uint32_t end_row,
                                                   bool select_all,
                                                   ghosttea_owned_bytes_t *out_utf8);
ghosttea_status_t ghosttea_terminal_accessibility_rows(ghosttea_terminal_t *terminal,
                                                       uint16_t start_row,
                                                       uint16_t row_count,
                                                       ghosttea_owned_bytes_t *out_json);

void ghosttea_owned_bytes_free(ghosttea_owned_bytes_t bytes);
void ghosttea_update_destroy(ghosttea_update_t update);

/* Runtime handles may be shared, but each terminal or replica must be
 * externally serialized. A runtime must outlive its terminals and replicas. A
 * panic poisons the affected terminal/replica; rendering panics also poison its
 * shared runtime. After a panic, only poison queries, last-error inspection,
 * and destroy are legal. */

#ifdef __cplusplus
}
#endif

#endif
