import type { AppServerNotification } from './app-server-protocol.js';
import type { JsonObject, JsonValue, ProjectSnapshot } from './index.js';

export type AgentAppErrorCode =
  | 'PROJECT_NOT_FOUND'
  | 'PROJECT_ARCHIVED'
  | 'THREAD_NOT_FOUND'
  | 'POLICY_DENIED'
  | 'IDEMPOTENCY_CONFLICT'
  | 'WAIT_CYCLE'
  | 'RESOURCE_EXHAUSTED'
  | 'PERSISTENCE_FAILURE'
  | 'INVALID_REQUEST'
  | 'SERVER_CLOSING';
export type AgentAppError = {
  readonly code: AgentAppErrorCode;
  readonly message: string;
  readonly details?: JsonValue;
};
export type AgentAppMethod =
  | 'project/create'
  | 'project/list'
  | 'project/read'
  | 'project/update'
  | 'project/archive'
  | 'thread/create'
  | 'thread/list'
  | 'thread/read'
  | 'thread/send'
  | 'thread/wait'
  | 'thread/cancel'
  | 'thread/archive'
  | 'thread/handoff'
  | 'turn/start'
  | 'turn/interrupt'
  | 'turn/retry'
  | 'approval/resolve';
export type AgentAppRequest = {
  readonly id?: string;
  readonly method: AgentAppMethod;
  readonly params: JsonObject;
};
export type AgentAppResponse =
  | {
      readonly id?: string;
      readonly method: AgentAppMethod;
      readonly ok: true;
      readonly result: Readonly<Record<string, unknown>>;
    }
  | {
      readonly id?: string;
      readonly method: string;
      readonly ok: false;
      readonly error: AgentAppError;
    };
export type AgentAppNotificationEnvelope = {
  readonly projectId: string;
  readonly notification: AgentAppNotification;
};
export type AgentAppNotification = AppServerNotification;

/** The only remotely consumable Agent App protocol surface. */
export type AgentAppSubscription = () => void;
export type AgentAppNotificationListener = (notification: AgentAppNotificationEnvelope) => void;
export interface AgentAppClient {
  request(request: AgentAppRequest): Promise<AgentAppResponse>;
  subscribe(listener: AgentAppNotificationListener): AgentAppSubscription;
}

const projectScoped = new Set<AgentAppMethod>([
  'project/read',
  'project/update',
  'project/archive',
  'thread/create',
  'thread/list',
  'thread/read',
  'thread/send',
  'thread/wait',
  'thread/cancel',
  'thread/archive',
  'thread/handoff',
  'turn/start',
  'turn/interrupt',
  'turn/retry',
  'approval/resolve',
]);
const mutations = new Set<AgentAppMethod>([
  'project/create',
  'project/update',
  'project/archive',
  'thread/create',
  'thread/send',
  'thread/cancel',
  'thread/archive',
  'thread/handoff',
  'turn/start',
  'turn/interrupt',
  'turn/retry',
  'approval/resolve',
]);
export function parseAgentAppRequest(value: unknown): AgentAppRequest {
  if (
    !isRecord(value) ||
    typeof value.method !== 'string' ||
    !isMethod(value.method) ||
    !isRecord(value.params) ||
    (value.id !== undefined && !nonEmpty(value.id))
  )
    throw new Error('Invalid AgentApp request');
  assertSafeJson(value);
  const params = value.params as JsonObject;
  if (projectScoped.has(value.method) && !nonEmpty(params.projectId))
    throw new Error('projectId is required');
  if (mutations.has(value.method) && !nonEmpty(params.idempotencyKey))
    throw new Error('idempotencyKey is required');
  if (
    value.method.startsWith('thread/') ||
    value.method.startsWith('turn/') ||
    value.method === 'approval/resolve'
  ) {
    if (!nonEmpty(params.threadId) && !['thread/create', 'thread/list'].includes(value.method))
      throw new Error('threadId is required');
  }
  return { ...(value.id === undefined ? {} : { id: value.id }), method: value.method, params };
}

const MAX_REQUEST_BYTES = 65_536;
const MAX_JSON_DEPTH = 4;

function assertSafeJson(value: unknown, depth = 0): asserts value is JsonValue {
  if (depth > MAX_JSON_DEPTH) throw new Error('Request JSON depth exceeded');
  if (value === null || typeof value === 'boolean') return;
  if (typeof value === 'string') {
    if (Buffer.byteLength(value, 'utf8') > MAX_REQUEST_BYTES)
      throw new Error('Request JSON size exceeded');
    return;
  }
  if (typeof value === 'number') {
    if (!Number.isFinite(value)) throw new Error('Request JSON must be finite');
    return;
  }
  if (Array.isArray(value)) {
    value.forEach((entry) => assertSafeJson(entry, depth + 1));
    return;
  }
  if (!isRecord(value)) throw new Error('Request JSON is invalid');
  for (const [key, entry] of Object.entries(value)) {
    if (key === '__proto__' || key === 'prototype' || key === 'constructor') {
      throw new Error('Request JSON contains unsafe key');
    }
    assertSafeJson(entry, depth + 1);
  }
  let serialized: string;
  try {
    serialized = JSON.stringify(value);
  } catch {
    throw new Error('Request JSON is invalid');
  }
  if (Buffer.byteLength(serialized, 'utf8') > MAX_REQUEST_BYTES) {
    throw new Error('Request JSON size exceeded');
  }
}
function isMethod(value: string): value is AgentAppMethod {
  return [
    'project/create',
    'project/list',
    'project/read',
    'project/update',
    'project/archive',
    'thread/create',
    'thread/list',
    'thread/read',
    'thread/send',
    'thread/wait',
    'thread/cancel',
    'thread/archive',
    'thread/handoff',
    'turn/start',
    'turn/interrupt',
    'turn/retry',
    'approval/resolve',
  ].includes(value);
}
function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
function nonEmpty(value: unknown): value is string {
  return typeof value === 'string' && value.length > 0;
}
export type AgentAppProjectResult = { readonly project: ProjectSnapshot };
