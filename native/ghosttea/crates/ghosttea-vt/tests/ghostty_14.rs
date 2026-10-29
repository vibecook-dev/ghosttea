use ghosttea_vt::GhosttyTerminalCore;
#[test]
fn kitty_clipboard_write_replies_synchronously() {
    let mut t = GhosttyTerminalCore::new(80, 24, 1_000_000).unwrap();
    t.feed(b"\x1b]5522;type=write:id=q1\x1b\\\x1b]5522;type=wdata:mime=dGV4dC9wbGFpbg==;aGVsbG8=\x1b\\\x1b]5522;type=wdata\x1b\\");
    let snapshot = t.snapshot().unwrap();
    assert_eq!(snapshot.clipboard, Some(b"hello".to_vec()));
    assert_eq!(
        snapshot.pty_response,
        b"\x1b]5522;type=write:status=DONE:id=q1\x1b\\"
    );
}
#[test]
fn unsupported_atomic_clipboard_request_is_not_partially_committed() {
    let mut t = GhosttyTerminalCore::new(80, 24, 1_000_000).unwrap();
    t.feed(b"\x1b]5522;type=write:id=q2\x1b\\\x1b]5522;type=wdata:mime=dGV4dC9wbGFpbg==;aGVsbG8=\x1b\\\x1b]5522;type=wdata:mime=dGV4dC9odG1s;PGI+aGk8L2I+\x1b\\\x1b]5522;type=wdata\x1b\\");
    let snapshot = t.snapshot().unwrap();
    assert_eq!(snapshot.clipboard, None);
    assert_eq!(
        snapshot.pty_response,
        b"\x1b]5522;type=write:status=ENOSYS:id=q2\x1b\\"
    );
}
#[test]
fn resize_repairs_live_pending_wrap_before_next_character() {
    let mut t = GhosttyTerminalCore::new(10, 4, 1_000_000).unwrap();
    t.feed(b"123456789|");
    assert!(t.pending_wrap().unwrap());
    t.resize(8, 4).unwrap();
    t.feed(b"X");
    let snapshot = t.snapshot().unwrap();
    assert_eq!(snapshot.rows[0], "12345678");
    assert_eq!(snapshot.rows[1], "9|X");
    assert_eq!((snapshot.cursor.x, snapshot.cursor.y), (3, 1));
}
#[test]
fn cancelled_osc_does_not_publish_a_title() {
    let mut t = GhosttyTerminalCore::new(80, 24, 1_000_000).unwrap();
    t.feed(b"before\x1b]2;discard\x18after");
    let snapshot = t.snapshot().unwrap();
    assert_eq!(snapshot.title, None);
    assert_eq!(snapshot.rows[0], "beforeafter");
}
