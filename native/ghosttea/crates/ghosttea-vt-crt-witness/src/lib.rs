//! Test-only witness for the C runtime that ghosttea-vt-sys's Windows library is
//! built for.
//!
//! On MSVC every object compiled against the C++ standard headers records the C
//! runtime it expects, and the linker refuses a mix: LNK2038, "mismatch detected
//! for 'RuntimeLibrary'". A Rust target links the dynamic runtime (`/MD`) unless
//! it enables `crt-static`, and `cc` builds a consumer's C++ for the same one, so
//! a consumer that links any C++ dependency beside the Ghostty VT library needs
//! the library built for the Rust target's runtime too. This crate is that
//! consumer in miniature: its test binary links a `cc`-built C++ object and the
//! VT library together, so a library built for the other runtime fails here, at
//! link time, instead of in a consumer's build.

#[cfg(all(test, target_env = "msvc"))]
mod tests {
    use std::ffi::c_int;

    unsafe extern "C" {
        fn ghosttea_vt_crt_witness(value: c_int) -> c_int;
    }

    #[test]
    fn a_cpp_object_built_for_the_targets_runtime_links_beside_the_vt_library() {
        // Feeding a terminal pulls the VT library's C++ objects into the link.
        let mut terminal = ghosttea_vt::GhosttyTerminalCore::new(80, 4, 100).unwrap();
        terminal.feed(b"\x1b[1mwitness\x1b[0m\r\n");
        assert_eq!(unsafe { ghosttea_vt_crt_witness(41) }, 41);
    }
}
