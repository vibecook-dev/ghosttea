use std::{env, fs, mem::size_of, path::Path, ptr, slice};

use ghosttea_core::{
    RenderRequest, TerminalEffect, TerminalModel, TerminalModelOptions, TerminalRuntime,
};
use ghosttea_ffi::*;
use ghosttea_text::{
    FontPresentation, FontResource, FontResources, RASTER_SCALE, TextEngine, TextMetrics,
};
use serde_json::Value;

fn bytes(path: &Path, name: &str) -> Vec<u8> {
    fs::read(path.join(name)).unwrap()
}

fn resources(path: &Path) -> FontResources {
    let mut fonts = FontResources::new(FontResource::new(
        "regular",
        bytes(path, "JetBrainsMonoNerdFont-Regular.ttf"),
    ));
    fonts.bold = Some(FontResource::new(
        "bold",
        bytes(path, "JetBrainsMonoNerdFont-Bold.ttf"),
    ));
    fonts.italic = Some(FontResource::new(
        "italic",
        bytes(path, "JetBrainsMonoNerdFont-Italic.ttf"),
    ));
    fonts.bold_italic = Some(FontResource::new(
        "bold-italic",
        bytes(path, "JetBrainsMonoNerdFont-BoldItalic.ttf"),
    ));
    fonts.fallbacks = vec![
        FontResource::new("emoji", bytes(path, "NotoColorEmoji.ttf"))
            .with_presentation(FontPresentation::Emoji),
        FontResource::new("symbols-math", bytes(path, "STIXTwoMath-Regular.otf"))
            .with_presentation(FontPresentation::Text),
        FontResource::new("symbols", bytes(path, "NotoSansSymbols2-Regular.ttf"))
            .with_presentation(FontPresentation::Text),
        FontResource::new("emoji-text", bytes(path, "NotoEmoji-Regular.ttf"))
            .with_presentation(FontPresentation::Text),
    ];
    fonts
}

fn direct_payloads(update: ghosttea_core::TerminalUpdate) -> Vec<(u32, Vec<u8>)> {
    update
        .into_effects()
        .into_iter()
        .map(|effect| match effect {
            TerminalEffect::WriteToTransport(bytes) => (1, bytes),
            TerminalEffect::MetadataChanged(metadata) => (
                2,
                serde_json::to_vec(&serde_json::json!({
                    "cols": metadata.cols,
                    "rows": metadata.rows,
                    "title": metadata.title,
                    "cwd": metadata.cwd,
                }))
                .unwrap(),
            ),
            TerminalEffect::Bell => (3, Vec::new()),
            TerminalEffect::ClipboardRequest(ghosttea_core::ClipboardRequest::Write(bytes)) => {
                (4, bytes)
            }
            TerminalEffect::FrameReady(bytes) => (5, bytes),
            TerminalEffect::LogicalSnapshotReady(snapshot) => {
                (6, serde_json::to_vec(&snapshot).unwrap())
            }
        })
        .collect()
}

fn ffi_payloads(update: &GhostteaUpdate) -> Vec<(u32, Vec<u8>)> {
    let effects = unsafe { slice::from_raw_parts(update.effects, update.effect_count) };
    effects
        .iter()
        .map(|effect| {
            let payload = unsafe {
                slice::from_raw_parts(
                    update.storage.data.add(effect.payload_offset as usize),
                    effect.payload_length as usize,
                )
            };
            (effect.kind, payload.to_vec())
        })
        .collect()
}

fn assert_payloads_equal(direct: &[(u32, Vec<u8>)], ffi: &[(u32, Vec<u8>)]) {
    assert_eq!(direct.len(), ffi.len());
    for ((direct_kind, direct_bytes), (ffi_kind, ffi_bytes)) in direct.iter().zip(ffi) {
        assert_eq!(direct_kind, ffi_kind);
        if matches!(direct_kind, 2 | 6) {
            assert_eq!(
                serde_json::from_slice::<Value>(direct_bytes).unwrap(),
                serde_json::from_slice::<Value>(ffi_bytes).unwrap()
            );
        } else {
            assert_eq!(direct_bytes, ffi_bytes);
        }
    }
}

