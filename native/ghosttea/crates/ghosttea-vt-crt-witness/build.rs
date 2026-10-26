//! Builds the witness object only where the C runtime choice reaches the link:
//! MSVC, whose C++ standard headers stamp every object with the runtime it was
//! compiled for and whose linker refuses two different stamps.
fn main() {
    println!("cargo:rerun-if-changed=src/witness.cpp");
    if std::env::var("CARGO_CFG_TARGET_ENV").as_deref() != Ok("msvc") {
        return;
    }
    // `cc` follows the Rust target, `/MD` unless it enables `crt-static`, which
    // is exactly what a consumer's own C++ dependency is built for.
    cc::Build::new()
        .cpp(true)
        .file("src/witness.cpp")
        .compile("ghosttea_vt_crt_witness");
}
