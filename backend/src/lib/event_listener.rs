use chrono::{DateTime, Local};
use lazy_static::lazy_static;
use monad_event_ring::{
    DecodedEventRing, EventDescriptor, EventDescriptorInfo, EventNextResult, EventPayloadResult,
    EventRingPath,
};
use monad_exec_events::ExecEvent;
use monad_exec_events::{
    ffi::{g_monad_exec_event_metadata, MONAD_EXEC_EVENT_COUNT},
    ExecEventDecoder, ExecEventDescriptorExt, ExecEventRing, ExecSnapshotEventRing,
};
use serde::{Deserialize, Serialize};
use std::{ffi::CStr, time::Duration};
use tracing::{debug, error, info, warn};

lazy_static! {
    static ref EXEC_EVENT_NAMES: [&'static str; MONAD_EXEC_EVENT_COUNT] =
        std::array::from_fn(|event_type| unsafe {
            CStr::from_ptr(g_monad_exec_event_metadata[event_type].c_name)
                .to_str()
                .unwrap()
        });
}

/// Type-safe enum for event names based on ExecEvent variants
#[derive(Debug, Clone, Copy, PartialEq, Eq, Hash, Serialize, Deserialize)]
#[serde(rename_all = "PascalCase")]
pub enum EventName {
    RecordError,
    BlockStart,
    BlockReject,
    BlockPerfEvmEnter,
    BlockPerfEvmExit,
    BlockEnd,
    BlockQC,
    BlockFinalized,
    BlockVerified,
    TxnHeaderStart,
    TxnAccessListEntry,
    TxnAuthListEntry,
    TxnHeaderEnd,
    TxnReject,
    TxnPerfEvmEnter,
    TxnPerfEvmExit,
    TxnEvmOutput,
    TxnLog,
    TxnCallFrame,
    TxnEnd,
    AccountAccessListHeader,
    AccountAccess,
    StorageAccess,
    EvmError,
    NativeTransfer,
}

impl EventName {
    /// Convert EventName to string representation
    pub fn as_str(&self) -> &'static str {
        match self {
            EventName::RecordError => "RecordError",
            EventName::BlockStart => "BlockStart",
            EventName::BlockReject => "BlockReject",
            EventName::BlockPerfEvmEnter => "BlockPerfEvmEnter",
            EventName::BlockPerfEvmExit => "BlockPerfEvmExit",
            EventName::BlockEnd => "BlockEnd",
            EventName::BlockQC => "BlockQC",
            EventName::BlockFinalized => "BlockFinalized",
            EventName::BlockVerified => "BlockVerified",
            EventName::TxnHeaderStart => "TxnHeaderStart",
            EventName::TxnAccessListEntry => "TxnAccessListEntry",
            EventName::TxnAuthListEntry => "TxnAuthListEntry",
            EventName::TxnHeaderEnd => "TxnHeaderEnd",
            EventName::TxnReject => "TxnReject",
            EventName::TxnPerfEvmEnter => "TxnPerfEvmEnter",
            EventName::TxnPerfEvmExit => "TxnPerfEvmExit",
            EventName::TxnEvmOutput => "TxnEvmOutput",
            EventName::TxnLog => "TxnLog",
            EventName::TxnCallFrame => "TxnCallFrame",
            EventName::TxnEnd => "TxnEnd",
            EventName::AccountAccessListHeader => "AccountAccessListHeader",
            EventName::AccountAccess => "AccountAccess",
            EventName::StorageAccess => "StorageAccess",
            EventName::EvmError => "EvmError",
            EventName::NativeTransfer => "NativeTransfer",
        }
    }

    pub fn from_name(s: &str) -> Option<Self> {
        match s {
            "RECORD_ERROR" => Some(EventName::RecordError),
            "BLOCK_START" => Some(EventName::BlockStart),
            "BLOCK_REJECT" => Some(EventName::BlockReject),
            "BLOCK_PERF_EVM_ENTER" => Some(EventName::BlockPerfEvmEnter),
            "BLOCK_PERF_EVM_EXIT" => Some(EventName::BlockPerfEvmExit),
            "BLOCK_END" => Some(EventName::BlockEnd),
            "BLOCK_QC" => Some(EventName::BlockQC),
            "BLOCK_FINALIZED" => Some(EventName::BlockFinalized),
            "BLOCK_VERIFIED" => Some(EventName::BlockVerified),
            "TXN_HEADER_START" => Some(EventName::TxnHeaderStart),
            "TXN_ACCESS_LIST_ENTRY" => Some(EventName::TxnAccessListEntry),
            "TXN_AUTH_LIST_ENTRY" => Some(EventName::TxnAuthListEntry),
            "TXN_HEADER_END" => Some(EventName::TxnHeaderEnd),
            "TXN_REJECT" => Some(EventName::TxnReject),
            "TXN_PERF_EVM_ENTER" => Some(EventName::TxnPerfEvmEnter),
            "TXN_PERF_EVM_EXIT" => Some(EventName::TxnPerfEvmExit),
            "TXN_EVM_OUTPUT" => Some(EventName::TxnEvmOutput),
            "TXN_LOG" => Some(EventName::TxnLog),
            "TXN_CALL_FRAME" => Some(EventName::TxnCallFrame),
            "TXN_END" => Some(EventName::TxnEnd),
            "ACCOUNT_ACCESS_LIST_HEADER" => Some(EventName::AccountAccessListHeader),
            "ACCOUNT_ACCESS" => Some(EventName::AccountAccess),
            "STORAGE_ACCESS" => Some(EventName::StorageAccess),
            "EVM_ERROR" => Some(EventName::EvmError),
            _ => {
                warn!("Unknown event name: {}", s);
                None
            }
        }
    }
}

