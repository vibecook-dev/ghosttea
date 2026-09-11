//! Platform-neutral Ghosttea terminal model contracts.

mod authority;
mod effects;
pub mod frame;
mod input_order;
pub mod links;
mod logical;
mod model;
mod replica;

pub use authority::{
    AttachRejection, AttachRejectionCode, ControlChanged, ControlClaim, ControlSnapshot,
    ControllerState, MAX_ATTACH_WATERMARKS_PER_CLIENT, PreparedResize, ResumeEvidence,
    StateStreamCancel, TakeOver, TakeOverRequest, ViewAccess, ViewAuthority,
};
pub use effects::{ClipboardRequest, TerminalEffect, TerminalMetadata, TerminalUpdate};
pub use frame::{FrameCursor, TextSnapshot, encode_text_snapshot};
pub use ghosttea_vt::{TerminalSelection, TerminalSelectionPoint};
pub use input_order::InputOrderState;
pub use logical::{
    AccessibilityRow, LogicalCell, LogicalCellStyle, LogicalCursor, LogicalRow, LogicalScrollbar,
    LogicalTerminalPatch, LogicalTerminalSnapshot, RowReplacement,
};
pub use model::{
    RenderRequest, TerminalModel, TerminalModelOptions, TerminalRuntime,
    TextEnginePerformanceSnapshot,
};
pub use replica::{LogicalReplicaModel, ReplicaRenderPerformanceSnapshot};
