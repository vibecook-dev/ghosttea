use std::sync::{Condvar, Mutex};

/// The most a draining queue holds for a writer that cannot write. Draining
/// producers no longer wait for capacity, so this is what bounds the batch
/// instead; it can only bite while the PTY's peer has stopped reading. Terminal
/// replies are a few bytes each.
const DRAIN_CAP_BYTES: usize = 64 * 1024;

/// One queued batch plus the writer's in-flight batch. Slow PTY readers apply
/// backpressure after model publication, never while a model lock is held.
///
/// Termination stops that waiting, never the delivery. The terminal may itself
/// be waiting on an answer: ConPTY asks for the cursor position as it starts
/// and waits for the reply. So a draining queue takes every later reply into
/// the pending batch, in model order, and only the session's conclusion or a
/// failed writer closes it.
#[derive(Default)]
pub(super) struct ReplyQueue {
    state: Mutex<State>,
    changed: Condvar,
}

#[derive(Default)]
struct State {
    pending: Option<Vec<u8>>,
    next_ticket: u64,
    next_send: u64,
    draining: bool,
    /// Set by the first reply a draining batch drops, cleared when the writer
    /// takes the batch.
    overflowed: bool,
    closed: bool,
}

#[must_use]
pub(super) struct Reply {
    ticket: u64,
    bytes: Vec<u8>,
}

/// What `send` did with a reply.
#[must_use]
#[derive(Debug, PartialEq, Eq)]
pub(super) enum Sent {
    /// It joins the batch the writer delivers next.
    Queued,
    /// The session concluded, so nothing is delivered any more.
    Closed,
    /// Dropped because a draining batch overflowed its cap. Once one reply is
    /// dropped, every later one is too until the writer takes the batch, so a
    /// batch never skips a reply and then carries a later one: a program that
    /// pairs one answer with the next never reads a wrong pair.
    /// `overflow_began` marks the drop that began the overflow.
    Dropped { bytes: usize, overflow_began: bool },
}

impl ReplyQueue {
    /// Called under model_operation so responses retain model order even if a
    /// later caller reaches send first after releasing that lock.
    pub(super) fn prepare(&self, bytes: Vec<u8>) -> Reply {
        let mut state = self.state.lock().unwrap();
        let ticket = state.next_ticket;
        state.next_ticket = ticket
            .checked_add(1)
            .expect("terminal reply ticket overflow");
        Reply { ticket, bytes }
    }

    /// The caller must release all model locks before waiting. A producer waits
    /// for its turn, and outside drain mode also for capacity.
    pub(super) fn send(&self, reply: Reply) -> Sent {
        let mut state = self.state.lock().unwrap();
        while !state.closed
            && (reply.ticket != state.next_send || (!state.draining && state.pending.is_some()))
        {
            state = self.changed.wait(state).unwrap();
        }
        if state.closed {
            return Sent::Closed;
        }
        state.next_send += 1;
        let bytes = reply.bytes.len();
        let held = state.pending.as_ref().map(Vec::len);
        let sent = match held {
            None => {
                state.pending = Some(reply.bytes);
                Sent::Queued
            }
            Some(_) if state.overflowed => Sent::Dropped {
                bytes,
                overflow_began: false,
            },
            Some(held) if held + bytes <= DRAIN_CAP_BYTES => {
                if let Some(pending) = state.pending.as_mut() {
                    pending.extend_from_slice(&reply.bytes);
                }
                Sent::Queued
            }
            Some(_) => {
                state.overflowed = true;
                Sent::Dropped {
                    bytes,
                    overflow_began: true,
                }
            }
        };
        self.changed.notify_all();
        sent
    }

    /// Returns `None` once the queue is closed and the batch it held is taken.
    pub(super) fn recv(&self) -> Option<Vec<u8>> {
        let mut state = self.state.lock().unwrap();
        while !state.closed && state.pending.is_none() {
            state = self.changed.wait(state).unwrap();
        }
        let bytes = state.pending.take();
        state.overflowed = false;
        self.changed.notify_all();
        bytes
    }

    /// Termination: producers stop waiting for capacity, including one already
    /// parked behind a blocked PTY write. Their replies still reach the writer.
    pub(super) fn stop_waiting(&self) {
        let mut state = self.state.lock().unwrap();
        state.draining = true;
        self.changed.notify_all();
    }

