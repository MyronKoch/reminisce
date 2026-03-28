# @reminisce/social Architecture

## Overview

The social package implements a distributed, eventually-consistent memory synchronization system using Conflict-free Replicated Data Types (CRDTs) over a file-based transport layer.

## Core Components

### 1. CRDT Layer (`src/crdt.ts`)

Implements Last-Write-Wins (LWW) Register pattern:

```
LWWRegister<T> {
  current: CRDTNode<T> | null
  history: CRDTNode<T>[]
}

CRDTNode<T> {
  value: T
  clock: VectorClock
  tombstone: boolean
}

VectorClock {
  timestamp: number
  machineId: string
}
```

**Conflict Resolution Algorithm:**
1. Compare timestamps: higher wins
2. If equal, compare machineIds lexicographically (deterministic tie-breaking)
3. Tombstone flag marks deletions (never truly delete for eventual consistency)

### 2. File Transport (`src/file-transport.ts`)

Manages file-based message passing:

```
File naming: {timestamp}-{machineId}.json

Example:
  1703123456789-laptop.json
  1703123457890-desktop.json
```

**Operations:**
- `writeSyncMessage()` - Write local state to shared directory
- `readSyncMessages()` - Read messages from other machines since timestamp
- `cleanup()` - Remove old sync files beyond retention period
- `getPeerMachines()` - Discover peers via their sync files

**Why file-based?**
- Works with existing sync solutions (Syncthing, Dropbox, iCloud)
- No central server required
- Simple debugging (inspect JSON files directly)
- Robust to network partitions (eventual consistency)

### 3. Sync Engine (`src/sync-engine.ts`)

Main orchestrator that combines CRDT and transport:

```
SyncEngine
├── state: SyncState
│   ├── localMachineId: string
│   ├── peers: Map<MachineID, MachinePeer>
│   ├── memories: Map<string, LWWRegister<Memory>>
│   └── lastSyncTimestamp: number
├── transport: FileTransport
└── pollInterval: NodeJS.Timeout
```

**Sync Cycle:**
1. Read new messages from sync directory since last sync
2. For each message:
   - Update peer metadata
   - Merge remote memories using CRDT rules
3. Broadcast local state to sync directory
4. Clean up old files

### 4. Type System (`src/types.ts`)

Defines core interfaces:
- `VectorClock` - Logical timestamp for ordering
- `CRDTNode<T>` - CRDT data structure
- `LWWRegister<T>` - Last-write-wins register
- `SyncMessage` - Wire format for sync operations
- `MachinePeer` - Peer machine metadata
- `SyncState` - Local sync state
- `SyncStats` - Monitoring statistics

## Data Flow

```
Machine A                    Sync Directory              Machine B
─────────                    ──────────────              ─────────

1. addMemory()
   ↓
2. updateRegister()
   ↓
3. sync()
   ↓
4. writeSyncMessage() ──→ {timestamp}-A.json
                                                          ↓
                                                    5. sync()
                                                          ↓
                                             6. readSyncMessages()
                                                          ↓
                                                    7. mergeRegisters()
                                                          ↓
                                                    8. getMemory()
                                                       returns value
```

## Conflict Resolution Example

```typescript
// Machine A at time 1000
memory = { content: "Version A", clock: { timestamp: 1000, machineId: "A" } }

// Machine B at time 1000 (concurrent modification)
memory = { content: "Version B", clock: { timestamp: 1000, machineId: "B" } }

// After sync on both machines
// B > A lexicographically, so B wins
memory = { content: "Version B", clock: { timestamp: 1000, machineId: "B" } }
```

## Guarantees

### What it guarantees:
- **Eventual consistency**: All machines converge to same state
- **Deterministic conflict resolution**: Same inputs → same result
- **Commutative merges**: Order of sync doesn't matter
- **Idempotent operations**: Re-syncing same data is safe

### What it doesn't guarantee:
- **Causality tracking**: No vector clock per machine (could be added)
- **Transactional updates**: No multi-memory atomic operations
- **Ordering preservation**: Last write wins, not first
- **Real-time sync**: Depends on file sync latency

## Performance Characteristics

### Time Complexity
- `addMemory()`: O(1) - Update local register
- `sync()`: O(n × m) where n = new messages, m = memories per message
- `getMemory()`: O(1) - Hash map lookup
- `getAllMemories()`: O(n) where n = total memories

### Space Complexity
- Per memory: O(h) where h = history depth (configurable)
- Total: O(n × h) where n = unique memories

### Network (File I/O)
- Write: O(1) per sync (single file)
- Read: O(p) where p = number of peers
- Cleanup: O(f) where f = total files in directory

## Scalability Considerations

### Current Implementation
- Best for: 2-10 machines
- Memory limit: ~10K memories per machine
- File system: Works on any POSIX-compatible FS

### Potential Optimizations
1. **Delta sync**: Only send changed memories (not full state)
2. **Compression**: Gzip sync files
3. **Sharding**: Split memories across multiple sync directories
4. **Batching**: Group multiple updates before sync
5. **Bloom filters**: Quick check for new data before full read

## Testing Strategy

### Unit Tests
- CRDT operations (merge, conflict resolution)
- File transport (read, write, cleanup)
- Sync engine state management

### Integration Tests
- Multi-machine sync scenarios
- Conflict resolution end-to-end
- Peer discovery

### Property-Based Tests (Future)
- Commutativity of merges
- Idempotence of sync
- Eventual consistency

## Future Enhancements

### Planned
- [ ] Delta sync for efficiency
- [ ] Compression of sync files
- [ ] Configurable history retention per memory
- [ ] Metrics and observability hooks

### Possible
- [ ] Causal consistency (vector clocks per machine)
- [ ] Encryption of sync files
- [ ] Selective sync (filter by memory type)
- [ ] Direct peer-to-peer sync (bypass files)
