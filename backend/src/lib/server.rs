use std::net::SocketAddr;
use std::sync::atomic::{AtomicU64, Ordering};
use std::sync::Arc;
use std::time::{SystemTime, UNIX_EPOCH};

use alloy_primitives::{Address, B256};
use http_body_util::Full;
use hyper::body::Bytes;
use hyper::server::conn::http1;
use hyper::service::service_fn;
use hyper::{Request, Response, StatusCode};
use futures_util::stream::SplitSink;
use futures_util::{stream::SplitStream, SinkExt, StreamExt};
use monad_exec_events::ExecEvent;
use tokio::net::{TcpListener, TcpStream};
use tokio::sync::broadcast;
use tokio_tungstenite::{accept_async, tungstenite::Message, WebSocketStream};
use tracing::{error, info, warn};
use serde::{Deserialize, Serialize};

use crate::event_filter::{is_restricted_mode, load_restricted_filters};
use crate::event_listener::EventName;
use crate::top_k_tracker::{AccessEntry, TopKTracker};

use super::event_filter::EventFilter;
use super::event_listener::EventData;
use super::serializable_event::SerializableEventData;

/// Stores the Unix timestamp (in seconds) of the last event received from the ring
type LastEventTime = Arc<AtomicU64>;

/// Seconds without events before health check reports unhealthy
const UNHEALTHY_THRESHOLD_SECS: u64 = 10;

/// Seconds without events before triggering process exit
const EXIT_THRESHOLD_SECS: u64 = 30;

#[derive(Debug, Clone, Serialize, Deserialize)]
pub struct TopAccessesData {
    pub account: Vec<AccessEntry<Address>>,
    pub storage: Vec<AccessEntry<(Address, B256)>>,
}

#[derive(Debug, Clone)]
pub enum EventDataOrMetrics {
    Event(Box<EventData>),
    TopAccesses(TopAccessesData),
    TPS(usize)
}

#[derive(Debug, Clone, Serialize, Deserialize)]
pub enum ServerMessage {
    Events(Vec<SerializableEventData>),
    TopAccesses(TopAccessesData),
    TPS(usize),
}

#[derive(Default)]
struct TPSTracker {
    block_1_txs: usize,
    block_2_txs: usize,
    block_3_txs: usize,
    current_tx_count: usize,
}

impl TPSTracker {
    pub fn new() -> Self {
        Self::default()
    }

    pub fn record_tx(&mut self) {
        self.current_tx_count += 1;
    }

    /// Calculates the TPS over an effective window of 2.5 blocks.
    /// The formula sums the transaction counts of the two most recent full blocks and half of the newest (partial) block.
    /// This is because average block time is approximately 400ms; summing 2.5 blocks provides a close approximation of one second.
    pub fn get_tps(&mut self) -> usize {
        self.block_1_txs = self.block_2_txs;
        self.block_2_txs = self.block_3_txs;
        self.block_3_txs = self.current_tx_count;
        self.current_tx_count = 0;
        self.block_1_txs + self.block_2_txs + (self.block_3_txs / 2)
    }
}


// Helper function to process events into buffers
fn process_event(
    event: EventDataOrMetrics,
    filter: &EventFilter,
    events_buf: &mut Vec<SerializableEventData>,
    accesses_buf: &mut Vec<TopAccessesData>,
    tps_buf: &mut Vec<usize>,
) {
    match event {
        EventDataOrMetrics::Event(event_data) => {
            let serializable = SerializableEventData::from(&*event_data);
            if filter.matches_event(&serializable) {
                events_buf.push(serializable);
            }
        }
        EventDataOrMetrics::TopAccesses(top_accesses_data) => {
            accesses_buf.push(top_accesses_data);
        }
        EventDataOrMetrics::TPS(tps) => {
            tps_buf.push(tps);
        }
    }
}

// Helper function to serialize and send a message over WebSocket
async fn send_message(
    ws_sender: &mut SplitSink<WebSocketStream<TcpStream>, Message>,
    server_msg: ServerMessage,
) -> anyhow::Result<()> {
    let json_message = serde_json::to_string(&server_msg)?;
    ws_sender.send(Message::Text(json_message)).await?;
    Ok(())
}

