//! Multi-view attachment, control, resize, and input-deduplication policy.

use std::{collections::HashMap, fmt, sync::Arc};

use anyhow::{Result, bail};

/// The host's cap on a wire view id, enforced identically by `attach` and
/// [`ViewAuthority::take_over`] so a viewer's id encoding has one bound to
/// respect.
const MAX_VIEW_ID_BYTES: usize = 128;

/// Outstanding attach watermarks a single client may hold on one session.
///
/// Watermarks are never evicted on a timer — they are the only thing fencing a
/// delayed attach — so growth is bounded by admission control instead. The cap
/// is per client: a client that exhausts it fails alone.
pub const MAX_ATTACH_WATERMARKS_PER_CLIENT: usize = 256;

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum ViewAccess {
    ReadOnly,
    ReadWrite,
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControllerState {
    pub view_id: String,
    pub client_id: String,
    pub control_epoch: u64,
    /// The incarnation that claimed control. A view that was taken over cannot
    /// keep controlling the terminal through its successor's attachment.
    pub attachment_epoch: u64,
}

/// Everything a viewer needs to reconcile controller state, including the case
/// `ControlChanged` cannot express: *no* controller, at a known revision.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlSnapshot {
    pub controller: Option<ControllerState>,
    pub control_revision: u64,
    pub cols: u16,
    pub rows: u16,
    pub layout_epoch: u64,
}

/// The outcome of a compare-and-swap claim. A rejection is not an error: it
/// carries the state the host announces so the loser can decide whether to
/// retry (no controller at a newer revision) or stand down (someone else
/// holds control).
#[derive(Clone, Debug, PartialEq, Eq)]
pub enum ControlClaim {
    Granted(ControlChanged),
    Rejected(ControlSnapshot),
}

/// Resume evidence supplied by the viewer. Ordering deliberately lives outside
/// it, in `attach_generation`, because *every* attempt needs ordering while
/// only resumes carry evidence.
#[derive(Clone, Copy, Debug, Default, PartialEq, Eq)]
pub struct ResumeEvidence {
    pub previous_session_epoch: u64,
    pub previous_attachment_epoch: u64,
    pub previous_terminal_revision: u64,
}

/// One attach attempt, ordered and fenced.
///
/// `session_epoch` is supplied by the caller rather than held by the authority:
/// the epoch belongs to the terminal model, and mirroring it here would create
/// a second source of truth that could drift. The caller must read it and pass
/// it under the same lock it calls `take_over` with, so the validation is
/// atomic with the mutation it guards.
#[derive(Clone, Copy, Debug)]
pub struct TakeOverRequest<'a> {
    pub view_id: &'a str,
    pub client_id: &'a str,
    pub access: ViewAccess,
    /// Monotonic per wire-view lineage across every attempt, resumes and
    /// initial retries alike. Rejected if not strictly greater than the
    /// highest already accepted for this `(view_id, client_id)`.
    pub attach_generation: u64,
    /// The highest connection id this host has assigned to this client at the
    /// moment of the attach — **not** necessarily the connection the attach
    /// arrived on. It fences every connection that could still deliver an
    /// older generation, which is what makes watermark GC sound.
    pub fence_conn_id: u64,
    /// The live session epoch, read by the caller under this same lock.
    pub session_epoch: u64,
    pub resume: Option<ResumeEvidence>,
}

/// Everything the host needs to answer an attach, composed under the single
/// critical section that performed it.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct TakeOver {
    pub attachment_epoch: u64,
    /// Whether a live attachment of this view was replaced. Reported to the
    /// viewer as `ViewAttached.resumed`.
    pub resumed: bool,
    /// Whether this takeover dropped a controller held by the superseded
    /// incarnation — the trigger for announcing the new control state.
    pub controller_cleared: bool,
    /// The controller as of this attach, reported here rather than left for
    /// the caller to read back: a takeover clears the controller only when it
    /// names *this* view, so another view may still hold control, and a second
    /// read could observe a different controller than the one this attach
    /// actually landed against.
    ///
    /// `None` is a first-class observation — "no controller at
    /// `control_revision`" — never "unknown".
    pub controller: Option<ControllerState>,
    pub control_revision: u64,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub enum AttachRejectionCode {
    StaleResume,
    ViewInvalid,
    ViewLimit,
    SessionEpochMismatch,
}

/// A refusal the host can turn into a wire `AttachRejected` without guessing:
/// the code drives the viewer's recovery, the detail drives the host's log.
#[derive(Clone, Debug, PartialEq, Eq)]
pub struct AttachRejection {
    pub code: AttachRejectionCode,
    pub detail: String,
}

impl AttachRejection {
    fn new(code: AttachRejectionCode, detail: impl Into<String>) -> Self {
        Self {
            code,
            detail: detail.into(),
        }
    }
}

impl fmt::Display for AttachRejection {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        write!(formatter, "{}", self.detail)
    }
}

impl std::error::Error for AttachRejection {}

/// Stops the state stream of one attachment incarnation.
///
/// Fired while the authority's lock is held, so the closure must not re-enter
/// the authority — cancel a token, do not detach a view.
#[derive(Clone)]
pub struct StateStreamCancel(Arc<dyn Fn() + Send + Sync>);

impl StateStreamCancel {
    pub fn new(cancel: impl Fn() + Send + Sync + 'static) -> Self {
        Self(Arc::new(cancel))
    }