#[test]
#[ignore = "requires GHOSTTEA_FONT_DIR; run through the Phase 3 parity script"]
fn ffi_matches_direct_model_and_survives_repeated_lifecycles() {
    let directory = env::var("GHOSTTEA_FONT_DIR").expect("GHOSTTEA_FONT_DIR is required");
    let directory = Path::new(&directory);
    let input =
        b"phase3\r\n\x1b]0;ffi-title\x07\x1b[6nemoji: \xF0\x9F\x98\x80 symbol: \xE2\x8F\xB8";

    let direct_runtime = std::sync::Arc::new(TerminalRuntime::new(
        TextEngine::from_fonts(resources(directory), TextMetrics::default(), RASTER_SCALE).unwrap(),
    ));
    let mut direct = TerminalModel::new(
        direct_runtime,
        TerminalModelOptions {
            session_handle: 42,
            session_epoch: 7,
            layout_epoch: 3,
            cols: 80,
            rows: 24,
            scrollback_bytes: 1_000_000,
        },
    )
    .unwrap();
    let expected = direct_payloads(direct.feed(input, RenderRequest::Full).unwrap());

    let font_bytes = [
        (bytes(directory, "JetBrainsMonoNerdFont-Regular.ttf"), 0),
        (bytes(directory, "JetBrainsMonoNerdFont-Bold.ttf"), 1),
        (bytes(directory, "JetBrainsMonoNerdFont-Italic.ttf"), 2),
        (bytes(directory, "JetBrainsMonoNerdFont-BoldItalic.ttf"), 3),
        (bytes(directory, "NotoColorEmoji.ttf"), 6),
        (bytes(directory, "STIXTwoMath-Regular.otf"), 5),
        (bytes(directory, "NotoSansSymbols2-Regular.ttf"), 5),
        (bytes(directory, "NotoEmoji-Regular.ttf"), 5),
    ];
    let fonts = font_bytes
        .iter()
        .map(|(data, role)| GhostteaFont {
            data: GhostteaBytesView {
                data: data.as_ptr(),
                len: data.len(),
            },
            face_index: 0,
            role: *role,
        })
        .collect::<Vec<_>>();
    let runtime_config = GhostteaRuntimeConfig {
        abi_version: GHOSTTEA_ABI_VERSION,
        struct_size: size_of::<GhostteaRuntimeConfig>() as u32,
        fonts: fonts.as_ptr(),
        font_count: fonts.len(),
        font_size_px: 13.0,
        cell_width_px: 7.83,
        line_height_px: 19.0,
        baseline_px: 14.0,
        raster_scale: 2.0,
    };

    for _ in 0..100 {
        let mut runtime = ptr::null_mut();
        assert_eq!(
            ghosttea_runtime_create(&runtime_config, &mut runtime),
            GHOSTTEA_STATUS_OK
        );
        let terminal_config = GhostteaTerminalConfig {
            abi_version: GHOSTTEA_ABI_VERSION,
            struct_size: size_of::<GhostteaTerminalConfig>() as u32,
            session_handle: 42,
            session_epoch: 7,
            layout_epoch: 3,
            scrollback_bytes: 1_000_000,
            cols: 80,
            rows: 24,
            reserved: 0,
        };
        let mut terminal = ptr::null_mut();
        assert_eq!(
            ghosttea_terminal_create(runtime, &terminal_config, &mut terminal),
            GHOSTTEA_STATUS_OK
        );
        let mut update = GhostteaUpdate {
            storage: GhostteaOwnedBytes {
                data: ptr::null_mut(),
                len: 0,
                capacity: 0,
            },
            effects: ptr::null(),
            effect_count: 0,
        };
        assert_eq!(
            ghosttea_terminal_feed(
                terminal,
                GhostteaBytesView {
                    data: input.as_ptr(),
                    len: input.len(),
                },
                2,
                &mut update,
            ),
            GHOSTTEA_STATUS_OK
        );
        assert_payloads_equal(&expected, &ffi_payloads(&update));
        ghosttea_update_destroy(update);

        let mut accessibility = GhostteaOwnedBytes {
            data: ptr::null_mut(),
            len: 0,
            capacity: 0,
        };
        assert_eq!(
            ghosttea_terminal_accessibility_rows(terminal, 0, 2, &mut accessibility),
            GHOSTTEA_STATUS_OK
        );
        let rows: Value = serde_json::from_slice(unsafe {
            slice::from_raw_parts(accessibility.data, accessibility.len)
        })
        .unwrap();
        assert_eq!(rows[0]["text"], "phase3");
        ghosttea_owned_bytes_free(accessibility);

        ghosttea_terminal_destroy(terminal);
        ghosttea_runtime_destroy(runtime);
    }
}