async fn client_write_task(
    mut event_broadcast_receiver: broadcast::Receiver<EventDataOrMetrics>,
    filter: EventFilter,
    addr: SocketAddr,
    mut ws_sender: SplitSink<WebSocketStream<TcpStream>, Message>,
) {
    let mut events_buf: Vec<SerializableEventData> = Vec::new();
    let mut accesses_buf: Vec<TopAccessesData> = Vec::new();
    let mut tps_buf: Vec<usize> = Vec::new();

    loop {
        // Wait for first event
        match event_broadcast_receiver.recv().await {
            Ok(event) => process_event(event, &filter, &mut events_buf, &mut accesses_buf, &mut tps_buf),
            Err(e) => {
                error!("Event broadcast receiver error for {}: {}", addr, e);
                break;
            }
        }

        // Drain all available events without blocking
        while let Ok(event) = event_broadcast_receiver.try_recv() {
            process_event(event, &filter, &mut events_buf, &mut accesses_buf, &mut tps_buf);
        }

        // Send all accumulated buffers
        if !events_buf.is_empty() {
            let server_msg = ServerMessage::Events(std::mem::take(&mut events_buf));
            if let Err(e) = send_message(&mut ws_sender, server_msg).await {
                error!("Failed to send events to {}: {}", addr, e);
                break;
            }
        }

        if !accesses_buf.is_empty() {
            for accesses in std::mem::take(&mut accesses_buf) {
                let server_msg = ServerMessage::TopAccesses(accesses);
                if let Err(e) = send_message(&mut ws_sender, server_msg).await {
                    error!("Failed to send accesses to {}: {}", addr, e);
                    break;
                }
            }
        }

        if !tps_buf.is_empty() {
            for tps in std::mem::take(&mut tps_buf) {
                let server_msg = ServerMessage::TPS(tps);
                if let Err(e) = send_message(&mut ws_sender, server_msg).await {
                    error!("Failed to send TPS to {}: {}", addr, e);
                    break;
                }
            }
        }
    }
}

async fn client_read_task(
    addr: SocketAddr,
    mut ws_receiver: SplitStream<WebSocketStream<TcpStream>>,
) {
    while let Some(msg) = ws_receiver.next().await {
        match msg {
            Ok(Message::Close(_)) => {
                info!("Received close message from client {}, disconnecting", addr);
                break;
            }
            Ok(Message::Text(_) | Message::Binary(_)) => {
                // Don't allow any inbound messages after subscribing - disconnect when any received
                warn!(
                    "Client {} sent unsolicited message after subscribing - disconnecting",
                    addr
                );
                break;
            }
            Err(e) => {
                warn!("WebSocket error from {}: {}", addr, e);
                break;
            }
            _ => (),
        }
    }
}

