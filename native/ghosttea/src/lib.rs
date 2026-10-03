//! Reusable, transport-neutral Ghosttea terminal service.

mod frame_hub;
pub mod ipc;
pub mod mesh;
pub mod replica;
mod service;
pub mod session;
pub mod tunnel_protocol;

pub use frame_hub::{FrameHub, FramePacket};
pub use ghosttea_config::{
    CONFIG_DOCUMENT_SCHEMA_VERSION, ConfigCompatibility, ConfigDiagnostic, ConfigDocument,
    ConfigDocumentError, ConfigDocumentUpdate, ConfigDocumentValidation, ConfigLoadOptions,
    ConfigManager, ConfigSnapshot, ConfigSource, ConfigSourceKind, ConfigSupport, ConfiguredKey,
    DiagnosticSeverity, GHOSTTEA_BETTER_CRT_SHADER, GHOSTTY_COMPAT_COMMIT, GHOSTTY_COMPAT_VERSION,
    GHOSTTY_CONFIG_COMPAT_COMMIT, GHOSTTY_CONFIG_COMPAT_VERSION, KeybindingConfig, LightAdaptation,
    MAX_CONFIG_DOCUMENT_BYTES, RendererConfig, RendererPostProcess, TerminalConfig,
    TerminalPresentationConfig, WorkspaceConfig,
};
pub use ghosttea_core::{
    AttachRejection, AttachRejectionCode, ControlClaim, ControlSnapshot, ControllerState,
    ResumeEvidence, StateStreamCancel, TakeOver, ViewAccess,
};
pub use ghosttea_text::{
    FontMode, FontPresentation, FontResource, FontResources, RASTER_SCALE, TextEngine, TextMetrics,
};
pub use mesh::{
    HostShutdownAnnouncer, MeshReconnectConfig, RemoteActivityChanged, RemoteAttachment,
    RemoteControlChanged, RemoteControlClaim, RemoteControlOutcome, RemoteControlState,
    RemoteController, RemoteEndedReason, RemoteExitInfo, RemoteHostSummary, RemoteLifecycleChanged,
    RemoteLifecycleState, RemoteResize, RemoteSelection, RemoteSessionLifecycle, RemoteSessionOpen,
    RemoteTerminalRuntime, RemoteViewRecord, RemoteViewState, RemoteViewStateChanged,
    SessionStatusSource, TerminalMesh,
};
pub use replica::RemoteReplica;
pub use service::Registry as SessionRegistry;
pub use service::{
    DrainReport, ReadyInfo, ServiceHandle, ServiceSessions, SessionLifecycleEvent, TerminalService,
    TerminalServiceConfig, TerminalServiceListeners,
};
pub use session::{
    AutomationInputOperation, AutomationInputResult, ExitCallback, ExitOutcome, Persistence,
    Session, SessionActivity, SessionActivityConfidence, SessionActivityKind,
    SessionActivitySource, SessionEndCause, SessionEndEvidence, SessionEnvironment, SessionExit,
    SessionProgramKind, SessionStatus, SessionSummary, SessionTombstone, SessionTombstones,
    SpawnOptions, TerminationSource, TombstoneClock,
};