    fn fire(&self) {
        (self.0)();
    }
}

impl fmt::Debug for StateStreamCancel {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter.write_str("StateStreamCancel")
    }
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
struct AttachWatermark {
    generation: u64,
    fence_conn_id: u64,
}

#[derive(Clone, Debug)]
struct AttachedView {
    client_id: String,
    access: ViewAccess,
    attachment_epoch: u64,
    last_input_sequence: u64,
    last_resize_sequence: u64,
    state_stream: Option<StateStreamCancel>,
}

impl AttachedView {
    fn cancel_state_stream(&self) {
        if let Some(cancel) = &self.state_stream {
            cancel.fire();
        }
    }
}

#[derive(Clone, Debug, PartialEq, Eq)]
pub struct ControlChanged {
    pub controller: ControllerState,
    pub cols: u16,
    pub rows: u16,
    pub layout_epoch: u64,
    pub size_changed: bool,
}

#[derive(Clone, Copy, Debug, PartialEq, Eq)]
pub struct PreparedResize {
    resize_sequence: u64,
    cols: u16,
    rows: u16,
    layout_epoch: u64,
    size_changed: bool,
}

impl PreparedResize {
    pub fn layout_epoch(self) -> u64 {
        self.layout_epoch
    }

    pub fn size_changed(self) -> bool {
        self.size_changed
    }
}

#[derive(Clone, Debug)]
pub struct ViewAuthority {
    views: HashMap<String, AttachedView>,
    controller: Option<ControllerState>,
    next_control_epoch: u64,
    next_attachment_epoch: u64,
    /// Bumped on every controller change, clears included, so "the controller
    /// went away" is observable. Starts at 1, which makes 0 unreachable and
    /// therefore usable on the wire as "legacy host, unknown".
    control_revision: u64,
    /// `client_id -> view_id -> watermark`. Nested so the per-client cap and
    /// per-client GC are both direct lookups.
    attach_watermarks: HashMap<String, HashMap<String, AttachWatermark>>,
    cols: u16,
    rows: u16,
    layout_epoch: u64,
}

impl ViewAuthority {
    pub fn new(cols: u16, rows: u16) -> Self {
        Self {
            views: HashMap::new(),
            controller: None,
            next_control_epoch: 0,
            next_attachment_epoch: 0,
            control_revision: 1,
            attach_watermarks: HashMap::new(),
            cols,
            rows,
            layout_epoch: 1,
        }
    }

    pub fn attach(&mut self, view_id: &str, client_id: &str, access: ViewAccess) -> Result<u64> {
        if view_id.is_empty() || view_id.len() > MAX_VIEW_ID_BYTES {
            bail!("invalid view id");
        }
        if let Some(existing) = self.views.get(view_id) {
            if existing.client_id == client_id {
                return Ok(existing.attachment_epoch);
            }
            bail!("view id is already attached by another client");
        }
        self.next_attachment_epoch = self.next_attachment_epoch.saturating_add(1);
        let attachment_epoch = self.next_attachment_epoch;
        self.views.insert(
            view_id.to_owned(),
            AttachedView {
                client_id: client_id.to_owned(),
                access,
                attachment_epoch,
                last_input_sequence: 0,
                last_resize_sequence: 0,
                state_stream: None,
            },
        );
        Ok(attachment_epoch)
    }

    /// Attach with takeover semantics: ordered by `attach_generation`, fenced
    /// against delayed attempts, and guaranteed to mint a *fresh* attachment
    /// epoch even when the same client re-attaches the same view id.
    ///
    /// Every validation runs before any mutation, so a rejected attempt leaves
    /// no trace — no epoch minted, no watermark raised.
    pub fn take_over(
        &mut self,
        request: TakeOverRequest<'_>,
    ) -> std::result::Result<TakeOver, AttachRejection> {
        let TakeOverRequest {
            view_id,
            client_id,
            access,
            attach_generation,
            fence_conn_id,
            session_epoch,
            resume,
        } = request;

        if view_id.is_empty() || view_id.len() > MAX_VIEW_ID_BYTES {
            return Err(AttachRejection::new(
                AttachRejectionCode::ViewInvalid,
                "invalid view id",
            ));
        }
        if let Some(resume) = resume
            && resume.previous_session_epoch != session_epoch
        {
            return Err(AttachRejection::new(
                AttachRejectionCode::SessionEpochMismatch,
                format!(
                    "resume expects session epoch {} but the session is at {session_epoch}",
                    resume.previous_session_epoch
                ),
            ));
        }
        let watermark = self
            .attach_watermarks
            .get(client_id)
            .and_then(|views| views.get(view_id))
            .copied();
        match watermark {
            Some(watermark) if attach_generation <= watermark.generation => {
                return Err(AttachRejection::new(
                    AttachRejectionCode::StaleResume,
                    format!(
                        "attach generation {attach_generation} is not newer than {}",
                        watermark.generation
                    ),
                ));
            }
            Some(_) => {}
            None => {
                let outstanding = self
                    .attach_watermarks
                    .get(client_id)
                    .map_or(0, HashMap::len);
                if outstanding >= MAX_ATTACH_WATERMARKS_PER_CLIENT {
                    return Err(AttachRejection::new(
                        AttachRejectionCode::ViewLimit,
                        format!(
                            "client holds {outstanding} outstanding attach watermarks on this session"
                        ),
                    ));
                }
            }
        }
        if let Some(existing) = self.views.get(view_id)
            && existing.client_id != client_id
        {
            return Err(AttachRejection::new(
                AttachRejectionCode::ViewInvalid,
                "view id is already attached by another client",
            ));
        }

        // Validation is complete; from here the attempt is accepted.
        // `max` keeps the fence from regressing if attempts are processed out
        // of order — a fence that only ever moves forward can only delay GC,
        // never permit it early.
        let fence_conn_id = watermark.map_or(fence_conn_id, |watermark| {
            watermark.fence_conn_id.max(fence_conn_id)
        });
        self.attach_watermarks
            .entry(client_id.to_owned())
            .or_default()
            .insert(
                view_id.to_owned(),
                AttachWatermark {
                    generation: attach_generation,
                    fence_conn_id,
                },
            );

        let previous = self.views.remove(view_id);
        if let Some(previous) = &previous {
            // Inside the critical section: a superseded handler that has not
            // yet registered will fail its epoch check instead, so no
            // interleaving lets a stale stream survive.
            previous.cancel_state_stream();
        }
        self.next_attachment_epoch = self.next_attachment_epoch.saturating_add(1);
        let attachment_epoch = self.next_attachment_epoch;
        self.views.insert(
            view_id.to_owned(),
            AttachedView {
                client_id: client_id.to_owned(),
                access,
                attachment_epoch,
                last_input_sequence: 0,
                last_resize_sequence: 0,
                state_stream: None,
            },
        );

        // Any controller entry naming this view belongs to an earlier
        // incarnation: the one just installed has not claimed anything yet.
        let controller_cleared = self.clear_controller_for_view(view_id);

        Ok(TakeOver {
            attachment_epoch,
            resumed: previous.is_some(),
            controller_cleared,
            controller: self.controller.clone(),
            control_revision: self.control_revision,
        })
    }

