# @reminisce/social

Cross-machine memory synchronization with CRDT-based conflict resolution.

## Overview

The social package enables multiple machines to share memories through a file-based synchronization mechanism (e.g., Syncthing). It uses Last-Write-Wins (LWW) CRDTs to resolve conflicts automatically, ensuring eventual consistency across all peers.

## Features

- **CRDT-Based Sync**: Conflict-free replication using Last-Write-Wins registers
- **File Transport**: Works with any file sync service (Syncthing, Dropbox, etc.)
- **Machine Provenance**: Track which machine created or last modified each memory
- **Automatic Conflict Resolution**: No manual merge conflicts - LWW handles it
- **Peer Discovery**: Automatically discover other machines via sync directory
- **Efficient Updates**: Only sync changed memories

## Installation

```bash
bun install @reminisce/social
```

## Usage

### Basic Setup

```typescript
import { SyncEngine } from '@reminisce/social';
import type { EpisodicMemory } from '@reminisce/core';

// Create sync engine
const engine = new SyncEngine({
  machineId: 'my-laptop',
  machineName: 'MacBook Pro',
  syncDirectory: '/path/to/syncthing/reminisce-sync',
  pollIntervalMs: 5000, // Check for updates every 5 seconds
});

// Initialize
await engine.initialize();

// Start automatic synchronization
engine.start();
```

### Adding Memories

```typescript
const memory: EpisodicMemory = {
  memory_id: {
    id: 'unique-id',
    layer: 'episodic',
    created_at: new Date(),
    source_session: 'session-123',
    source_machine: 'my-laptop',
  },
  content: {
    event: 'User logged in',
    summary: 'User authentication successful',
    entities: ['user', 'auth'],
  },
  started_at: new Date(),
  session_id: 'session-123',
  consolidated: false,
  provenance: {
    sources: [],
    lastModified: Date.now(),
    derivationType: 'observed',
  },
  salience: {
    score: 0.8,
    lastAccessed: Date.now(),
    accessCount: 1,
    decayRate: 0.1,
    validated: false,
  },
};

await engine.addMemory(memory);
```

### Retrieving Memories

```typescript
// Get a specific memory
const memory = engine.getMemory('memory-id');

// Get all active memories
const allMemories = engine.getAllMemories();

// Get memories from a specific peer
const peerMemories = engine.getMemoriesFromPeer('other-machine-id');

// Check memory provenance
const provenance = engine.getMemoryProvenance('memory-id');
console.log(`Last modified by ${provenance?.machineId} at ${provenance?.timestamp}`);
```

### Monitoring Sync

```typescript
// Get synchronization statistics
const stats = engine.getStats();
console.log(`Total memories: ${stats.totalMemories}`);
console.log(`From peers: ${stats.memoriesFromPeers}`);
console.log(`Conflicts resolved: ${stats.resolvedConflicts}`);

// Get list of known peers
const peers = engine.getPeers();
peers.forEach(peer => {
  console.log(`${peer.machineId} last seen: ${new Date(peer.lastSeen)}`);
});
```

## How It Works

### CRDT Conflict Resolution

When two machines modify the same memory concurrently, the system uses a Last-Write-Wins (LWW) strategy:

1. Each modification is tagged with a vector clock: `{timestamp, machineId}`
2. When syncing, the system compares vector clocks
3. The modification with the higher timestamp wins
4. If timestamps are equal, machineId is used for deterministic tie-breaking

### File-Based Transport

The sync engine writes JSON files to a shared directory:

```
sync-directory/
├── 1234567890-machine-1.json  # Full state from machine-1
├── 1234567891-machine-2.json  # Full state from machine-2
└── 1234567892-machine-1.json  # Updated state from machine-1
```

Each machine:
1. Periodically reads files from other machines
2. Merges remote changes using CRDT rules
3. Writes its current state to a new file
4. Cleans up old files (default: 30 days retention)

### Provenance Tracking

Every memory tracks:
- **Source machine**: Which machine originally created it
- **Last modifier**: Which machine last modified it (via vector clock)
- **Modification timestamp**: When it was last changed

## API Reference

### SyncEngine

#### Constructor

```typescript
new SyncEngine(config: SyncEngineConfig)
```

Configuration options:
- `machineId` (required): Unique identifier for this machine
- `machineName` (optional): Human-readable machine name
- `syncDirectory` (required): Path to shared sync directory
- `pollIntervalMs` (optional): Sync check interval (default: 5000ms)
- `retentionDays` (optional): How long to keep old sync files (default: 30 days)

#### Methods

- `initialize(): Promise<void>` - Initialize the sync engine
- `start(): void` - Start automatic synchronization
- `stop(): void` - Stop automatic synchronization
- `sync(): Promise<void>` - Manually trigger a sync cycle
- `addMemory(memory): Promise<void>` - Add or update a memory
- `deleteMemory(memoryId): Promise<void>` - Delete a memory (tombstone)
- `getMemory(memoryId): Memory | null` - Get a specific memory
- `getAllMemories(): Memory[]` - Get all active memories
- `getMemoriesFromPeer(peerId): Memory[]` - Get memories from a peer
- `getMemoryProvenance(memoryId)` - Get modification provenance
- `getStats(): SyncStats` - Get synchronization statistics
- `getPeers(): MachinePeer[]` - Get list of known peers

## Use Cases

### Cross-Device Memory Sharing

Share episodic and semantic memories across laptop, desktop, and server:

```typescript
// On laptop
const laptop = new SyncEngine({
  machineId: 'laptop',
  syncDirectory: '~/Syncthing/reminisce',
});
await laptop.initialize();
laptop.start();

// On desktop
const desktop = new SyncEngine({
  machineId: 'desktop',
  syncDirectory: '~/Syncthing/reminisce',
});
await desktop.initialize();
desktop.start();

// Memories added on either machine automatically sync to the other
```

### Distributed Learning

Multiple agents learning from different environments can share their knowledge:

```typescript
// Agent A learns a new fact
const fact: SemanticMemory = {
  memory_id: { /* ... */ },
  content: {
    fact: 'User prefers dark mode',
    subject: 'user',
    predicate: 'prefers',
    object: 'dark mode',
    category: 'preferences',
  },
  source_episode_ids: [],
  // ...
};
await agentA.addMemory(fact);

// Agent B automatically receives this fact via sync
// Agent B can now use this knowledge in its interactions
```

## License

MIT