async fn run_event_forwarder_task(
    mut event_receiver: tokio::sync::mpsc::Receiver<EventData>,
    event_broadcast_sender: broadcast::Sender<EventDataOrMetrics>,
    last_event_time: LastEventTime,
) {
    let mut account_accesses = TopKTracker::new(1_000);
    let mut storage_accesses = TopKTracker::new(1_000);
    let mut accesses_reset_interval = tokio::time::interval(std::time::Duration::from_mins(5));

    // Track current transaction hash per txn_idx
    let mut current_txn_hashes: Vec<Option<[u8; 32]>> = vec![None; 10_000];

    let mut tps_tracker = TPSTracker::new();

    loop {
        tokio::select! {
            event_data = event_receiver.recv() => {
                if event_data.is_none() {
                    error!("Event receiver closed");
                    return;
                }
                let mut event_data = event_data.unwrap();

                // Update last event timestamp for health check
                let now_secs = SystemTime::now()
                    .duration_since(UNIX_EPOCH)
                    .unwrap_or_default()
                    .as_secs();
                last_event_time.store(now_secs, Ordering::Relaxed);

                // Track txn_hash from TxnHeaderStart events
                if let EventName::TxnHeaderStart = event_data.event_name {
                    if let ExecEvent::TxnHeaderStart { txn_index, txn_header_start, .. } = &event_data.payload {
                        current_txn_hashes[*txn_index] = Some(txn_header_start.txn_hash.bytes);
                    } else {
                        unreachable!();
                    }
                }

                // Populate txn_hash for events that have txn_idx
                if let Some(txn_idx) = event_data.txn_idx {
                    if let Some(Some(hash)) = current_txn_hashes.get(txn_idx) {
                        event_data.txn_hash = Some(*hash);
                    }
                }

                let mut tps_event = None;
                
                match event_data.event_name {
                    EventName::BlockStart => {
                        tps_event = Some(EventDataOrMetrics::TPS(tps_tracker.get_tps()));
                    }
                    EventName::TxnHeaderStart => {
                        tps_tracker.record_tx();
                    }
                    EventName::TxnEnd => {
                        if let Some(txn_idx) = event_data.txn_idx {
                            current_txn_hashes[txn_idx] = None;
                        }
                    }
                    EventName::AccountAccess => {
                        if let ExecEvent::AccountAccess {
                            account_access,
                            ..
                        } = &event_data.payload {
                            let address = Address::from_slice(&account_access.address.bytes);
                            account_accesses.record(address);
                        } else {
                            unreachable!();
                        }
                    }
                    EventName::StorageAccess => {
                        if let ExecEvent::StorageAccess {
                            storage_access,
                            ..
                        } = &event_data.payload {
                            let address = Address::from_slice(&storage_access.address.bytes);
                            let key = B256::from_slice(&storage_access.key.bytes);
                            storage_accesses.record((address, key));
                        } else {
                            unreachable!();
                        }
                    }
                    _ => (),
                }

                // Send accesses update on BlockEnd events (after all access events are processed)
                let send_accesses_update = matches!(event_data.event_name, EventName::BlockEnd);

                let _ = event_broadcast_sender.send(EventDataOrMetrics::Event(Box::new(event_data)));

                if send_accesses_update {
                    let top_accesses_data = TopAccessesData {
                        account: account_accesses.top_k(10),
                        storage: storage_accesses.top_k(10),
                    };
                    let _ = event_broadcast_sender.send(EventDataOrMetrics::TopAccesses(top_accesses_data));
                }

                if let Some(tps_event) = tps_event {
                    let _ = event_broadcast_sender.send(tps_event);
                }

            },
            _ = accesses_reset_interval.tick() => {
                account_accesses.reset();
                storage_accesses.reset();
            }
        }
    }
}

async fn handle_connection(
    stream: TcpStream,
    addr: SocketAddr,
    event_broadcast_receiver: broadcast::Receiver<EventDataOrMetrics>,
    filter: EventFilter,
) {
    info!("New WebSocket connection from: {}", addr);

    let ws_stream = match accept_async(stream).await {
        Ok(ws) => ws,
        Err(e) => {
            error!("Error during WebSocket handshake: {}", e);
            return;
        }
    };

    let (ws_sender, ws_receiver) = ws_stream.split();

    // Spawn a task to receive events from the broadcast channel and send batches to this client
    let mut send_task = tokio::spawn(client_write_task(
        event_broadcast_receiver,
        filter,
        addr,
        ws_sender,
    ));

    // Spawn a task to handle incoming messages from the client (mostly for ping/pong)
    let mut recv_task = tokio::spawn(client_read_task(addr, ws_receiver));

    // Wait for either task to finish
    tokio::select! {
        result = &mut send_task => {
            recv_task.abort();
            if let Err(e) = result {
                error!("Send task panicked for {}: {}", addr, e);
            }
        }
        result = &mut recv_task => {
            send_task.abort();
            if let Err(e) = result {
                error!("Receive task panicked for {}: {}", addr, e);
            }
        }
    }

    info!("WebSocket connection closed: {}", addr);
}