    /// Release watermarks whose fence has provably retired.
    ///
    /// `terminated_through_conn_id` is the host's per-client termination
    /// watermark: the highest id such that **every** connection from that
    /// client at or below it is fully terminated — transport closed *and* its
    /// spawned stream handlers finished. A watermark is freed only when its
    /// view is detached and its fence sits at or below that line, because an
    /// older connection can still hold a delayed lower-generation attach.
    ///
    /// Returns how many watermarks were freed.
    pub fn gc_attach_watermarks(
        &mut self,
        client_id: &str,
        terminated_through_conn_id: u64,
    ) -> usize {
        let attached: Vec<&str> = self
            .views
            .iter()
            .filter(|(_, view)| view.client_id == client_id)
            .map(|(view_id, _)| view_id.as_str())
            .collect();
        let Some(watermarks) = self.attach_watermarks.get_mut(client_id) else {
            return 0;
        };
        let before = watermarks.len();
        watermarks.retain(|view_id, watermark| {
            attached.iter().any(|attached| *attached == view_id)
                || watermark.fence_conn_id > terminated_through_conn_id
        });
        let freed = before - watermarks.len();
        if watermarks.is_empty() {
            self.attach_watermarks.remove(client_id);
        }
        freed
    }

    /// Outstanding watermark keys held by one client, against
    /// [`MAX_ATTACH_WATERMARKS_PER_CLIENT`].
    pub fn attach_watermark_count(&self, client_id: &str) -> usize {
        self.attach_watermarks
            .get(client_id)
            .map_or(0, HashMap::len)
    }

    /// Bind a state stream's cancel handle to one attachment incarnation.
    ///
    /// Fails unless `attachment_epoch` is the view's current one, which is the
    /// half of the takeover race cancellation alone cannot win: a handler that
    /// was still between attaching and registering when the takeover fired
    /// finds its epoch stale here and aborts without spawning.
    pub fn register_state_stream(
        &mut self,
        view_id: &str,
        attachment_epoch: u64,
        cancel: StateStreamCancel,
    ) -> Result<()> {
        let view = self
            .views
            .get_mut(view_id)
            .ok_or_else(|| anyhow::anyhow!("view is not attached"))?;
        if view.attachment_epoch != attachment_epoch {
            bail!("stale attachment epoch");
        }
        view.state_stream = Some(cancel);
        Ok(())
    }

    pub fn detach(&mut self, view_id: &str, client_id: &str) -> bool {
        let owned = self
            .views
            .get(view_id)
            .is_some_and(|view| view.client_id == client_id);
        if !owned {
            return false;
        }
        if let Some(view) = self.views.remove(view_id) {
            view.cancel_state_stream();
        }
        self.clear_controller_for_view(view_id);
        true
    }

    /// Detach only the named incarnation. A cleanup path that fires late —
    /// the old connection's death handler, an explicit `Detach` from a
    /// superseded attempt — must not evict the attachment that replaced it.
    pub fn detach_view_if_epoch(
        &mut self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
    ) -> bool {
        let current = self.views.get(view_id).is_some_and(|view| {
            view.client_id == client_id && view.attachment_epoch == attachment_epoch
        });
        if !current {
            return false;
        }
        if let Some(view) = self.views.remove(view_id) {
            view.cancel_state_stream();
        }
        self.clear_controller_for_view(view_id);
        true
    }

