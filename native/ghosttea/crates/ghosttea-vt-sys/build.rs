use std::{
    collections::BTreeMap,
    env, fs,
    path::{Path, PathBuf},
};

use serde::Deserialize;
use sha2::{Digest, Sha256};

const MAX_BUNDLE_SIZE: u64 = 64 * 1024 * 1024;

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct ArtifactManifest {
    schema_version: u32,
    targets: BTreeMap<String, TargetArtifact>,
}

#[derive(Deserialize)]
#[serde(rename_all = "camelCase")]
struct TargetArtifact {
    filename: String,
    url: String,
    sha256: String,
    size: u64,
    library_sha256: String,
    headers_sha256: String,
    /// Bundle-relative path of the static archive. Optional so existing
    /// manifests keep working; when absent the platform default applies.
    #[serde(default)]
    library_path: Option<String>,
    /// Whether a local build of this target reproduces the released bytes.
    ///
    /// Container cross-builds compile at fixed in-container paths, so any host
    /// reproduces them. Native builds embed the building machine's absolute
    /// paths in the archive, so their locked checksums describe the published
    /// bundle only. Absent means reproducible, which keeps existing manifests
    /// on the stricter behavior.
    #[serde(default = "reproducible_by_default")]
    reproducible: bool,
}

fn reproducible_by_default() -> bool {
    true
}

/// Where an install tree came from, which decides whether its bytes must match
/// the locked checksums.
enum Prefix {
    /// Built in this checkout from the pinned Ghostty commit.
    Repository(PathBuf),
    /// Extracted from a downloaded or caller-supplied release bundle.
    Bundle(PathBuf),
}

impl Prefix {
    fn path(&self) -> &Path {
        match self {
            Prefix::Repository(path) | Prefix::Bundle(path) => path,
        }
    }
}

impl TargetArtifact {
    fn library_path(&self, layout: &Layout) -> String {
        self.library_path
            .clone()
            .unwrap_or_else(|| layout.library_path.to_owned())
    }
}

/// Per-target naming for the static archive Ghostty installs and for the
/// private copy Cargo links against.
///
/// Ghostty installs the Windows static archive as `ghostty-vt-static.lib` so it
/// cannot collide with `ghostty-vt.lib`, the DLL import library that sits beside
/// it. Everywhere else it installs `libghostty-vt.a`.
struct Layout {
    library_path: &'static str,
    link_file_name: &'static str,
}

const LINK_NAME: &str = "ghosttea_ghostty_vt_static";

fn layout() -> Layout {
    let os = env::var("CARGO_CFG_TARGET_OS").unwrap_or_default();
    let abi = env::var("CARGO_CFG_TARGET_ENV").unwrap_or_default();
    Layout {
        library_path: if os == "windows" {
            "lib/ghostty-vt-static.lib"
        } else {
            "lib/libghostty-vt.a"
        },
        // MSVC resolves `-l static=NAME` as `NAME.lib`; every other toolchain
        // expects `libNAME.a`. Both spellings must track LINK_NAME.
        link_file_name: if abi == "msvc" {
            "ghosttea_ghostty_vt_static.lib"
        } else {
            "libghosttea_ghostty_vt_static.a"
        },
    }
}

