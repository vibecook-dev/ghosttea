//! A runnable compact host on loopback, for the cross-language interop run.
//!
//! Binds a real TCP listener on 127.0.0.1, serves one real PTY-backed session
//! through the real compact protocol stack, and runs until it is signalled. The
//! Swift client dials it over an ordinary socket, so the two implementations
//! meet as they would in production — minus the tailnet identity prologue,
//! which cannot run here and is documented at `serve_compact_loopback`.
//!
//! Everything a driver needs comes out on one line of stdout and nothing else
//! does, so the port and session id can be read without parsing prose.

#[cfg(unix)]
use std::{
    collections::HashMap,
    io::Write,
    sync::{Arc, Mutex},
    time::Duration,
};

#[cfg(unix)]
use anyhow::{Context, Result};
#[cfg(unix)]
use ghosttea::{
    FrameHub, HostShutdownAnnouncer, Session, SessionProgramKind, SessionRegistry, TextEngine,
    session::{Persistence, SpawnOptions},
};
#[cfg(unix)]
use ghosttea_truffle::{TruffleTerminalConfig, serve_compact_loopback};

/// The device id the client must assert in its hello. Checked by the host, so a
/// client that gets it wrong is refused — the one piece of the identity story
/// that survives off a tailnet.
#[cfg(unix)]
const DEVICE_ID: &str = "compact-interop-device";
/// Stands in for the WhoIs result. Every connection is attributed to it, which
/// is what makes generation ordering across reconnects meaningful.
#[cfg(unix)]
const CLIENT_ID: &str = "truffle:compact-interop";

/// Two deterministic lines for the selection row to select, then an idle read on
/// stdin so the session outlives every test rather than exiting underneath one.
#[cfg(unix)]
const SESSION_SCRIPT: &str = "printf 'interop-line-1\\ninterop-line-2\\n'; exec cat";

/// The scenarios this fixture stages — SIGSTOP freezes, SIGCONT thaws, SIGTERM
/// goodbyes — are Unix signal semantics; there is nothing for it to prove on
/// Windows, but `--all-targets --all-features` must still compile there.
#[cfg(not(unix))]
fn main() {
    eprintln!("compact-interop-host is unix-only: it stages SIGSTOP/SIGCONT/SIGTERM scenarios");
    std::process::exit(1);
}

#[cfg(unix)]
#[tokio::main]
async fn main() -> Result<()> {
    let registry = SessionRegistry::default();
    let session = Session::spawn(
        SpawnOptions {
            creation_id: None,
            executable: "/bin/sh".to_owned(),
            args: vec!["-c".to_owned(), SESSION_SCRIPT.to_owned()],
            cwd: None,
            env: HashMap::new(),
            environment: None,
            cols: 80,
            rows: 24,
            persistence: Persistence::TerminateWithApp,
            program_kind: SessionProgramKind::default(),
            owner_id: None,
            scrollback_bytes: None,
        },
        FrameHub::new(8),
        Arc::new(Mutex::new(
            TextEngine::discover().context("discover text engine")?,
        )),
        Arc::new(|_, _| {}),
    )
    .context("spawn the interop session")?;
    let session_id = session.id();
    registry
        .write()
        .unwrap()
        .insert(session_id.clone(), session);

    let listener = tokio::net::TcpListener::bind("127.0.0.1:0")
        .await
        .context("bind the compact interop listener")?;
    let port = listener.local_addr()?.port();

    let ready = serde_json::json!({
        "port": port,
        "sessionId": session_id,
        "deviceId": DEVICE_ID,
        "clientId": CLIENT_ID,
        "pid": std::process::id(),
    });
    println!("GHOSTTEA_COMPACT_INTEROP_READY {ready}");
    std::io::stdout().flush().ok();

    let shutdown = HostShutdownAnnouncer::new();
    let config = TruffleTerminalConfig {
        // The interop rows include claiming control, which a read-only view
        // cannot do. No token is involved: this listener is loopback-only.
        allow_tailnet_write: true,
        ..TruffleTerminalConfig::default()
    };
    // Owned here, not by the serve loop. The select below drops the losing
    // future, and a connection handler treats a closed configuration publisher
    // as a fault and hangs up — so a publisher living inside the serve loop
    // would cut every connection at the instant of SIGTERM, before the drain
    // announced anything, and the goodbye would reach nobody. Held by main, it
    // outlives the announcement.
    let (_host_config, host_config) = tokio::sync::watch::channel(Arc::new(
        ghosttea::ConfigSnapshot::default().terminal_presentation(),
    ));

    tokio::select! {
        served = serve_compact_loopback(
            listener,
            registry,
            config,
            DEVICE_ID.to_owned(),
            CLIENT_ID.to_owned(),
            shutdown.clone(),
            host_config,
        ) => served,
        signal = terminated() => {
            signal?;
            // Announce before going, so a client still attached learns the host
            // is leaving instead of reading the close as an outage — the same
            // drain the daemon performs, and the only way this fixture can
            // exercise the compact goodbye.
            shutdown.announce();
            tokio::time::sleep(Duration::from_millis(250)).await;
            Ok(())
        }
    }
}

/// Resolves on SIGTERM or SIGINT — how the driver stops this, and how a test
/// asks for the goodbye frame.
#[cfg(unix)]
async fn terminated() -> Result<()> {
    use tokio::signal::unix::{SignalKind, signal};
    let mut term = signal(SignalKind::terminate())?;
    let mut interrupt = signal(SignalKind::interrupt())?;
    tokio::select! {
        _ = term.recv() => {}
        _ = interrupt.recv() => {}
    }
    Ok(())
}