    pub fn claim_control(
        &mut self,
        view_id: &str,
        client_id: &str,
        cols: u16,
        rows: u16,
    ) -> Result<ControlChanged> {
        let view = self.require_view(view_id, client_id)?;
        if view.access != ViewAccess::ReadWrite {
            bail!("read-only view cannot control terminal size");
        }
        let attachment_epoch = view.attachment_epoch;
        Ok(self.commit_claim(view_id, client_id, attachment_epoch, cols, rows))
    }

    /// `claim_control` fenced by the claimant's attachment epoch and, when
    /// `expected_control_revision` is `Some`, by a compare-and-swap on the
    /// control revision.
    ///
    /// `None` is the legacy last-write-wins claim. A `Some` claim loses to any
    /// intervening change — another view's claim *or* a controller clear — and
    /// comes back as [`ControlClaim::Rejected`] carrying the state to announce,
    /// never as an error.
    pub fn claim_control_checked(
        &mut self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
        expected_control_revision: Option<u64>,
    ) -> Result<ControlClaim> {
        let view = self.require_view(view_id, client_id)?;
        if view.access != ViewAccess::ReadWrite {
            bail!("read-only view cannot control terminal size");
        }
        if view.attachment_epoch != attachment_epoch {
            bail!("stale attachment epoch");
        }
        if expected_control_revision.is_some_and(|expected| expected != self.control_revision) {
            return Ok(ControlClaim::Rejected(self.control_snapshot()));
        }
        Ok(ControlClaim::Granted(self.commit_claim(
            view_id,
            client_id,
            attachment_epoch,
            cols,
            rows,
        )))
    }

    fn commit_claim(
        &mut self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        cols: u16,
        rows: u16,
    ) -> ControlChanged {
        self.next_control_epoch = self.next_control_epoch.saturating_add(1);
        let controller = ControllerState {
            view_id: view_id.to_owned(),
            client_id: client_id.to_owned(),
            control_epoch: self.next_control_epoch,
            attachment_epoch,
        };
        self.controller = Some(controller.clone());
        self.control_revision = self.control_revision.saturating_add(1);
        let size_changed = (self.cols, self.rows) != (cols, rows);
        if size_changed {
            self.cols = cols;
            self.rows = rows;
            self.layout_epoch = self.layout_epoch.saturating_add(1);
        }
        ControlChanged {
            controller,
            cols: self.cols,
            rows: self.rows,
            layout_epoch: self.layout_epoch,
            size_changed,
        }
    }

    /// Drop the controller if it names this view, reporting whether it did.
    fn clear_controller_for_view(&mut self, view_id: &str) -> bool {
        if self
            .controller
            .as_ref()
            .is_none_or(|controller| controller.view_id != view_id)
        {
            return false;
        }
        self.controller = None;
        self.control_revision = self.control_revision.saturating_add(1);
        true
    }

    pub fn authorize_resize(
        &mut self,
        view_id: &str,
        client_id: &str,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u16,
        rows: u16,
    ) -> Result<bool> {
        let Some(prepared) = self.prepare_resize(
            view_id,
            client_id,
            control_epoch,
            resize_sequence,
            cols,
            rows,
        )?
        else {
            return Ok(false);
        };
        self.commit_resize(view_id, prepared);
        Ok(prepared.size_changed)
    }

    /// [`ViewAuthority::authorize_resize`] with the attachment-epoch check the
    /// input family already enforces, so a superseded incarnation cannot
    /// resize the terminal its successor now owns.
    #[allow(clippy::too_many_arguments)]
    pub fn authorize_resize_checked(
        &mut self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u16,
        rows: u16,
    ) -> Result<bool> {
        let Some(prepared) = self.prepare_resize_checked(
            view_id,
            client_id,
            attachment_epoch,
            control_epoch,
            resize_sequence,
            cols,
            rows,
        )?
        else {
            return Ok(false);
        };
        self.commit_resize(view_id, prepared);
        Ok(prepared.size_changed)
    }

    #[allow(clippy::too_many_arguments)]
    pub fn prepare_resize_checked(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u16,
        rows: u16,
    ) -> Result<Option<PreparedResize>> {
        let view = self.require_view(view_id, client_id)?;
        if view.attachment_epoch != attachment_epoch {
            bail!("stale attachment epoch");
        }
        self.prepare_resize(
            view_id,
            client_id,
            control_epoch,
            resize_sequence,
            cols,
            rows,
        )
    }

    pub fn prepare_resize(
        &self,
        view_id: &str,
        client_id: &str,
        control_epoch: u64,
        resize_sequence: u64,
        cols: u16,
        rows: u16,
    ) -> Result<Option<PreparedResize>> {
        let authorized = self.controller.as_ref().is_some_and(|controller| {
            controller.view_id == view_id
                && controller.client_id == client_id
                && controller.control_epoch == control_epoch
        });
        if !authorized {
            bail!("stale or unauthorized resize controller");
        }
        let view = self.require_view(view_id, client_id)?;
        if resize_sequence <= view.last_resize_sequence {
            return Ok(None);
        }
        let size_changed = (self.cols, self.rows) != (cols, rows);
        Ok(Some(PreparedResize {
            resize_sequence,
            cols,
            rows,
            layout_epoch: if size_changed {
                self.layout_epoch.saturating_add(1)
            } else {
                self.layout_epoch
            },
            size_changed,
        }))
    }

