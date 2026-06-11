use alloy_primitives::{Address, B256, U256};
use serde::{Deserialize, Serialize};
use std::fs::File;
use super::event_listener::EventName;
use super::serializable_event::{SerializableEventData, SerializableExecEvent};

/// Generic range filter for numeric types
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct RangeFilter<T> {
    #[serde(skip_serializing_if = "Option::is_none")]
    pub min: Option<T>,
    #[serde(skip_serializing_if = "Option::is_none")]
    pub max: Option<T>,
}

impl<T: PartialOrd> RangeFilter<T> {
    /// Checks if a value matches this range filter
    pub fn matches(&self, value: &T) -> bool {
        if let Some(min) = &self.min {
            if value < min {
                return false;
            }
        }
        if let Some(max) = &self.max {
            if value > max {
                return false;
            }
        }
        true
    }

    /// Checks if this is an empty filter (no constraints)
    pub fn is_empty(&self) -> bool {
        self.min.is_none() && self.max.is_none()
    }
}

/// Generic exact match filter for any type
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ExactMatchFilter<T> {
    pub values: Vec<T>,
}

impl<T: PartialEq> ExactMatchFilter<T> {
    /// Checks if a value matches this exact match filter
    pub fn matches(&self, value: &T) -> bool {
        self.values.is_empty() || self.values.contains(value)
    }

    /// Checks if this is an empty filter (no constraints)
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}

/// Prefix filter for arrays
/// Matches if the input array starts with the filter values.
/// If the input array is shorter than the filter values, it returns false.
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct ArrayPrefixFilter<T: PartialEq> {
    pub values: Vec<T>,
}

impl<T: PartialEq> ArrayPrefixFilter<T> {
    /// Checks if input array starts with filter values (prefix match)
    pub fn matches(&self, value: &[T]) -> bool {
        self.values.is_empty() || value.starts_with(&self.values)
    }

    /// Checks if this is an empty filter (no constraints)
    pub fn is_empty(&self) -> bool {
        self.values.is_empty()
    }
}

/// Field-specific filters for event data
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
#[serde(tag = "field", content = "filter", rename_all = "snake_case")]
pub enum FieldFilter {
    // ========== TxnLog fields ==========
    TxnIndex(RangeFilter<usize>),
    LogIndex(RangeFilter<u32>),
    Address(ExactMatchFilter<Address>),
    Topics(ArrayPrefixFilter<B256>),
    // data omitted
}

impl FieldFilter {
    /// Checks if an event matches this field filter
    pub fn matches(&self, event: &SerializableEventData) -> bool {
        match (self, event.event_name, &event.payload) {
            // ========== TxnLog ==========
            (FieldFilter::TxnIndex(range), EventName::TxnLog, SerializableExecEvent::TxnLog { txn_index, .. }) => {
                range.matches(txn_index)
            }
            (FieldFilter::LogIndex(range), EventName::TxnLog, SerializableExecEvent::TxnLog { log_index, .. }) => {
                range.matches(log_index)
            }
            (FieldFilter::Address(filter), EventName::TxnLog, SerializableExecEvent::TxnLog { address, .. }) => {
                filter.matches(address)
            }
            (FieldFilter::Topics(filter), EventName::TxnLog, SerializableExecEvent::TxnLog { topics, .. }) => {
                let chunked_topics: Vec<B256> = topics.chunks(32).map(|chunk| B256::from_slice(chunk)).collect();
                filter.matches(&chunked_topics)
            }

            // No match
            _ => false,
        }
    }
}

/// A filter specification for a single event name with optional field filters
/// Represents: EventName AND field_filter1 AND field_filter2 AND ...
#[derive(Debug, Clone, Serialize, Deserialize, PartialEq)]
pub struct EventFilterSpec {
    /// Event name to match
    pub event_name: EventName,
    /// Field filters that must all match (AND logic between them)
    /// Optional - defaults to empty vec (no field filtering)
    #[serde(default, skip_serializing_if = "Vec::is_empty")]
    pub field_filters: Vec<FieldFilter>,
}

impl EventFilterSpec {
    /// Checks if an event matches this filter spec
    pub fn matches(&self, event: &SerializableEventData) -> bool {
        if event.event_name != self.event_name {
            return false;
        }

        for filter in &self.field_filters {
            if !filter.matches(event) {
                return false;
            }
        }

        true
    }
}

fn is_native_transfer(event: &SerializableEventData) -> bool {
    if let SerializableExecEvent::TxnCallFrame {
        value,
        ..
    } = event.payload {
        value != U256::ZERO
    } else {
        false
    }
}

/// Filter for events with support for multiple filter specs (OR logic between specs)
#[derive(Clone, Debug, Default)]
pub struct EventFilter {
    /// Filter specs with OR logic between them
    event_filters: Vec<EventFilterSpec>,
}

impl PartialEq for EventFilter {
    fn eq(&self, other: &Self) -> bool {
        // Check that all elements in self exist in other
        for spec in &self.event_filters {
            if !other.event_filters.contains(spec) {
                return false;
            }
        }
        // Check that all elements in other exist in self
        for spec in &other.event_filters {
            if !self.event_filters.contains(spec) {
                return false;
            }
        }
        true
    }
}

impl EventFilter {
    /// Create a filter from event filter specs
    pub fn new(event_filters: Vec<EventFilterSpec>) -> Self {
        Self { event_filters }
    }

    fn includes_native_transfers(&self) -> bool {
        self.event_filters.iter().any(|spec| spec.event_name == EventName::NativeTransfer)
    }

    /// Checks if an event matches any filter spec (OR logic)
    /// Returns true if at least one spec matches (or if there are no specs)
    pub fn matches_event(&self, event: &SerializableEventData) -> bool {
        if self.event_filters.is_empty() {
            return true;
        }

        if self.includes_native_transfers() && is_native_transfer(event) {
            return true;
        }

        for spec in &self.event_filters {
            if spec.matches(event) {
                return true;
            }
        }

        false
    }

    /// Checks if filter accepts all events
    pub fn accepts_all(&self) -> bool {
        self.event_filters.is_empty()
    }

    /// Returns a clone of the event filter specs
    pub fn get_filter_specs(&self) -> Vec<EventFilterSpec> {
        self.event_filters.clone()
    }
}

// Load restricted filters from file
// These filters are statically specified to restrict the events that can be subscribed to
pub fn load_restricted_filters() -> EventFilter {
    let file = if let Ok(f) = File::open("restricted_filters.json") {
        f
    } else if let Ok(f) = File::open("backend/restricted_filters.json") {
        f
    } else {
        panic!("restricted_filters.json not found");
    };
    let filters: Vec<EventFilterSpec> = serde_json::from_reader(file).unwrap();
    EventFilter::new(filters)
}

pub fn is_restricted_mode() -> bool {
    std::env::var("ALLOW_UNRESTRICTED_FILTERS").is_err()
}