fn main() {
    let out = PathBuf::from(env::var_os("OUT_DIR").expect("Cargo output directory"));
    for variable in [
        "GHOSTTY_VT_PREFIX",
        "GHOSTTEA_GHOSTTY_VT_BUNDLE",
        "GHOSTTEA_GHOSTTY_VT_BASE_URL",
        "GHOSTTEA_GHOSTTY_VT_OFFLINE",
    ] {
        println!("cargo:rerun-if-env-changed={variable}");
    }
    println!("cargo:rerun-if-changed=artifacts.json");
    for path in [
        "src/ghostty_shim.c",
        "src/ghostty_shim.h",
        "src/ghostty_shim_internal.h",
        "src/ghostty_shim_saved.c",
        "src/ghostty_shim_screen.c",
        "src/ghostty_shim_identity.c",
    ] {
        rerun_if_changed(Path::new(path), &out);
    }

    let manifest_dir =
        PathBuf::from(env::var_os("CARGO_MANIFEST_DIR").expect("manifest directory"));
    let target = artifact_key(&env::var("TARGET").expect("Cargo target triple"));
    let layout = layout();
    if let Some(prefix) = env::var_os("GHOSTTY_VT_PREFIX") {
        let prefix = PathBuf::from(prefix);
        validate_local_override(&prefix, &out, &layout);
        link(&prefix, &out, &layout);
        return;
    }
    let manifest: ArtifactManifest = serde_json::from_str(include_str!("artifacts.json"))
        .expect("valid Ghostty artifact manifest");
    assert_eq!(
        manifest.schema_version, 1,
        "unsupported Ghostty artifact manifest"
    );
    let artifact = manifest.targets.get(&target).unwrap_or_else(|| {
        panic!(
            "Ghosttea has no Ghostty VT artifact for {target}; supported targets: {}",
            manifest
                .targets
                .keys()
                .cloned()
                .collect::<Vec<_>>()
                .join(", ")
        )
    });

    let prefix = resolve_prefix(&manifest_dir, &out, &target, artifact, &layout);
    match &prefix {
        // A release bundle is untrusted input; its bytes are always verified.
        Prefix::Bundle(path) => {
            validate_headers(path, artifact);
            validate_library(path, artifact, &layout);
            // Nothing to declare: a bundle is always extracted into OUT_DIR, so
            // the install tree here is this script's output. The bundle it came
            // from is declared at the point it was resolved.
        }
        Prefix::Repository(path) => {
            // Headers are generated from the pinned Ghostty source and are
            // identical for every target, so this catches an install tree left
            // behind by a different commit even where the library cannot be
            // compared.
            validate_headers(path, artifact);
            // The library is a reproducibility check rather than a trust
            // boundary here: it already came from the pinned commit, and only
            // targets that build byte-for-byte can be held to its checksum.
            if artifact.reproducible {
                validate_library(path, artifact, &layout);
            }
            // A repository install tree is a genuine input. It is produced
            // outside this script by a separate Ghostty build, so rebuilding
            // the checkout must relink even though no manifest input moved.
            rerun_if_changed(&path.join(artifact.library_path(&layout)), &out);
            rerun_if_changed(&path.join("include"), &out);
        }
    }
    link(prefix.path(), &out, &layout);
}

/// The manifest key of the artifact this build links: the target triple, plus
/// the C runtime on MSVC.
///
/// Every object in one MSVC link must be compiled for the same C runtime; the
/// linker refuses a mix (LNK2038). A Rust target links the dynamic runtime
/// (`/MD`) unless it enables `crt-static`, and `cc` builds a consumer's own C++
/// for the same one, so the triple's key holds the library compiled for the
/// dynamic runtime and `<triple>-crt-static` the one compiled for the static
/// runtime (`/MT`).
fn artifact_key(target: &str) -> String {
    let msvc = env::var("CARGO_CFG_TARGET_ENV").is_ok_and(|abi| abi == "msvc");
    let crt_static = env::var("CARGO_CFG_TARGET_FEATURE")
        .is_ok_and(|features| features.split(',').any(|feature| feature == "crt-static"));
    if msvc && crt_static {
        format!("{target}-crt-static")
    } else {
        target.to_owned()
    }
}