    pub fn commit_resize(&mut self, view_id: &str, prepared: PreparedResize) {
        let view = self
            .views
            .get_mut(view_id)
            .expect("prepared resize view must remain attached while authority is locked");
        view.last_resize_sequence = prepared.resize_sequence;
        if prepared.size_changed {
            self.cols = prepared.cols;
            self.rows = prepared.rows;
            self.layout_epoch = prepared.layout_epoch;
        }
    }

    pub fn authorize_input(
        &mut self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
        input_sequence: u64,
    ) -> Result<bool> {
        let view = self.require_view_mut(view_id, client_id)?;
        if view.access != ViewAccess::ReadWrite {
            bail!("view is read-only");
        }
        if view.attachment_epoch != attachment_epoch {
            bail!("stale attachment epoch");
        }
        if input_sequence <= view.last_input_sequence {
            return Ok(false);
        }
        view.last_input_sequence = input_sequence;
        Ok(true)
    }

    /// Authorize a read of the terminal by one attachment incarnation: the view
    /// is attached, by `client_id`, at `attachment_epoch`. Unlike
    /// [`ViewAuthority::authorize_input`] a read-only view passes, because a
    /// read is not input, and nothing is recorded, because a read carries no
    /// sequence to deduplicate.
    pub fn authorize_read(
        &self,
        view_id: &str,
        client_id: &str,
        attachment_epoch: u64,
    ) -> Result<()> {
        let view = self.require_view(view_id, client_id)?;
        if view.attachment_epoch != attachment_epoch {
            bail!("stale attachment epoch");
        }
        Ok(())
    }

    pub fn controller(&self) -> Option<&ControllerState> {
        self.controller.as_ref()
    }

    /// Always present, always non-zero. Bumped by claims *and* clears, which
    /// is why `control_epoch` cannot stand in for it: that only advances on
    /// claims, leaving "the controller detached" invisible.
    pub fn control_revision(&self) -> u64 {
        self.control_revision
    }

    pub fn control_snapshot(&self) -> ControlSnapshot {
        ControlSnapshot {
            controller: self.controller.clone(),
            control_revision: self.control_revision,
            cols: self.cols,
            rows: self.rows,
            layout_epoch: self.layout_epoch,
        }
    }

    pub fn attachment_epoch(&self, view_id: &str) -> Option<u64> {
        self.views.get(view_id).map(|view| view.attachment_epoch)
    }

    pub fn layout_epoch(&self) -> u64 {
        self.layout_epoch
    }

    pub fn size(&self) -> (u16, u16) {
        (self.cols, self.rows)
    }

    pub fn has_views(&self) -> bool {
        !self.views.is_empty()
    }

    fn require_view(&self, view_id: &str, client_id: &str) -> Result<&AttachedView> {
        let view = self
            .views
            .get(view_id)
            .ok_or_else(|| anyhow::anyhow!("view is not attached"))?;
        if view.client_id != client_id {
            bail!("view belongs to another client");
        }
        Ok(view)
    }

    fn require_view_mut(&mut self, view_id: &str, client_id: &str) -> Result<&mut AttachedView> {
        let view = self
            .views
            .get_mut(view_id)
            .ok_or_else(|| anyhow::anyhow!("view is not attached"))?;
        if view.client_id != client_id {
            bail!("view belongs to another client");
        }
        Ok(view)
    }
}

#[cfg(test)]
mod tests {
    use std::sync::atomic::{AtomicBool, Ordering};

    use super::*;

