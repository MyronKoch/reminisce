/**
 * Basic example of cross-machine memory synchronization
 */

import { SyncEngine } from '../src/index.js';
import type { EpisodicMemory } from '@reminisce/core';

async function main() {
  // Create two sync engines simulating two different machines
  const machine1 = new SyncEngine({
    machineId: 'machine-1',
    machineName: 'Laptop',
    syncDirectory: '/tmp/reminisce-sync-demo',
    pollIntervalMs: 2000,
  });

  const machine2 = new SyncEngine({
    machineId: 'machine-2',
    machineName: 'Desktop',
    syncDirectory: '/tmp/reminisce-sync-demo',
    pollIntervalMs: 2000,
  });

  // Initialize both engines
  await machine1.initialize();
  await machine2.initialize();

  console.log('Initialized sync engines for two machines');

  // Create a memory on machine 1
  const memory: EpisodicMemory = {
    memory_id: {
      id: `episode-${Date.now()}`,
      layer: 'episodic',
      created_at: new Date(),
      source_session: 'demo-session',
      source_machine: 'machine-1',
    },
    content: {
      event: 'User completed onboarding',
      summary: 'New user went through the onboarding flow successfully',
      entities: ['user', 'onboarding'],
      valence: 0.8,
    },
    started_at: new Date(),
    session_id: 'demo-session',
    consolidated: false,
    provenance: {
      sources: [],
      lastModified: Date.now(),
      derivationType: 'observed',
    },
    salience: {
      score: 0.7,
      lastAccessed: Date.now(),
      accessCount: 1,
      decayRate: 0.1,
      validated: false,
    },
  };

  console.log('\nAdding memory to machine 1...');
  await machine1.addMemory(memory);

  // Trigger sync
  console.log('Syncing machine 1 state...');
  await machine1.sync();

  // Wait a moment for file to be written
  await new Promise(resolve => setTimeout(resolve, 100));

  // Machine 2 syncs
  console.log('Machine 2 syncing...');
  await machine2.sync();

  // Check if machine 2 received the memory
  const receivedMemory = machine2.getMemory(memory.memory_id.id);

  if (receivedMemory) {
    console.log('\n✓ Memory successfully synced to machine 2!');
    console.log('Memory content:', receivedMemory.content.summary);

    const provenance = machine2.getMemoryProvenance(memory.memory_id.id);
    console.log(
      `Last modified by: ${provenance?.machineId} at ${new Date(provenance?.timestamp ?? 0)}`
    );
  } else {
    console.log('\n✗ Memory sync failed');
  }

  // Show statistics
  console.log('\nMachine 1 stats:', machine1.getStats());
  console.log('Machine 2 stats:', machine2.getStats());

  // Show peers
  const peers = machine2.getPeers();
  console.log('\nKnown peers from machine 2:', peers.map(p => p.machineId));

  // Clean up
  machine1.stop();
  machine2.stop();
}

// Run the example
main().catch(console.error);
