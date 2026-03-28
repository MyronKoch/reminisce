/**
 * Sync engine for cross-machine memory synchronization
 */

import type { EpisodicMemory, SemanticMemory } from '@reminisce/core';
import type {
  SyncEngineConfig,
  SyncState,
  SyncMessage,
  SyncStats,
  MachinePeer,
  MachineID,
  VectorClock,
  LWWRegister,
} from './types.js';
import {
  createRegister,
  updateRegister,
  mergeRegisters,
  getValue,
  deleteRegister,
  isDeleted,
  getLastModified,
} from './crdt.js';
import { FileTransport } from './file-transport.js';
import { FileWatcher, type FileWatcherCallback } from './file-watcher.js';

/**
 * Main synchronization engine
 */
export class SyncEngine {
  private config: SyncEngineConfig;
  private state: SyncState;
  private transport: FileTransport;
  private pollInterval: NodeJS.Timeout | null = null;
  private fileWatcher: FileWatcher | null = null;
  private stats: SyncStats;
  private isSyncing = false;

  constructor(config: SyncEngineConfig) {
    this.config = {
      pollIntervalMs: 5000,
      retentionDays: 30,
      triggerMode: 'poll',
      watchDebounceMs: 100,
      ...config,
    };

    this.state = {
      localMachineId: config.machineId,
      peers: new Map(),
      memories: new Map(),
      lastSyncTimestamp: 0,
    };

    this.transport = new FileTransport(config.syncDirectory, config.machineId);

    this.stats = {
      totalMemories: 0,
      memoriesFromPeers: 0,
      lastSyncTime: 0,
      peerCount: 0,
      conflicts: 0,
      resolvedConflicts: 0,
    };
  }

  /**
   * Initialize the sync engine
   */
  async initialize(): Promise<void> {
    await this.transport.initialize();

    // Discover existing peers
    const peers = await this.transport.getPeerMachines();
    for (const peerId of peers) {
      const lastSeen = await this.transport.getLatestPeerTimestamp(peerId);
      this.state.peers.set(peerId, {
        machineId: peerId,
        lastSeen,
        syncedUntil: 0,
      });
    }

    this.stats.peerCount = this.state.peers.size;
  }

  /**
   * Start automatic synchronization
   */
  async start(): Promise<void> {
    const mode = this.config.triggerMode;

    // Start polling if enabled
    if ((mode === 'poll' || mode === 'both') && !this.pollInterval) {
      this.pollInterval = setInterval(
        () => this.sync(),
        this.config.pollIntervalMs
      );
    }

    // Start file watcher if enabled
    if ((mode === 'watch' || mode === 'both') && !this.fileWatcher) {
      this.fileWatcher = new FileWatcher({
        syncDirectory: this.config.syncDirectory,
        machineId: this.config.machineId,
        debounceMs: this.config.watchDebounceMs,
      });

      this.fileWatcher.onFileChange(async () => {
        await this.sync();
      });

      await this.fileWatcher.start();
    }
  }

  /**
   * Stop automatic synchronization
   */
  stop(): void {
    if (this.pollInterval) {
      clearInterval(this.pollInterval);
      this.pollInterval = null;
    }

    if (this.fileWatcher) {
      this.fileWatcher.stop();
      this.fileWatcher = null;
    }
  }

  /**
   * Get the current trigger mode
   */
  get triggerMode(): string {
    return this.config.triggerMode ?? 'poll';
  }

  /**
   * Check if sync engine is actively watching/polling
   */
  get isActive(): boolean {
    return this.pollInterval !== null || (this.fileWatcher?.running ?? false);
  }

  /**
   * Perform a synchronization cycle
   */
  async sync(): Promise<void> {
    // Prevent concurrent syncs
    if (this.isSyncing) {
      return;
    }

    this.isSyncing = true;
    const startTime = Date.now();

    try {
      // Read new messages from peers
      const messages = await this.transport.readSyncMessages(this.state.lastSyncTimestamp);

      for (const message of messages) {
        await this.processMessage(message);
      }

      // Broadcast our state if we have updates
      if (this.state.memories.size > 0) {
        await this.broadcastState();
      }

      // Update stats
      this.stats.lastSyncTime = startTime;
      this.stats.totalMemories = this.state.memories.size;
      this.stats.peerCount = this.state.peers.size;

      // Cleanup old files
      const retentionMs = this.config.retentionDays! * 24 * 60 * 60 * 1000;
      await this.transport.cleanup(retentionMs);
    } finally {
      this.isSyncing = false;
    }
  }