async fn health_handler(
    last_event_time: LastEventTime,
) -> Result<Response<Full<Bytes>>, hyper::Error> {
    let now_secs = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .unwrap_or_default()
        .as_secs();
    let last_event = last_event_time.load(Ordering::Relaxed);
    let time_since_last_event = now_secs.saturating_sub(last_event);

    // Exit process if no events received for EXIT_THRESHOLD_SECS
    if time_since_last_event >= EXIT_THRESHOLD_SECS {
        error!(
            "No events received for {} seconds (threshold: {}), exiting to trigger restart",
            time_since_last_event,
            EXIT_THRESHOLD_SECS
        );
        std::process::exit(1);
    }

    let is_healthy = time_since_last_event <= UNHEALTHY_THRESHOLD_SECS;

    let body = if is_healthy {
        info!("Health check passed");
        r#"{"success": true}"#
    } else {
        warn!(
            "Health check failed - last event time: {} seconds ago",
            time_since_last_event
        );
        r#"{"success": false}"#
    };

    Ok(Response::builder()
        .status(StatusCode::OK)
        .header("Content-Type", "application/json")
        .body(Full::new(Bytes::from(body)))
        .unwrap())
}

async fn run_health_server(
    health_addr: SocketAddr,
    last_event_time: LastEventTime,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    let listener = tokio::net::TcpListener::bind(health_addr).await?;
    info!("Health server listening on: {}", health_addr);

    loop {
        let (stream, _) = listener.accept().await?;
        let io = hyper_util::rt::TokioIo::new(stream);
        let last_event_time = last_event_time.clone();

        tokio::spawn(async move {
            let service = service_fn(move |_req: Request<hyper::body::Incoming>| {
                let last_event_time = last_event_time.clone();
                async move { health_handler(last_event_time).await }
            });

            if let Err(e) = http1::Builder::new().serve_connection(io, service).await {
                error!("Health server connection error: {}", e);
            }
        });
    }
}

async fn run_websocket_server(
    server_addr: SocketAddr,
    event_broadcast_sender: broadcast::Sender<EventDataOrMetrics>,
) -> Result<(), Box<dyn std::error::Error + Send + Sync>> {
    // Bind the TCP listener
    let listener = TcpListener::bind(&server_addr).await?;
    info!("WebSocket server listening on: {}", server_addr);

    let filter: EventFilter = if is_restricted_mode() {
        info!("Running in restricted mode");
        load_restricted_filters()
    } else {
        info!("Running in unrestricted mode");
        EventFilter::default()
    };

    // Accept incoming connections
    loop {
        match listener.accept().await {
            Ok((stream, client_addr)) => {
                let event_broadcast_receiver = event_broadcast_sender.subscribe();
                tokio::spawn(handle_connection(stream, client_addr, event_broadcast_receiver, filter.clone()));
            }
            Err(e) => {
                error!("Error accepting connection: {}", e);
            }
        }
    }
}

pub async fn run_servers(
    server_addr: SocketAddr,
    health_server_addr: SocketAddr,
    event_receiver: tokio::sync::mpsc::Receiver<EventData>,
) -> Result<(), Box<dyn std::error::Error>> {
    // Create shared state for tracking last event time (for health checks)
    let last_event_time: LastEventTime = Arc::new(AtomicU64::new(0));

    // Create a broadcast channel for distributing events to all clients
    let (event_broadcast_sender, _) = broadcast::channel::<EventDataOrMetrics>(1_000_000);

    // Spawn a task to forward events from the mpsc channel to the broadcast channel
    let event_broadcast_sender_clone = event_broadcast_sender.clone();
    let last_event_time_clone = last_event_time.clone();
    tokio::spawn(run_event_forwarder_task(
        event_receiver,
        event_broadcast_sender_clone,
        last_event_time_clone,
    ));

    // Spawn both servers and wait for either to complete
    let websocket_task = tokio::spawn(run_websocket_server(server_addr, event_broadcast_sender));
    let health_task = tokio::spawn(run_health_server(health_server_addr, last_event_time));

    tokio::select! {
        result = websocket_task => {
            error!("WebSocket server task stopped: {:?}", result);
        }
        result = health_task => {
            error!("Health server task stopped: {:?}", result);
        }
    }

    Ok(())
}
