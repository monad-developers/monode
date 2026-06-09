use alloy_primitives::B256;
use clap::Parser;
use execution_events_example::event_listener::EventName;
use execution_events_example::serializable_event::SerializableExecEvent;
use execution_events_example::server::ServerMessage;
use futures_util::StreamExt;
use std::collections::HashMap;
use tokio_tungstenite::{connect_async, tungstenite::Message};

use tracing_subscriber::{layer::SubscriberExt, util::SubscriberInitExt};

use tracing::{error, info, warn};

#[derive(Debug, Parser)]
#[command(name = "client", about = "WebSocket client for execution events", long_about = None)]
struct Cli {
    /// WebSocket server URL
    #[arg(short, long, default_value = "ws://127.0.0.1:3000")]
    url: String,

    #[arg(long, default_value = "false")]
    verbose_events: bool,

    #[arg(long, default_value = "false")]
    verbose_accesses: bool,
}

macro_rules! log_event {
    // Entry: just message
    ($msg:expr) => {
        tracing::info!("------> {}", $msg)
    };
    // Entry: message with arbitrary number of key=value pairs
    ($msg:expr, $($key:ident = $value:expr),+ $(,)?) => {{
        let mut s = format!("------> {}", $msg);
        $(
            s.push_str(&format!(" {}={:?}", stringify!($key), $value));
        )*
        tracing::info!("{}", s);
    }};
}

#[derive(Default)]
struct ClientState {
    events_witnessed: usize,
    block_start_ns: u64,
    txs_start_ns: HashMap<usize, (B256, u64)>,
    block_txns_total_duration: std::time::Duration,
    current_block_number: u64,
}

#[tokio::main]
async fn main() -> Result<(), Box<dyn std::error::Error>> {
    // Initialize tracing subscriber
    tracing_subscriber::registry()
        .with(
            tracing_subscriber::EnvFilter::try_from_default_env().unwrap_or_else(|_| "info".into()),
        )
        .with(tracing_subscriber::fmt::layer())
        .init();

    let cli = Cli::parse();

    info!("Connecting to {}...", cli.url);

    // Connect to the WebSocket server
    let (ws_stream, _) = connect_async(&cli.url).await?;
    info!("Connected!");

    let (_, mut read) = ws_stream.split();

    // Read messages from the server
    let mut events_per_sec_interval = tokio::time::interval(tokio::time::Duration::from_secs(1));
    let mut client_state = ClientState::default();

    loop {
        tokio::select! {
            msg = read.next() => {
                if msg.is_none() {
                    warn!("Connection closed");
                    break;
                }
                let msg = msg.unwrap();
                match msg {
                    Ok(Message::Text(text)) => {
                        match serde_json::from_str::<ServerMessage>(&text) {
                            Ok(ServerMessage::Events(events)) => {
                                for event in &events {
                                    match event.event_name {
                                        EventName::TxnPerfEvmEnter => {
                                            println!("tx enter");
                                        }
                                        EventName::TxnPerfEvmExit => {
                                            println!("tx exit");
                                        }
                                        _ => ()
                                    }
                                    match event.payload {
                                        SerializableExecEvent::BlockStart { block_number, base_fee_per_gas, .. } => {
                                            log_event!("BlockStart", block_number = block_number, base_fee = base_fee_per_gas);
                                            client_state.current_block_number = u64::max(client_state.current_block_number, block_number);
                                        }
                                        SerializableExecEvent::BlockPerfEvmEnter => {
                                            log_event!("BlockPerfEvmEnter");
                                            client_state.block_start_ns = event.timestamp_ns;
                                        }
                                        SerializableExecEvent::TxnHeaderStart { txn_hash, txn_index, .. } => {
                                            log_event!("TxnHeaderStart", txn_index = txn_index, txn_hash = txn_hash);
                                            client_state.txs_start_ns.insert(txn_index, (txn_hash, event.timestamp_ns));
                                        },
                                        SerializableExecEvent::TxnEvmOutput { txn_index, .. } => {
                                            if let Some((txn_hash, txn_start_ns)) = client_state.txs_start_ns.remove(&txn_index) {
                                                let txn_duration = std::time::Duration::from_nanos(event.timestamp_ns - txn_start_ns);
                                                client_state.block_txns_total_duration += txn_duration;

                                                log_event!("TxnEvmOutput", txn_index = txn_index, txn_hash = txn_hash, duration = txn_duration);
                                            } else {
                                                warn!("TxnPerfEvmExit event received without TxnPerfEvmEnter event: {:?}", txn_index);
                                            }
                                        },
                                        SerializableExecEvent::BlockPerfEvmExit => {
                                            log_event!("BlockPerfEvmExit");
                                            let block_duration = std::time::Duration::from_nanos(event.timestamp_ns - client_state.block_start_ns);
                                            let parallel_execution_savings = client_state.block_txns_total_duration.checked_sub(block_duration);
                                            let savings_pct = if parallel_execution_savings.is_none() { // This only happens with really small/empty blocks
                                                error!("Parallel execution savings is negative: txs={:?} block={:?} height={}", client_state.block_txns_total_duration, block_duration, client_state.current_block_number);
                                                None
                                            } else {
                                                Some(100.0 * (1.0 - (block_duration.as_nanos() as f64 / client_state.block_txns_total_duration.as_nanos() as f64)))
                                            };

                                            log_event!("BlockPerfEvmExit", height = client_state.current_block_number, block_duration = block_duration, tx_total_duration = client_state.block_txns_total_duration, savings_pct = savings_pct);

                                            client_state.block_txns_total_duration = std::time::Duration::from_nanos(0);
                                        },
                                        SerializableExecEvent::BlockEnd { gas_used, .. } => {
                                            log_event!("BlockEnd", gas_used = gas_used, block_number = client_state.current_block_number);
                                        },
                                        SerializableExecEvent::BlockQC { block_number, .. } => {
                                            log_event!("BlockQC", block_number = block_number);
                                        },
                                        SerializableExecEvent::BlockFinalized { block_number, .. } => {
                                            log_event!("BlockFinalized", block_number = block_number);
                                        },
                                        _ => ()
                                    }
                                }

                                info!("Received {} events", events.len());
                                if cli.verbose_events {
                                    info!("Events: {:?}", events);
                                }
                                client_state.events_witnessed += events.len();
                            }
                            Ok(ServerMessage::TopAccesses(top_accesses)) => {
                                info!("Received top accesses");
                                if cli.verbose_accesses {
                                    for entry in &top_accesses.storage {
                                        info!("Storage access: address={}, key={}, count={}", entry.key.0, entry.key.1, entry.count);
                                    }
                                    for entry in &top_accesses.account {
                                        info!("Account access: address={}, count={}", entry.key, entry.count);
                                    }
                                }
                            }
                            Ok(ServerMessage::TPS(tps)) => {
                                info!("Received TPS: {}", tps);
                            }
                            Err(_) => {
                                error!("Failed to parse events: {}", text);
                            }
                        }
                    }
                    Ok(Message::Binary(data)) => {
                        info!("Received binary data: {} bytes", data.len());
                    }
                    Ok(Message::Close(frame)) => {
                        warn!("Connection closed: {:?}", frame);
                        break;
                    }
                    Ok(_) => (),
                    Err(e) => {
                        error!("Error receiving message: {}", e);
                        break;
                    },
                }
            }
            _ = events_per_sec_interval.tick() => {
                info!("Events per second: {}", client_state.events_witnessed);
                client_state.events_witnessed = 0;
            }
        }
    }

    warn!("Disconnected from server");
    Ok(())
}
