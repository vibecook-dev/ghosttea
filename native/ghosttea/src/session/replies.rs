use std::sync::{Condvar, Mutex};

/// One queued batch plus the writer's in-flight batch. Slow PTY readers apply
/// backpressure after model publication, never while a model lock is held.
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
    closed: bool,
}

#[must_use]
pub(super) struct Reply {
    ticket: u64,
    bytes: Vec<u8>,
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

    /// The caller must release all model locks before waiting for capacity.
    pub(super) fn send(&self, reply: Reply) {
        let mut state = self.state.lock().unwrap();
        while !state.closed && (reply.ticket != state.next_send || state.pending.is_some()) {
            state = self.changed.wait(state).unwrap();
        }
        if state.closed {
            return;
        }
        state.pending = Some(reply.bytes);
        state.next_send += 1;
        self.changed.notify_all();
    }

    pub(super) fn recv(&self) -> Option<Vec<u8>> {
        let mut state = self.state.lock().unwrap();
        while !state.closed && state.pending.is_none() {
            state = self.changed.wait(state).unwrap();
        }
        let bytes = state.pending.take();
        self.changed.notify_all();
        bytes
    }

    /// Termination or a failed transport cancels producers as well as the
    /// consumer, including a producer parked behind a blocked PTY write.
    pub(super) fn close(&self) {
        let mut state = self.state.lock().unwrap();
        state.closed = true;
        state.pending = None;
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
        queue.send(first);
        assert_eq!(queue.recv(), Some(b"first".to_vec()));
        assert_eq!(queue.recv(), Some(b"second".to_vec()));
        later.join().unwrap();
        queue.close();
        assert_eq!(queue.recv(), None);
    }

    #[test]
    fn closing_a_full_queue_releases_waiting_producers() {
        let queue = Arc::new(ReplyQueue::default());
        queue.send(queue.prepare(b"queued".to_vec()));
        let reply = queue.prepare(b"waiting".to_vec());
        let (done, received) = mpsc::channel();
        let sender = {
            let queue = queue.clone();
            thread::spawn(move || {
                queue.send(reply);
                done.send(()).unwrap();
            })
        };
        assert!(received.recv_timeout(Duration::from_millis(20)).is_err());
        queue.close();
        received.recv_timeout(Duration::from_secs(5)).unwrap();
        sender.join().unwrap();
        assert_eq!(queue.recv(), None);
    }
}
