use std::collections::HashMap;

/// Tracks the in-flight transaction hash for each `txn_idx` within the current block.
///
/// Backed by a map rather than a fixed-size buffer: `txn_idx` comes straight off the
/// event ring with no upper bound, so a fixed-capacity buffer indexed directly by
/// `txn_idx` would panic on any block with more transactions than the buffer's capacity.
#[derive(Default)]
pub struct TxnHashTracker {
    hashes: HashMap<usize, [u8; 32]>,
}

impl TxnHashTracker {
    pub fn new() -> Self {
        Self::default()
    }

    /// Record the hash for a transaction that just started.
    pub fn record(&mut self, txn_idx: usize, hash: [u8; 32]) {
        self.hashes.insert(txn_idx, hash);
    }

    /// Look up the hash for a transaction, if one is currently tracked.
    pub fn get(&self, txn_idx: usize) -> Option<[u8; 32]> {
        self.hashes.get(&txn_idx).copied()
    }

    /// Stop tracking a transaction once it has ended.
    pub fn clear(&mut self, txn_idx: usize) {
        self.hashes.remove(&txn_idx);
    }

    /// Drop all tracked hashes.
    ///
    /// `txn_idx` is scoped to a single block, so nothing left over from a
    /// previous block is ever valid to keep. Call this on `BlockStart` so a
    /// missed `TxnEnd` (e.g. from an event-ring gap) can't leave an orphaned
    /// entry retained for the forwarder's lifetime.
    pub fn reset(&mut self) {
        self.hashes.clear();
    }
}

#[cfg(test)]
mod tests {
    use super::*;

    #[test]
    fn record_then_get_returns_the_hash() {
        let mut tracker = TxnHashTracker::new();
        let hash = [7u8; 32];

        tracker.record(3, hash);

        assert_eq!(tracker.get(3), Some(hash));
    }

    #[test]
    fn get_on_unknown_index_returns_none() {
        let tracker = TxnHashTracker::new();

        assert_eq!(tracker.get(3), None);
    }

    #[test]
    fn clear_removes_the_tracked_hash() {
        let mut tracker = TxnHashTracker::new();
        tracker.record(3, [7u8; 32]);

        tracker.clear(3);

        assert_eq!(tracker.get(3), None);
    }

    /// The bug this struct fixes: the old code stored hashes in a `Vec` fixed at
    /// 10_000 entries and indexed it directly with `txn_idx`, which panics on any
    /// index at or beyond that capacity. A `HashMap` has no such ceiling.
    #[test]
    fn handles_txn_idx_far_beyond_the_old_fixed_capacity_of_10_000() {
        let mut tracker = TxnHashTracker::new();
        let hash = [9u8; 32];
        let large_idx = 50_000;

        tracker.record(large_idx, hash);

        assert_eq!(tracker.get(large_idx), Some(hash));

        tracker.clear(large_idx);
        assert_eq!(tracker.get(large_idx), None);
    }

    #[test]
    fn re_recording_the_same_index_overwrites_the_previous_hash() {
        let mut tracker = TxnHashTracker::new();
        tracker.record(1, [1u8; 32]);
        tracker.record(1, [2u8; 32]);

        assert_eq!(tracker.get(1), Some([2u8; 32]));
    }

    /// Covers the orphaned-entry case: a `TxnEnd` can be missed (e.g. the event-ring
    /// reader hits a gap and resets), leaving `clear` never called for that txn_idx.
    /// `reset` is the backstop that bounds memory regardless, by dropping everything
    /// at the start of the next block.
    #[test]
    fn reset_drops_entries_never_cleared_by_a_missed_txn_end() {
        let mut tracker = TxnHashTracker::new();
        tracker.record(1, [1u8; 32]);
        tracker.record(2, [2u8; 32]);
        // txn_idx 2's TxnEnd is "missed" - no clear(2) call.
        tracker.clear(1);

        tracker.reset();

        assert_eq!(tracker.get(1), None);
        assert_eq!(tracker.get(2), None);
    }
}