/// The C ABI's Option flag reaches the encoder the model path uses, and the
/// two agree byte for byte under either policy.
///
/// German Option+L: the layout types `@` and the key's own character is `l`.
/// With no flag Option acts as Alt and the key is Alt+L, `ESC l`; with
/// `GHOSTTEA_KEY_FLAG_OPTION_TYPES_TEXT` Option types the `@`. The bytes are
/// Ghostty's at the pinned 83fb956, src/input/key_encode.zig: ESC before
/// one-byte text (:577-581), and the text as it stands once no binding
/// modifier is left (:560, :549).
#[test]
#[ignore = "requires GHOSTTEA_FONT_DIR; run through the Phase 3 parity script"]
fn ffi_key_flags_match_the_model_option_policy() {
    let directory = env::var("GHOSTTEA_FONT_DIR").expect("GHOSTTEA_FONT_DIR is required");
    let regular = bytes(Path::new(&directory), "JetBrainsMonoNerdFont-Regular.ttf");

    let direct_fonts = FontResources::new(FontResource::new("regular", regular.clone()));
    let direct_runtime = std::sync::Arc::new(TerminalRuntime::new(
        TextEngine::from_fonts(direct_fonts, TextMetrics::default(), RASTER_SCALE).unwrap(),
    ));
    let mut direct = TerminalModel::new(
        direct_runtime,
        TerminalModelOptions {
            session_handle: 42,
            session_epoch: 7,
            layout_epoch: 3,
            cols: 80,
            rows: 24,
            scrollback_bytes: 1_000_000,
        },
    )
    .unwrap();
    let alt = direct
        .encode_key("KeyL", "@", 'l'.into(), 1 << 2, 1, true)
        .unwrap();
    let typed = direct
        .encode_key("KeyL", "@", 'l'.into(), 1 << 2, 1, false)
        .unwrap();
    assert_eq!(alt, b"\x1bl", "no flag: Option acts as Alt");
    assert_eq!(typed, b"@", "the flag: Option types the layout's text");

    let ffi_font = GhostteaFont {
        data: GhostteaBytesView {
            data: regular.as_ptr(),
            len: regular.len(),
        },
        face_index: 0,
        role: 0,
    };
    let runtime_config = GhostteaRuntimeConfig {
        abi_version: GHOSTTEA_ABI_VERSION,
        struct_size: size_of::<GhostteaRuntimeConfig>() as u32,
        fonts: &ffi_font,
        font_count: 1,
        font_size_px: 13.0,
        cell_width_px: 7.83,
        line_height_px: 19.0,
        baseline_px: 14.0,
        raster_scale: 2.0,
    };
    let mut runtime = ptr::null_mut();
    assert_eq!(
        ghosttea_runtime_create(&runtime_config, &mut runtime),
        GHOSTTEA_STATUS_OK
    );
    let terminal_config = GhostteaTerminalConfig {
        abi_version: GHOSTTEA_ABI_VERSION,
        struct_size: size_of::<GhostteaTerminalConfig>() as u32,
        session_handle: 42,
        session_epoch: 7,
        layout_epoch: 3,
        scrollback_bytes: 1_000_000,
        cols: 80,
        rows: 24,
        reserved: 0,
    };
    let mut terminal = ptr::null_mut();
    assert_eq!(
        ghosttea_terminal_create(runtime, &terminal_config, &mut terminal),
        GHOSTTEA_STATUS_OK
    );
    let ffi = |flags: u8| {
        let event = GhostteaKeyEvent {
            abi_version: GHOSTTEA_ABI_VERSION,
            struct_size: size_of::<GhostteaKeyEvent>() as u32,
            code_utf8: GhostteaBytesView {
                data: "KeyL".as_ptr(),
                len: 4,
            },
            text_utf8: GhostteaBytesView {
                data: "@".as_ptr(),
                len: 1,
            },
            unshifted_codepoint: u32::from('l'),
            modifiers: 1 << 2,
            action: 1,
            flags,
        };
        let mut bytes = GhostteaOwnedBytes {
            data: ptr::null_mut(),
            len: 0,
            capacity: 0,
        };
        assert_eq!(
            ghosttea_terminal_encode_key(terminal, &event, &mut bytes),
            GHOSTTEA_STATUS_OK
        );
        let encoded = unsafe { slice::from_raw_parts(bytes.data, bytes.len) }.to_vec();
        ghosttea_owned_bytes_free(bytes);
        encoded
    };
    assert_eq!(ffi(0), alt);
    assert_eq!(ffi(GHOSTTEA_KEY_FLAG_OPTION_TYPES_TEXT), typed);

    ghosttea_terminal_destroy(terminal);
    ghosttea_runtime_destroy(runtime);
}
