import { EventEmitter } from 'node:events';
import { describe, expect, it, vi } from 'vitest';

import { BoundedSseWriter } from './test-exports.js';

describe('APP-010 bounded SSE subscribers', () => {
  it('disconnects one blocked subscriber at its bound without blocking a healthy subscriber', () => {
    const blocked = new FakeResponse(false);
    const healthy = new FakeResponse(true);
    const overflow = vi.fn();
    const blockedWriter = new BoundedSseWriter(blocked as never, 2, overflow);
    const healthyWriter = new BoundedSseWriter(healthy as never, 2, vi.fn());

    for (const event of ['one', 'two', 'three', 'four']) {
      blockedWriter.write(event);
      healthyWriter.write(event);
    }

    expect(blocked.writes).toEqual(['one']);
    expect(overflow).toHaveBeenCalledTimes(1);
    expect(healthy.writes).toEqual(['one', 'two', 'three', 'four']);
    blocked.emit('drain');
    expect(blocked.writes).toEqual(['one']);
  });

  it('flushes a bounded queue in order after drain', () => {
    const response = new FakeResponse(false);
    const writer = new BoundedSseWriter(response as never, 3, vi.fn());
    writer.write('one');
    writer.write('two');
    writer.write('three');
    response.acceptWrites = true;
    response.emit('drain');
    expect(response.writes).toEqual(['one', 'two', 'three']);
  });
});

class FakeResponse extends EventEmitter {
  readonly writes: string[] = [];
  constructor(public acceptWrites: boolean) {
    super();
  }
  write(value: string): boolean {
    this.writes.push(value);
    return this.acceptWrites;
  }
}