  /**
   * Process an incoming sync message
   */
  private async processMessage(message: SyncMessage): Promise<void> {
    // Update peer info
    const peer = this.state.peers.get(message.from) ?? {
      machineId: message.from,
      lastSeen: message.timestamp,
      syncedUntil: 0,
    };

    peer.lastSeen = Math.max(peer.lastSeen, message.timestamp);
    this.state.peers.set(message.from, peer);

    // Process memories
    if (message.memories) {
      for (const [memoryId, remoteRegister] of Object.entries(message.memories)) {
        const localRegister = this.state.memories.get(memoryId) ?? createRegister<EpisodicMemory | SemanticMemory>();

        const wasUpdated = mergeRegisters(localRegister, remoteRegister);

        if (wasUpdated) {
          this.state.memories.set(memoryId, localRegister);
          this.stats.memoriesFromPeers++;

          // Check if this was a conflict resolution
          if (getValue(localRegister) && getValue(remoteRegister)) {
            this.stats.conflicts++;
            this.stats.resolvedConflicts++;
          }
        }
      }
    }

    // Update last sync timestamp
    this.state.lastSyncTimestamp = Math.max(
      this.state.lastSyncTimestamp,
      message.timestamp
    );
  }

  /**
   * Broadcast current state to peers
   */
  private async broadcastState(): Promise<void> {
    const memories: Record<string, LWWRegister<EpisodicMemory | SemanticMemory>> = {};

    // Include all non-deleted memories
    for (const [memoryId, register] of this.state.memories) {
      if (!isDeleted(register)) {
        memories[memoryId] = register;
      }
    }

    const message: SyncMessage = {
      type: 'full-state',
      from: this.state.localMachineId,
      timestamp: Date.now(),
      memories,
    };

    await this.transport.writeSyncMessage(message);
  }

  /**
   * Add or update a memory
   */
  async addMemory(memory: EpisodicMemory | SemanticMemory): Promise<void> {
    const memoryId = memory.memory_id.id;
    const clock: VectorClock = {
      timestamp: Date.now(),
      machineId: this.state.localMachineId,
    };

    const register = this.state.memories.get(memoryId) ?? createRegister<EpisodicMemory | SemanticMemory>();

    updateRegister(register, memory, clock);
    this.state.memories.set(memoryId, register);
  }

  /**
   * Delete a memory
   */
  async deleteMemory(memoryId: string): Promise<void> {
    const register = this.state.memories.get(memoryId);
    if (!register) {
      return;
    }

    const clock: VectorClock = {
      timestamp: Date.now(),
      machineId: this.state.localMachineId,
    };

    deleteRegister(register, clock);
  }

  /**
   * Get a memory by ID
   */
  getMemory(memoryId: string): (EpisodicMemory | SemanticMemory) | null {
    const register = this.state.memories.get(memoryId);
    if (!register) {
      return null;
    }
    return getValue(register);
  }

  /**
   * Get all active memories
   */
  getAllMemories(): (EpisodicMemory | SemanticMemory)[] {
    const memories: (EpisodicMemory | SemanticMemory)[] = [];

    for (const register of this.state.memories.values()) {
      const value = getValue(register);
      if (value) {
        memories.push(value);
      }
    }

    return memories;
  }

  /**
   * Get memories from a specific peer
   */
  getMemoriesFromPeer(peerId: MachineID): (EpisodicMemory | SemanticMemory)[] {
    const memories: (EpisodicMemory | SemanticMemory)[] = [];

    for (const register of this.state.memories.values()) {
      if (register.current?.clock.machineId === peerId) {
        const value = getValue(register);
        if (value) {
          memories.push(value);
        }
      }
    }

    return memories;
  }

  /**
   * Get synchronization statistics
   */
  getStats(): SyncStats {
    return { ...this.stats };
  }

  /**
   * Get list of known peers
   */
  getPeers(): MachinePeer[] {
    return Array.from(this.state.peers.values());
  }

  /**
   * Get the provenance of a memory (which machine last modified it)
   */
  getMemoryProvenance(memoryId: string): { machineId: MachineID; timestamp: number } | null {
    const register = this.state.memories.get(memoryId);
    if (!register?.current) {
      return null;
    }

    return {
      machineId: register.current.clock.machineId,
      timestamp: register.current.clock.timestamp,
    };
  }
}