fn resolve_prefix(
    manifest_dir: &Path,
    out: &Path,
    target: &str,
    artifact: &TargetArtifact,
    layout: &Layout,
) -> Prefix {
    if let Some(bundle) = env::var_os("GHOSTTEA_GHOSTTY_VT_BUNDLE") {
        let bundle = PathBuf::from(bundle);
        // A caller-supplied bundle is a genuine input: it lives outside OUT_DIR
        // and the caller can swap it without the variable's value changing, so
        // `rerun-if-env-changed` alone would miss it.
        rerun_if_changed(&bundle, out);
        return Prefix::Bundle(extract_bundle(&bundle, out, artifact));
    }

    // Repository builds keep one install tree per target so a checkout can hold
    // more than one platform's output at a time.
    let build_root = manifest_dir.join("../../../build/ghostty");
    let library_path = artifact.library_path(layout);
    for candidate in [
        build_root.join(target).join("install"),
        build_root.join("install"),
    ] {
        if candidate.join(&library_path).is_file() {
            return Prefix::Repository(candidate);
        }
    }

    if offline() {
        panic!(
            "Ghostty VT is unavailable in offline mode. Set GHOSTTY_VT_PREFIX or \
             GHOSTTEA_GHOSTTY_VT_BUNDLE to a verified local artifact."
        );
    }

    let url = env::var("GHOSTTEA_GHOSTTY_VT_BASE_URL")
        .map(|base| format!("{}/{}", base.trim_end_matches('/'), artifact.filename))
        .unwrap_or_else(|_| artifact.url.clone());
    let bundle = out.join(&artifact.filename);
    let mut response = ureq::get(&url)
        .call()
        .unwrap_or_else(|error| panic!("failed to download Ghostty VT from {url}: {error}"));
    let contents = response
        .body_mut()
        .with_config()
        .limit(MAX_BUNDLE_SIZE)
        .read_to_vec()
        .unwrap_or_else(|error| panic!("failed to read Ghostty VT bundle from {url}: {error}"));
    fs::write(&bundle, contents).expect("write downloaded Ghostty VT bundle");
    // The download is not declared as an input. It lands in OUT_DIR, and
    // `artifacts.json` — already declared above — pins its URL, size, and
    // SHA-256, so the manifest is a complete fingerprint of these bytes.
    Prefix::Bundle(extract_bundle(&bundle, out, artifact))
}

fn validate_local_override(prefix: &Path, out: &Path, layout: &Layout) {
    let library = prefix.join(layout.library_path);
    let header = prefix.join("include/ghostty/vt.h");
    assert!(
        library.is_file() && header.is_file(),
        "GHOSTTY_VT_PREFIX must contain {} and include/ghostty/vt.h",
        layout.library_path
    );
    // Both are caller-supplied files outside OUT_DIR, so both are real inputs.
    rerun_if_changed(&library, out);
    rerun_if_changed(&header, out);
}

/// Declares a build-script input, refusing any path this script produced.
///
/// Cargo compares each declared path against the build unit's own `output` file
/// and re-runs the script when a path is newer. That reference is written
/// before the script finishes populating `OUT_DIR`, so a declared path under
/// `OUT_DIR` is permanently newer than it and the unit invalidates itself on
/// every build — taking the whole dependent chain with it. Provenance is
/// decided by the caller; this keeps a future one from reintroducing the loop.
fn rerun_if_changed(path: &Path, out: &Path) {
    if path.starts_with(out) {
        return;
    }
    println!("cargo:rerun-if-changed={}", path.display());
}

fn extract_bundle(bundle: &Path, out: &Path, artifact: &TargetArtifact) -> PathBuf {
    let contents = fs::read(bundle).unwrap_or_else(|error| {
        panic!(
            "failed to read Ghostty VT bundle {}: {error}",
            bundle.display()
        )
    });
    assert_eq!(
        contents.len() as u64,
        artifact.size,
        "size mismatch for {}; refusing an incomplete native artifact",
        bundle.display()
    );
    verify_hash(bundle, &contents, &artifact.sha256);

    let prefix = out.join("ghostty-vt");
    if prefix.exists() {
        fs::remove_dir_all(&prefix).expect("remove stale Ghostty VT extraction");
    }
    fs::create_dir_all(&prefix).expect("create Ghostty VT extraction directory");
    let mut archive = tar::Archive::new(contents.as_slice());
    archive
        .unpack(&prefix)
        .unwrap_or_else(|error| panic!("failed to extract {}: {error}", bundle.display()));
    prefix
}