#[derive(Debug, Clone)]
pub struct EventData {
    pub timestamp_ns: u64,
    pub event_name: EventName,
    pub seqno: u64,
    pub block_number: Option<u64>,
    pub txn_idx: Option<usize>,
    pub txn_hash: Option<[u8; 32]>,
    pub payload: ExecEvent,
}

enum OpenEventRing {
    Live(ExecEventRing),
    Snapshot(ExecSnapshotEventRing),
}

impl OpenEventRing {
    fn new(event_ring_path: EventRingPath) -> Result<Self, String> {
        if event_ring_path.is_snapshot_file()? {
            let snapshot = ExecSnapshotEventRing::new_from_zstd_path(event_ring_path, None)?;
            Ok(OpenEventRing::Snapshot(snapshot))
        } else {
            let live = ExecEventRing::new(event_ring_path)?;
            Ok(OpenEventRing::Live(live))
        }
    }
}

/// Convert event descriptor to EventData struct
fn event_to_data(event: &EventDescriptor<ExecEventDecoder>) -> Option<EventData> {
    let EventDescriptorInfo {
        seqno,
        event_type,
        record_epoch_nanos,
        flow_info,
    } = event.info();
    
    // Convert event_type to EventName enum for type safety
    let event_name = EventName::from_name(EXEC_EVENT_NAMES[event_type as usize])?;

    // Get block number if present
    let block_number = if flow_info.block_seqno != 0 {
        event.get_block_number()
    } else {
        None
    };

    // Get transaction index if present
    let txn_idx = flow_info.txn_idx;

    // Try to read the payload
    let payload = match event.try_read() {
        EventPayloadResult::Expired => {
            error!("Payload expired for event seqno {}", seqno);
            return None;
        }
        EventPayloadResult::Ready(exec_event) => exec_event,
    };

    Some(EventData {
        timestamp_ns: record_epoch_nanos,
        event_name,
        seqno,
        block_number,
        txn_idx,
        txn_hash: None, // Will be populated by server when tracking TxnHeaderStart
        payload,
    })
}

pub fn run_event_listener(
    event_ring_path: EventRingPath,
    event_sender: tokio::sync::mpsc::Sender<EventData>,
) -> std::thread::JoinHandle<()> {
    std::thread::spawn(move || {
        info!("Starting event listener thread");

        // Try to open the event ring file
        let event_ring = match OpenEventRing::new(event_ring_path) {
            Ok(ring) => {
                info!("Successfully opened event ring");
                ring
            }
            Err(e) => {
                error!("Failed to open event ring: {}", e);
                return;
            }
        };

        let is_live = matches!(event_ring, OpenEventRing::Live(_));
        info!(
            "Event ring type: {}",
            if is_live { "Live" } else { "Snapshot" }
        );

        let mut event_reader = match event_ring {
            OpenEventRing::Live(ref live) => {
                let mut event_reader = live.create_reader();
                // Skip all buffered events by consuming them without processing
                info!("Skipping buffered events to reach latest position...");
                let mut skipped = 0;
                loop {
                    match event_reader.next_descriptor() {
                        EventNextResult::Ready(_) => {
                            skipped += 1;
                        }
                        EventNextResult::NotReady => {
                            info!(
                                "Skipped {} buffered events, now at latest position",
                                skipped
                            );
                            break;
                        }
                        EventNextResult::Gap => {
                            warn!("Gap while skipping buffered events");
                            event_reader.reset();
                        }
                    }
                }
                event_reader
            }
            OpenEventRing::Snapshot(ref snapshot) => snapshot.create_reader(),
        };

        let mut last_event_timestamp_ns: Option<u64> = None;
        let mut event_count: u64 = 0;
        info!("Entering event processing loop...");

        let mut last_dead_log_instant = std::time::Instant::now();
        // Event processing loop
        loop {
            match event_reader.next_descriptor() {
                EventNextResult::Gap => {
                    error!("Event sequence number gap occurred!");
                    event_reader.reset();
                    continue;
                }
                EventNextResult::NotReady => {
                    match event_ring {
                        OpenEventRing::Snapshot(_) => {
                            // Snapshot finished, exit thread
                            info!("Snapshot replay complete");
                            return;
                        }
                        OpenEventRing::Live(_) => {
                            // Only check for dead ring if we've received at least one event
                            if let Some(last_ts) = last_event_timestamp_ns {
                                let now = Local::now();
                                let last_event_time =
                                    DateTime::from_timestamp_nanos(last_ts as i64);
                                let seconds_since_last_event = now.signed_duration_since(last_event_time).num_seconds();
                                if seconds_since_last_event > 5 && last_dead_log_instant.elapsed().as_secs() > 5 {
                                    warn!("Event ring appears dead - {} seconds since last event", seconds_since_last_event);
                                    last_dead_log_instant = std::time::Instant::now();
                                }
                            }
                            std::thread::sleep(Duration::from_micros(100));
                        }
                    }
                    continue;
                }
                EventNextResult::Ready(event) => {
                    last_event_timestamp_ns = Some(event.info().record_epoch_nanos);
                    event_count += 1;

                    if event_count.is_multiple_of(100) {
                        debug!("Processed {} events", event_count);
                    }

                    if let Some(event_data) = event_to_data(&event) {
                        // Send to channel; if receiver is dropped, exit thread
                        // Use blocking_send since we're in a blocking thread
                        if event_sender.blocking_send(event_data).is_err() {
                            warn!("Channel receiver dropped, exiting listener thread");
                            return;
                        }
                    } else {
                        event_reader.reset(); // Payload expired
                    }
                }
            };
        }
    })
}