    /// The session concluded or its writer failed. Producers return at once,
    /// and a batch already queued stays for the writer to finish.
    pub(super) fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        self.changed.notify_all();
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use std::sync::{Arc, mpsc};
    use std::thread;
    use std::time::Duration;

    #[test]
    fn preserves_model_order_when_producers_arrive_out_of_order() {
        let queue = Arc::new(ReplyQueue::default());
        let first = queue.prepare(b"first".to_vec());
        let second = queue.prepare(b"second".to_vec());
        let later = {
            let queue = queue.clone();
            thread::spawn(move || queue.send(second))
        };
        assert_eq!(queue.send(first), Sent::Queued);
        assert_eq!(queue.recv(), Some(b"first".to_vec()));
        assert_eq!(queue.recv(), Some(b"second".to_vec()));
        assert_eq!(later.join().unwrap(), Sent::Queued);
        queue.close();
        assert_eq!(queue.recv(), None);
    }

    #[test]
    fn closing_a_full_queue_releases_waiting_producers() {
        let queue = Arc::new(ReplyQueue::default());
        assert_eq!(queue.send(queue.prepare(b"queued".to_vec())), Sent::Queued);
        let reply = queue.prepare(b"waiting".to_vec());
        let (done, received) = mpsc::channel();
        let sender = {
            let queue = queue.clone();
            thread::spawn(move || done.send(queue.send(reply)).unwrap())
        };
        assert!(received.recv_timeout(Duration::from_millis(20)).is_err());
        queue.close();
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            Sent::Closed
        );
        sender.join().unwrap();
        // The batch queued before the close is still the writer's to finish;
        // the released producer's reply is not.
        assert_eq!(queue.recv(), Some(b"queued".to_vec()));
        assert_eq!(queue.recv(), None);
    }

    #[test]
    fn draining_releases_a_parked_producer_into_the_batch_in_order() {
        let queue = Arc::new(ReplyQueue::default());
        assert_eq!(queue.send(queue.prepare(b"queued".to_vec())), Sent::Queued);
        let reply = queue.prepare(b"parked".to_vec());
        let (done, received) = mpsc::channel();
        let sender = {
            let queue = queue.clone();
            thread::spawn(move || done.send(queue.send(reply)).unwrap())
        };
        assert!(received.recv_timeout(Duration::from_millis(20)).is_err());
        queue.stop_waiting();
        assert_eq!(
            received.recv_timeout(Duration::from_secs(5)).unwrap(),
            Sent::Queued
        );
        sender.join().unwrap();
        // A later reply joins the same batch without waiting for capacity.
        assert_eq!(queue.send(queue.prepare(b"later".to_vec())), Sent::Queued);
        assert_eq!(queue.recv(), Some(b"queuedparkedlater".to_vec()));
        queue.close();
        assert_eq!(queue.recv(), None);
    }

    #[test]
    fn a_draining_batch_drops_past_its_cap_and_never_leaves_a_gap() {
        let queue = ReplyQueue::default();
        queue.stop_waiting();
        let filler = vec![b'x'; DRAIN_CAP_BYTES - 4];
        assert_eq!(queue.send(queue.prepare(filler)), Sent::Queued);
        assert_eq!(queue.send(queue.prepare(b"abc".to_vec())), Sent::Queued);
        assert_eq!(
            queue.send(queue.prepare(b"over".to_vec())),
            Sent::Dropped {
                bytes: 4,
                overflow_began: true
            }
        );
        // "z" would fit, but the batch must not skip "over" and then carry it.
        assert_eq!(
            queue.send(queue.prepare(b"z".to_vec())),
            Sent::Dropped {
                bytes: 1,
                overflow_began: false
            }
        );
        let batch = queue.recv().unwrap();
        assert_eq!(batch.len(), DRAIN_CAP_BYTES - 1);
        assert!(batch.ends_with(b"abc"));
        // The writer took the batch, so the cap starts over.
        assert_eq!(queue.send(queue.prepare(b"next".to_vec())), Sent::Queued);
        assert_eq!(queue.recv(), Some(b"next".to_vec()));
    }
}