fn validate_library(prefix: &Path, artifact: &TargetArtifact, layout: &Layout) {
    let library = prefix.join(artifact.library_path(layout));
    let contents = fs::read(&library).unwrap_or_else(|error| {
        panic!(
            "failed to read required artifact {}: {error}",
            library.display()
        )
    });
    verify_hash(&library, &contents, &artifact.library_sha256);
}

/// Headers come from the pinned Ghostty source rather than the compiler, so
/// every target's manifest records the same digest and any install tree can be
/// held to it.
fn validate_headers(prefix: &Path, artifact: &TargetArtifact) {
    let include = prefix.join("include");
    let actual_headers = header_tree_hash(&include);
    assert_eq!(
        actual_headers,
        artifact.headers_sha256,
        "checksum mismatch for {}; refusing an untrusted native artifact",
        include.display()
    );
}

fn header_tree_hash(include: &Path) -> String {
    fn collect(directory: &Path, files: &mut Vec<PathBuf>) {
        let entries = fs::read_dir(directory).unwrap_or_else(|error| {
            panic!(
                "failed to read header directory {}: {error}",
                directory.display()
            )
        });
        for entry in entries {
            let path = entry.expect("read header directory entry").path();
            if path.is_dir() {
                collect(&path, files);
            } else {
                files.push(path);
            }
        }
    }

    let mut files = Vec::new();
    collect(include, &mut files);
    files.sort_by_key(|path| {
        path.strip_prefix(include)
            .expect("header below include root")
            .to_string_lossy()
            .replace('\\', "/")
    });
    let mut inventory = Sha256::new();
    for path in files {
        let relative = path
            .strip_prefix(include)
            .expect("header below include root");
        let relative = relative.to_string_lossy().replace('\\', "/");
        let contents = fs::read(&path)
            .unwrap_or_else(|error| panic!("failed to read header {}: {error}", path.display()));
        let checksum = format!("{:x}", Sha256::digest(&contents));
        inventory.update(format!(
            "include/{relative}\0{checksum}\0{}\n",
            contents.len()
        ));
    }
    format!("{:x}", inventory.finalize())
}

fn verify_hash(path: &Path, contents: &[u8], expected: &str) {
    let actual = format!("{:x}", Sha256::digest(contents));
    assert_eq!(
        actual,
        expected,
        "checksum mismatch for {}; refusing an untrusted native artifact",
        path.display()
    );
}

fn link(prefix: &Path, out: &Path, layout: &Layout) {
    let library = prefix.join(layout.library_path);
    let include = prefix.join("include");

    // Give the static archive a unique link name. macOS's linker can otherwise
    // prefer a sibling dylib even when Cargo requests a static library, and on
    // Windows the installed `ghostty-vt.lib` import library sits in the same
    // directory as the static `ghostty-vt-static.lib`.
    let static_library = out.join(layout.link_file_name);
    fs::copy(&library, &static_library).unwrap_or_else(|error| {
        panic!(
            "failed to copy Ghostty VT static archive {}: {error}",
            library.display()
        )
    });

    cc::Build::new()
        .file("src/ghostty_shim.c")
        .file("src/ghostty_shim_saved.c")
        .file("src/ghostty_shim_screen.c")
        .file("src/ghostty_shim_identity.c")
        .include(include)
        .define("GHOSTTY_STATIC", None)
        .flag_if_supported("-std=c11")
        .warnings(true)
        .compile("ghosttea_ghostty_shim");

    println!("cargo:rustc-link-search=native={}", out.display());
    println!("cargo:rustc-link-lib=static={LINK_NAME}");
}

fn offline() -> bool {
    env::var("GHOSTTEA_GHOSTTY_VT_OFFLINE")
        .map(|value| matches!(value.to_ascii_lowercase().as_str(), "1" | "true" | "yes"))
        .unwrap_or(false)
}
