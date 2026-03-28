/**
 * Tests for Working Memory Buffer
 */

import { describe, test, expect, mock } from 'bun:test';
import { WorkingMemoryBuffer } from './buffer.js';

describe('WorkingMemoryBuffer', () => {
  const defaultConfig = {
    sessionId: 'test-session',
    machineId: 'test-machine',
  };

  test('creates buffer with default capacity of 7', () => {
    const buffer = new WorkingMemoryBuffer(defaultConfig);
    expect(buffer.capacity).toBe(7);
    expect(buffer.size).toBe(0);
    expect(buffer.available).toBe(7);
  });

  test('adds items to buffer', async () => {
    const buffer = new WorkingMemoryBuffer(defaultConfig);

    const { item } = await buffer.add({
      type: 'message',
      data: { text: 'Hello world' },
      summary: 'Greeting',
    });

    expect(buffer.size).toBe(1);
    expect(item.content.type).toBe('message');
    expect(item.content.data).toEqual({ text: 'Hello world' });
    expect(item.memory_id.layer).toBe('working');
  });

  test('retrieves items by ID and reinforces salience', async () => {
    const buffer = new WorkingMemoryBuffer(defaultConfig);

    const { item } = await buffer.add({
      type: 'message',
      data: 'test',
    });

    const initialScore = item.salience.current_score;
    const retrieved = buffer.get(item.memory_id.id);

    expect(retrieved).toBeDefined();
    expect(retrieved!.salience.signals.access_count).toBe(1);
  });

  test('filters items by type', async () => {
    const buffer = new WorkingMemoryBuffer(defaultConfig);

    await buffer.add({ type: 'message', data: 'msg1' });
    await buffer.add({ type: 'tool_result', data: 'tool1' });
    await buffer.add({ type: 'message', data: 'msg2' });

    const messages = buffer.getByType('message');
    expect(messages.length).toBe(2);

    const tools = buffer.getByType('tool_result');
    expect(tools.length).toBe(1);
  });

  test('filters items by tag', async () => {
    const buffer = new WorkingMemoryBuffer(defaultConfig);

    await buffer.add({ type: 'message', data: 'tagged', tags: ['important'] });
    await buffer.add({ type: 'message', data: 'untagged' });

    const tagged = buffer.getByTag('important');
    expect(tagged.length).toBe(1);
    expect(tagged[0]!.content.data).toBe('tagged');
  });

  test('overflows lowest salience items when capacity exceeded', async () => {
    const overflowed: unknown[] = [];
    const buffer = new WorkingMemoryBuffer({
      ...defaultConfig,
      capacity: 3,
      onOverflow: (items) => {
        overflowed.push(...items);
      },
    });

    // Add 4 items to a capacity-3 buffer
    await buffer.add({ type: 'message', data: 'item1', signals: { reward_signal: 0.1 } });
    await buffer.add({ type: 'message', data: 'item2', signals: { reward_signal: 0.5 } });
    await buffer.add({ type: 'message', data: 'item3', signals: { reward_signal: 0.9 } });
    const { overflowed: overflow4 } = await buffer.add({
      type: 'message',
      data: 'item4',
      signals: { reward_signal: 0.7 },
    });

    expect(buffer.size).toBe(3);
    expect(overflowed.length).toBe(1);
    expect(overflow4.length).toBe(1);
    // Lowest salience (item1) should have overflowed
    expect((overflowed[0] as { content: { data: string } }).content.data).toBe('item1');
  });

  test('pinned items resist overflow', async () => {
    const overflowed: unknown[] = [];
    const buffer = new WorkingMemoryBuffer({
      ...defaultConfig,
      capacity: 2,
      onOverflow: (items) => {
        overflowed.push(...items);
      },
    });

    // Add item with low salience but pin it
    const { item: pinnable } = await buffer.add({
      type: 'message',
      data: 'pinned',
      signals: { reward_signal: 0.1 },
    });
    buffer.pin(pinnable.memory_id.id);

    // Add lower salience item (will be evicted)
    await buffer.add({ type: 'message', data: 'lowpriority', signals: { reward_signal: 0.05 } });

    // Add third item with medium salience - should overflow 'lowpriority', not 'pinned'
    await buffer.add({ type: 'message', data: 'medium', signals: { reward_signal: 0.3 } });

    expect(buffer.size).toBe(2);
    expect(overflowed.length).toBe(1);
    // 'lowpriority' should have overflowed (lowest salience), not 'pinned' (boosted by pin)
    expect((overflowed[0] as { content: { data: string } }).content.data).toBe('lowpriority');
  });

  test('clears buffer and triggers callback', async () => {
    let clearedItems: unknown[] = [];
    const buffer = new WorkingMemoryBuffer({
      ...defaultConfig,
      onClear: (items) => {
        clearedItems = items;
      },
    });

    await buffer.add({ type: 'message', data: 'item1' });
    await buffer.add({ type: 'message', data: 'item2' });

    const cleared = await buffer.clear();

    expect(buffer.size).toBe(0);
    expect(cleared.length).toBe(2);
    expect(clearedItems.length).toBe(2);
  });

  test('removes individual items', async () => {
    const buffer = new WorkingMemoryBuffer(defaultConfig);

    const { item } = await buffer.add({ type: 'message', data: 'test' });
    expect(buffer.size).toBe(1);

    const removed = buffer.remove(item.memory_id.id);
    expect(buffer.size).toBe(0);
    expect(removed).toBeDefined();
    expect(removed!.content.data).toBe('test');
  });

  test('blocks items (removes without overflow)', async () => {
    const buffer = new WorkingMemoryBuffer(defaultConfig);

    const { item } = await buffer.add({ type: 'message', data: 'to-block' });
    const blocked = buffer.block(item.memory_id.id);

    expect(buffer.size).toBe(0);
    expect(blocked).toBeDefined();
    expect(blocked!.salience.signals.user_blocked).toBe(true);
  });
});
