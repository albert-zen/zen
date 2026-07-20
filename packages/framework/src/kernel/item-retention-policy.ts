import type { Item } from './item-list.js';

export type RetentionClass = 'default' | 'extended' | 'discard';

export type RetentionMode = 'default' | 'extended';

export type ShouldRetainItemOptions = {
  readonly mode?: RetentionMode;
};

export class ItemRetentionPolicy {
  classify(item: Item): RetentionClass {
    if (isInternalItem(item)) {
      return 'discard';
    }

    if (isDeltaOrProgressItem(item)) {
      return 'extended';
    }

    if (isCompletedSemanticItem(item)) {
      return 'default';
    }

    if (isLifecycleItem(item) || isErrorItem(item) || item.type === 'hook.effect') {
      return 'default';
    }

    return 'extended';
  }

  shouldRetain(item: Item, options: ShouldRetainItemOptions = {}): boolean {
    const retentionClass = this.classify(item);

    if (retentionClass === 'discard') {
      return false;
    }

    return retentionClass === 'default' || options.mode === 'extended';
  }
}

function isInternalItem(item: Item): boolean {
  return item.visibility === 'internal' || item.type.startsWith('internal.');
}

function isCompletedSemanticItem(item: Item): boolean {
  return (
    item.type === 'user.message.completed' ||
    item.type === 'assistant.message.completed' ||
    item.type === 'tool.result.completed'
  );
}

function isLifecycleItem(item: Item): boolean {
  return (
    item.type.startsWith('run.') ||
    item.type.startsWith('turn.') ||
    item.type.startsWith('model.request.') ||
    item.type === 'assistant.message.started' ||
    item.type === 'tool.call.started'
  );
}

function isDeltaOrProgressItem(item: Item): boolean {
  return item.type.endsWith('.delta') || item.type.endsWith('.progress');
}

function isErrorItem(item: Item): boolean {
  return item.type.endsWith('.error') || item.type === 'error';
}