    /// An attach attempt on a healthy session, connection 1, no resume
    /// evidence — the shape most of these tests vary one field of.
    fn attempt<'a>(
        view_id: &'a str,
        client_id: &'a str,
        attach_generation: u64,
    ) -> TakeOverRequest<'a> {
        TakeOverRequest {
            view_id,
            client_id,
            access: ViewAccess::ReadWrite,
            attach_generation,
            fence_conn_id: 1,
            session_epoch: 1,
            resume: None,
        }
    }

    #[test]
    fn every_attach_attempt_is_ordered_even_without_resume_evidence() {
        let mut authority = ViewAuthority::new(80, 24);
        let first = authority.take_over(attempt("a", "client", 1)).unwrap();
        assert!(!first.resumed);

        // A retry of a *timed-out initial* attach that actually reached the
        // host. Ordering is what rejects it; there is no resume hint to lean on.
        let stale = authority.take_over(attempt("a", "client", 1)).unwrap_err();
        assert_eq!(stale.code, AttachRejectionCode::StaleResume);

        let second = authority.take_over(attempt("a", "client", 2)).unwrap();
        assert!(second.resumed);
        assert!(second.attachment_epoch > first.attachment_epoch);
        // The superseded incarnation is fenced out of the input path.
        assert!(
            authority
                .authorize_input("a", "client", first.attachment_epoch, 1)
                .is_err()
        );

        // The legacy path is exactly what this replaces: same client, same
        // view id, same epoch handed out twice.
        let mut legacy = ViewAuthority::new(80, 24);
        let once = legacy.attach("a", "client", ViewAccess::ReadWrite).unwrap();
        let twice = legacy.attach("a", "client", ViewAccess::ReadWrite).unwrap();
        assert_eq!(once, twice);
    }

    #[test]
    fn resume_validates_the_session_epoch_before_touching_any_state() {
        let mut authority = ViewAuthority::new(80, 24);
        let rejected = authority
            .take_over(TakeOverRequest {
                attach_generation: 9,
                resume: Some(ResumeEvidence {
                    previous_session_epoch: 4,
                    previous_attachment_epoch: 2,
                    previous_terminal_revision: 77,
                }),
                session_epoch: 5,
                ..attempt("a", "client", 9)
            })
            .unwrap_err();
        assert_eq!(rejected.code, AttachRejectionCode::SessionEpochMismatch);

        // Nothing was mutated: no watermark raised (generation 9 would
        // otherwise fence the whole lineage) and no epoch burned.
        assert_eq!(authority.attach_watermark_count("client"), 0);
        let accepted = authority.take_over(attempt("a", "client", 1)).unwrap();
        assert_eq!(accepted.attachment_epoch, 1);
    }

    #[test]
    fn watermark_gc_waits_for_every_connection_that_could_deliver_an_older_attach() {
        let mut authority = ViewAuthority::new(80, 24);
        // The newest attempt arrives while connection 3 is still open, so the
        // fence is the client's highest connection id, not this attempt's.
        let attached = authority
            .take_over(TakeOverRequest {
                fence_conn_id: 7,
                ..attempt("a", "client", 5)
            })
            .unwrap();
        assert!(authority.detach_view_if_epoch("a", "client", attached.attachment_epoch));

        // Connection 7 is gone but 3 is not. Freeing now would unfence the
        // delayed attach that connection 3 can still deliver.
        assert_eq!(authority.gc_attach_watermarks("client", 2), 0);
        assert_eq!(authority.attach_watermark_count("client"), 1);
        let delayed = authority.take_over(attempt("a", "client", 1)).unwrap_err();
        assert_eq!(delayed.code, AttachRejectionCode::StaleResume);

        // Everything at or below the fence has terminated: the watermark can
        // never be needed again.
        assert_eq!(authority.gc_attach_watermarks("client", 7), 1);
        assert_eq!(authority.attach_watermark_count("client"), 0);
        // And this is precisely the hazard the fence prevents — after GC the
        // same delayed attach reads as a brand-new lineage.
        assert!(authority.take_over(attempt("a", "client", 1)).is_ok());
    }

    #[test]
    fn attested_termination_collects_every_watermark_it_covers() {
        // The leak the 256 cap cannot catch: without a collection path the
        // store only grows, and the first symptom is a spurious view-limit
        // rejection long after the connections were gone.
        let mut authority = ViewAuthority::new(80, 24);
        for index in 0..8 {
            let view_id = format!("view-{index}");
            let attached = authority
                .take_over(TakeOverRequest {
                    fence_conn_id: index + 1,
                    ..attempt(&view_id, "client", 1)
                })
                .unwrap();
            assert!(authority.detach_view_if_epoch(&view_id, "client", attached.attachment_epoch));
        }
        assert_eq!(authority.attach_watermark_count("client"), 8);

        // Connections 1..=4 have terminated; the rest are still fencing.
        assert_eq!(authority.gc_attach_watermarks("client", 4), 4);
        assert_eq!(authority.attach_watermark_count("client"), 4);

        assert_eq!(authority.gc_attach_watermarks("client", 8), 4);
        assert_eq!(
            authority.attach_watermark_count("client"),
            0,
            "attesting every fencing connection terminated must leave nothing behind"
        );
    }

    #[test]
    fn watermarks_of_attached_views_survive_gc() {
        let mut authority = ViewAuthority::new(80, 24);
        authority.take_over(attempt("a", "client", 1)).unwrap();
        assert_eq!(authority.gc_attach_watermarks("client", u64::MAX), 0);
        assert_eq!(authority.attach_watermark_count("client"), 1);
    }

    #[test]
    fn outstanding_watermarks_are_capped_per_client() {
        let mut authority = ViewAuthority::new(80, 24);
        for index in 0..MAX_ATTACH_WATERMARKS_PER_CLIENT {
            let view_id = format!("view-{index}");
            let attached = authority.take_over(attempt(&view_id, "client", 1)).unwrap();
            authority.detach_view_if_epoch(&view_id, "client", attached.attachment_epoch);
        }
        assert_eq!(
            authority.attach_watermark_count("client"),
            MAX_ATTACH_WATERMARKS_PER_CLIENT
        );

        let over = authority.take_over(attempt("one-too-many", "client", 1));
        assert_eq!(
            over.unwrap_err().code,
            AttachRejectionCode::ViewLimit,
            "a new watermark key past the cap must fail safe"
        );
        // An existing lineage needs no new key, so it still advances.
        assert!(authority.take_over(attempt("view-0", "client", 2)).is_ok());
        // The cap is per client: nobody else is starved by one client's views.
        assert!(
            authority
                .take_over(attempt("elsewhere", "other", 1))
                .is_ok()
        );
    }

    #[test]
    fn control_revision_advances_on_claims_and_on_clears() {
        let mut authority = ViewAuthority::new(80, 24);
        // Revisioned authorities start at 1, which keeps 0 free as the
        // "legacy host, unknown" sentinel.
        assert_eq!(authority.control_revision(), 1);
        authority
            .attach("a", "client", ViewAccess::ReadWrite)
            .unwrap();
        authority.claim_control("a", "client", 100, 30).unwrap();
        assert_eq!(authority.control_revision(), 2);

        // The clear is the change `control_epoch` alone cannot report.
        assert!(authority.detach("a", "client"));
        assert!(authority.controller().is_none());
        assert_eq!(authority.control_revision(), 3);
    }

    #[test]
    fn a_claim_expecting_a_superseded_revision_loses_to_an_intervening_clear() {
        let mut authority = ViewAuthority::new(80, 24);
        let a = authority
            .attach("a", "client-a", ViewAccess::ReadWrite)
            .unwrap();
        let b = authority
            .attach("b", "client-b", ViewAccess::ReadWrite)
            .unwrap();
        authority.claim_control("a", "client-a", 100, 30).unwrap();
        let observed = authority.control_revision();

        // "a" gives up control during b's outage. Only the revision records it.
        assert!(authority.detach_view_if_epoch("a", "client-a", a));

        let rejected = authority
            .claim_control_checked("b", "client-b", b, 120, 40, Some(observed))
            .unwrap();
        let ControlClaim::Rejected(state) = rejected else {
            panic!("a claim against a superseded revision must not be granted");
        };
        assert!(state.controller.is_none());
        assert_eq!(state.control_revision, authority.control_revision());
        assert_eq!(
            authority.size(),
            (100, 30),
            "a rejected claim resizes nothing"
        );

        // No controller at a newer revision is retryable, unlike a rejection
        // that shows someone else holding control.
        let granted = authority
            .claim_control_checked("b", "client-b", b, 120, 40, Some(state.control_revision))
            .unwrap();
        assert!(matches!(granted, ControlClaim::Granted(_)));
        assert_eq!(authority.size(), (120, 40));

        // A legacy claim carries no expectation and always wins.
        authority
            .attach("c", "client-c", ViewAccess::ReadWrite)
            .unwrap();
        let legacy = authority
            .claim_control_checked("c", "client-c", 3, 80, 24, None)
            .unwrap();
        assert!(matches!(legacy, ControlClaim::Granted(_)));
    }

    #[test]
    fn takeover_clears_control_held_by_the_previous_incarnation() {
        let mut authority = ViewAuthority::new(80, 24);
        let first = authority.take_over(attempt("a", "client", 1)).unwrap();
        authority.claim_control("a", "client", 100, 30).unwrap();
        assert_eq!(
            authority.controller().unwrap().attachment_epoch,
            first.attachment_epoch
        );

        let second = authority.take_over(attempt("a", "client", 2)).unwrap();
        assert!(second.controller_cleared);
        assert!(authority.controller().is_none());
        assert_eq!(second.control_revision, authority.control_revision());
        assert_eq!(authority.size(), (100, 30), "a takeover keeps the size");
    }

    #[test]
    fn takeover_reports_the_controller_another_view_still_holds() {
        let mut authority = ViewAuthority::new(80, 24);
        let holder = authority.take_over(attempt("b", "client", 1)).unwrap();
        authority.claim_control("b", "client", 100, 30).unwrap();

        // "a" resuming does not disturb b's control, so the attach response
        // has to report it — otherwise the resuming viewer cannot tell "no
        // controller" from "someone else holds it" and races a reclaim.
        let taken = authority.take_over(attempt("a", "client", 1)).unwrap();
        assert!(!taken.controller_cleared);
        let controller = taken.controller.expect("b still holds control");
        assert_eq!(controller.view_id, "b");
        assert_eq!(controller.attachment_epoch, holder.attachment_epoch);
        assert_eq!(taken.control_revision, authority.control_revision());

        // And when the takeover is the thing that cleared it, the composed
        // outcome says so in the same breath.
        let retaken = authority.take_over(attempt("b", "client", 2)).unwrap();
        assert!(retaken.controller_cleared);
        assert!(retaken.controller.is_none());
        assert_eq!(retaken.control_revision, authority.control_revision());
    }

    #[test]
    fn checked_control_and_resize_reject_a_superseded_incarnation() {
        let mut authority = ViewAuthority::new(80, 24);
        let first = authority.take_over(attempt("a", "client", 1)).unwrap();
        authority.claim_control("a", "client", 100, 30).unwrap();
        let second = authority.take_over(attempt("a", "client", 2)).unwrap();

        assert!(
            authority
                .claim_control_checked("a", "client", first.attachment_epoch, 90, 20, None)
                .is_err()
        );

        // The current incarnation reclaims, so the controller once again names
        // this view id — the case where nothing but the attachment epoch
        // separates the live incarnation from the superseded one.
        let reclaimed = authority
            .claim_control_checked("a", "client", second.attachment_epoch, 100, 30, None)
            .unwrap();
        let ControlClaim::Granted(reclaimed) = reclaimed else {
            panic!("the current incarnation must be able to claim control");
        };
        assert!(
            authority
                .authorize_resize_checked(
                    "a",
                    "client",
                    first.attachment_epoch,
                    reclaimed.controller.control_epoch,
                    1,
                    90,
                    20,
                )
                .is_err(),
            "a superseded incarnation must not resize even with the live control epoch"
        );
        assert_eq!(authority.size(), (100, 30));
        assert!(
            authority
                .authorize_resize_checked(
                    "a",
                    "client",
                    second.attachment_epoch,
                    reclaimed.controller.control_epoch,
                    1,
                    101,
                    31,
                )
                .unwrap()
        );
    }

    #[test]
    fn state_stream_registration_is_epoch_checked_and_cancelled_by_takeover() {
        let mut authority = ViewAuthority::new(80, 24);
        let first = authority.take_over(attempt("a", "client", 1)).unwrap();
        let cancelled = Arc::new(AtomicBool::new(false));
        let flag = Arc::clone(&cancelled);
        authority
            .register_state_stream(
                "a",
                first.attachment_epoch,
                StateStreamCancel::new(move || flag.store(true, Ordering::SeqCst)),
            )
            .unwrap();

        let second = authority.take_over(attempt("a", "client", 2)).unwrap();
        assert!(
            cancelled.load(Ordering::SeqCst),
            "takeover must fire the previous incarnation's cancel handle"
        );

        // The other half of the race: a handler that was still between its
        // attach and its registration when the takeover landed.
        assert!(
            authority
                .register_state_stream("a", first.attachment_epoch, StateStreamCancel::new(|| ()),)
                .is_err()
        );
        assert!(
            authority
                .register_state_stream("a", second.attachment_epoch, StateStreamCancel::new(|| ()),)
                .is_ok()
        );
    }

    #[test]
    fn epoch_conditional_detach_spares_the_incarnation_that_replaced_it() {
        let mut authority = ViewAuthority::new(80, 24);
        let first = authority.take_over(attempt("a", "client", 1)).unwrap();
        let second = authority.take_over(attempt("a", "client", 2)).unwrap();

        // The old connection's death handler, arriving late.
        assert!(!authority.detach_view_if_epoch("a", "client", first.attachment_epoch));
        assert_eq!(
            authority.attachment_epoch("a"),
            Some(second.attachment_epoch)
        );
        assert!(authority.detach_view_if_epoch("a", "client", second.attachment_epoch));
        assert!(authority.attachment_epoch("a").is_none());
    }

    #[test]
    fn a_view_held_by_another_client_is_not_takeable() {
        let mut authority = ViewAuthority::new(80, 24);
        authority.take_over(attempt("a", "client", 1)).unwrap();
        let rejected = authority.take_over(attempt("a", "other", 1)).unwrap_err();
        assert_eq!(rejected.code, AttachRejectionCode::ViewInvalid);
        assert_eq!(
            authority.attach_watermark_count("other"),
            0,
            "a rejected attempt must not raise a watermark"
        );
    }

    #[test]
    fn last_authority_processed_claim_wins_and_stale_resize_fails() {
        let mut authority = ViewAuthority::new(80, 24);
        authority
            .attach("a", "client-a", ViewAccess::ReadWrite)
            .unwrap();
        authority
            .attach("b", "client-b", ViewAccess::ReadWrite)
            .unwrap();
        let a = authority.claim_control("a", "client-a", 100, 30).unwrap();
        let b = authority.claim_control("b", "client-b", 120, 40).unwrap();
        assert!(b.controller.control_epoch > a.controller.control_epoch);
        assert!(
            authority
                .authorize_resize("a", "client-a", a.controller.control_epoch, 1, 90, 20)
                .is_err()
        );
        assert_eq!(authority.size(), (120, 40));
        let reclaimed = authority.claim_control("a", "client-a", 100, 30).unwrap();
        assert!(
            authority
                .authorize_resize(
                    "a",
                    "client-a",
                    reclaimed.controller.control_epoch,
                    1,
                    101,
                    31,
                )
                .unwrap()
        );
    }

    #[test]
    fn input_is_deduplicated_per_attachment() {
        let mut authority = ViewAuthority::new(80, 24);
        let epoch = authority
            .attach("a", "client", ViewAccess::ReadWrite)
            .unwrap();
        assert!(authority.authorize_input("a", "client", epoch, 1).unwrap());
        assert!(!authority.authorize_input("a", "client", epoch, 1).unwrap());
        assert!(
            authority
                .authorize_input("a", "client", epoch + 1, 2)
                .is_err()
        );
    }

    #[test]
    fn a_read_is_fenced_on_the_attachment_and_open_to_a_read_only_view() {
        let mut authority = ViewAuthority::new(80, 24);
        let first = authority
            .take_over(attempt("a", "client", 1))
            .unwrap()
            .attachment_epoch;
        assert!(authority.authorize_read("a", "client", first).is_ok());
        assert!(authority.authorize_read("a", "other", first).is_err());
        assert!(authority.authorize_read("b", "client", first).is_err());

        // A takeover supersedes the incarnation that read, and the epoch is
        // all that separates the two.
        let second = authority
            .take_over(attempt("a", "client", 2))
            .unwrap()
            .attachment_epoch;
        assert!(
            authority.authorize_read("a", "client", first).is_err(),
            "a superseded incarnation must not read"
        );
        assert!(authority.authorize_read("a", "client", second).is_ok());

        assert!(authority.detach_view_if_epoch("a", "client", second));
        assert!(
            authority.authorize_read("a", "client", second).is_err(),
            "a detached view must not read"
        );

        // A selection is a read, not input: a read-only view may read.
        let watching = authority
            .attach("w", "viewer", ViewAccess::ReadOnly)
            .unwrap();
        assert!(authority.authorize_read("w", "viewer", watching).is_ok());
        assert!(
            authority
                .authorize_input("w", "viewer", watching, 1)
                .is_err()
        );
    }

    #[test]
    fn detaching_controller_keeps_size_and_clears_controller() {
        let mut authority = ViewAuthority::new(80, 24);
        authority
            .attach("a", "client", ViewAccess::ReadWrite)
            .unwrap();
        authority.claim_control("a", "client", 100, 30).unwrap();
        assert!(authority.detach("a", "client"));
        assert!(authority.controller().is_none());
        assert_eq!(authority.size(), (100, 30));
    }
}
