/**
 * Types for cross-machine memory synchronization
 */

import type { EpisodicMemory, SemanticMemory } from '@reminisce/core';

/**
 * Unique identifier for a machine/peer in the sync network
 */
export type MachineID = string;

/**
 * Logical timestamp for CRDT ordering
 * Format: [timestamp, machineID] for deterministic tie-breaking
 */
export interface VectorClock {
  timestamp: number;
  machineId: MachineID;
}

/**
 * CRDT node representing a memory value at a specific version
 */
export interface CRDTNode<T> {
  value: T;
  clock: VectorClock;
  tombstone: boolean; // true if deleted
}

/**
 * Last-Write-Wins Register CRDT
 * Stores the value with the highest vector clock
 */
export interface LWWRegister<T> {
  current: CRDTNode<T> | null;
  history: CRDTNode<T>[]; // Optional: keep history for debugging
}

/**
 * Sync message types
 */
export type SyncMessageType =
  | 'full-state'      // Complete state transfer
  | 'delta'           // Incremental update
  | 'request-state'   // Request full state from peer
  | 'ack';            // Acknowledgment

/**
 * Message payload for sync operations
 */
export interface SyncMessage {
  type: SyncMessageType;
  from: MachineID;
  timestamp: number;
  memories?: Record<string, LWWRegister<EpisodicMemory | SemanticMemory>>;
  memoryIds?: string[]; // For delta messages
}

/**
 * Peer machine metadata
 */
export interface MachinePeer {
  machineId: MachineID;
  name?: string;
  lastSeen: number;
  syncedUntil: number; // Last timestamp successfully synced
}

/**
 * Sync state for a machine
 */
export interface SyncState {
  localMachineId: MachineID;
  peers: Map<MachineID, MachinePeer>;
  memories: Map<string, LWWRegister<EpisodicMemory | SemanticMemory>>;
  lastSyncTimestamp: number;
}

/**
 * Sync trigger mode
 */
export type SyncTriggerMode = 'poll' | 'watch' | 'both' | 'manual';

/**
 * Configuration for sync engine
 */
export interface SyncEngineConfig {
  machineId: MachineID;
  machineName?: string;
  syncDirectory: string;
  pollIntervalMs?: number;   // How often to check for updates (poll/both mode)
  retentionDays?: number;    // How long to keep deleted memories in history
  triggerMode?: SyncTriggerMode; // How to trigger syncs (default: 'poll')
  watchDebounceMs?: number;  // Debounce for file watcher (default: 100)
}

/**
 * Sync statistics
 */
export interface SyncStats {
  totalMemories: number;
  memoriesFromPeers: number;
  lastSyncTime: number;
  peerCount: number;
  conflicts: number;
  resolvedConflicts: number;
}
