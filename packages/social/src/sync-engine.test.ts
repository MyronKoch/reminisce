/**
 * Tests for SyncEngine
 */

import { describe, expect, test, beforeEach, afterEach } from 'bun:test';
import { rm, mkdir } from 'node:fs/promises';
import { join } from 'node:path';
import { tmpdir } from 'node:os';
import { SyncEngine } from './sync-engine.js';
import type { EpisodicMemory, MemoryID } from '@reminisce/core';

// Helper to create a test memory ID
function createTestMemoryID(layer: 'episodic' | 'semantic'): MemoryID {
  return {
    id: `test-${Date.now()}-${Math.random()}`,
    layer,
    created_at: new Date(),
    source_session: 'test-session',
    source_machine: 'test-machine',
  };
}

describe('SyncEngine', () => {
  let testDir: string;
  let engine1: SyncEngine;
  let engine2: SyncEngine;

  beforeEach(async () => {
    // Create unique test directory
    testDir = join(tmpdir(), `reminisce-social-test-${Date.now()}`);
    await mkdir(testDir, { recursive: true });

    // Create two engines sharing the same sync directory
    engine1 = new SyncEngine({
      machineId: 'machine-1',
      machineName: 'Test Machine 1',
      syncDirectory: testDir,
      pollIntervalMs: 100,
    });

    engine2 = new SyncEngine({
      machineId: 'machine-2',
      machineName: 'Test Machine 2',
      syncDirectory: testDir,
      pollIntervalMs: 100,
    });

    await engine1.initialize();
    await engine2.initialize();
  });

  afterEach(async () => {
    engine1.stop();
    engine2.stop();
    await rm(testDir, { recursive: true, force: true });
  });

  test('should initialize with no memories', () => {
    const memories = engine1.getAllMemories();
    expect(memories).toHaveLength(0);
  });

  test('should add memory locally', async () => {
    const memory: EpisodicMemory = {
      memory_id: createTestMemoryID('episodic'),
      content: {
        event: 'Test event',
        summary: 'Test memory',
        entities: ['test'],
      },
      started_at: new Date(),
      session_id: 'test-session',
      consolidated: false,
      provenance: {
        sources: [],
        lastModified: Date.now(),
        derivationType: 'observed',
      },
      salience: {
        score: 0.5,
        lastAccessed: Date.now(),
        accessCount: 1,
        decayRate: 0.1,
        validated: false,
      },
    };

    await engine1.addMemory(memory);

    const retrieved = engine1.getMemory(memory.memory_id.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved?.content.summary).toBe('Test memory');
  });

  test('should sync memory between machines', async () => {
    const memory: EpisodicMemory = {
      memory_id: createTestMemoryID('episodic'),
      content: {
        event: 'Sync test event',
        summary: 'Synced memory',
        entities: ['sync'],
      },
      started_at: new Date(),
      session_id: 'test-session',
      consolidated: false,
      provenance: {
        sources: [],
        lastModified: Date.now(),
        derivationType: 'observed',
      },
      salience: {
        score: 0.5,
        lastAccessed: Date.now(),
        accessCount: 1,
        decayRate: 0.1,
        validated: false,
      },
    };

    // Add memory to engine1
    await engine1.addMemory(memory);

    // Trigger sync
    await engine1.sync();
    await new Promise(resolve => setTimeout(resolve, 50)); // Wait for file write
    await engine2.sync();

    // Check if engine2 received the memory
    const retrieved = engine2.getMemory(memory.memory_id.id);
    expect(retrieved).toBeTruthy();
    expect(retrieved?.content.summary).toBe('Synced memory');
  });

  test('should resolve conflicts with LWW', async () => {
    const memoryId = createTestMemoryID('episodic');

    // Create two versions with different timestamps
    const memory1: EpisodicMemory = {
      memory_id: memoryId,
      content: {
        event: 'Conflict test',
        summary: 'First version',
        entities: ['conflict'],
      },
      started_at: new Date(Date.now() - 1000),
      session_id: 'test-session',
      consolidated: false,
      provenance: {
        sources: [],
        lastModified: Date.now() - 1000,
        derivationType: 'observed',
      },
      salience: {
        score: 0.5,
        lastAccessed: Date.now(),
        accessCount: 1,
        decayRate: 0.1,
        validated: false,
      },
    };

    const memory2: EpisodicMemory = {
      ...memory1,
      content: {
        event: 'Conflict test',
        summary: 'Second version',
        entities: ['conflict'],
      },
      started_at: new Date(),
      provenance: {
        ...memory1.provenance,
        lastModified: Date.now(),
      },
    };

    // Add different versions to each engine
    await engine1.addMemory(memory1);
    await engine2.addMemory(memory2);

    // Sync
    await engine1.sync();
    await engine2.sync();
    await new Promise(resolve => setTimeout(resolve, 50));
    await engine1.sync();

    // Both should have the newer version
    const result1 = engine1.getMemory(memoryId.id);
    const result2 = engine2.getMemory(memoryId.id);

    expect(result1?.content.summary).toBe('Second version');
    expect(result2?.content.summary).toBe('Second version');
  });

  test('should track memory provenance', async () => {
    const memory: EpisodicMemory = {
      memory_id: createTestMemoryID('episodic'),
      content: {
        event: 'Provenance test',
        summary: 'Provenance test',
        entities: ['provenance'],
      },
      started_at: new Date(),
      session_id: 'test-session',
      consolidated: false,
      provenance: {
        sources: [],
        lastModified: Date.now(),
        derivationType: 'observed',
      },
      salience: {
        score: 0.5,
        lastAccessed: Date.now(),
        accessCount: 1,
        decayRate: 0.1,
        validated: false,
      },
    };

    await engine1.addMemory(memory);

    const provenance = engine1.getMemoryProvenance(memory.memory_id.id);
    expect(provenance).toBeTruthy();
    expect(provenance?.machineId).toBe('machine-1');
  });

  test('should get memories from specific peer', async () => {
    const memory: EpisodicMemory = {
      memory_id: createTestMemoryID('episodic'),
      content: {
        event: 'Peer test',
        summary: 'Peer memory',
        entities: ['peer'],
      },
      started_at: new Date(),
      session_id: 'test-session',
      consolidated: false,
      provenance: {
        sources: [],
        lastModified: Date.now(),
        derivationType: 'observed',
      },
      salience: {
        score: 0.5,
        lastAccessed: Date.now(),
        accessCount: 1,
        decayRate: 0.1,
        validated: false,
      },
    };

    await engine1.addMemory(memory);
    await engine1.sync();
    await new Promise(resolve => setTimeout(resolve, 50));
    await engine2.sync();

    const peerMemories = engine2.getMemoriesFromPeer('machine-1');
    expect(peerMemories).toHaveLength(1);
    expect(peerMemories[0]?.content.summary).toBe('Peer memory');
  });

  test('should provide sync statistics', async () => {
    const stats = engine1.getStats();

    expect(stats).toHaveProperty('totalMemories');
    expect(stats).toHaveProperty('memoriesFromPeers');
    expect(stats).toHaveProperty('lastSyncTime');
    expect(stats).toHaveProperty('peerCount');
  });
});
