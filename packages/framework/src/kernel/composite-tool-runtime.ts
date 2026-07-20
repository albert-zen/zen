import type {
  ToolCallPayload,
  ToolExecutionContext,
  ToolRuntime,
  ToolRuntimeEvent,
} from './tool-runtime.js';

export type ToolRuntimeRoute = {
  readonly matches: (call: ToolCallPayload) => boolean;
  readonly runtime: ToolRuntime;
};

/** A small dispatch boundary for independently owned tool families. */
export class CompositeToolRuntime implements ToolRuntime {
  constructor(private readonly routes: readonly ToolRuntimeRoute[]) {}

  async *execute(
    call: ToolCallPayload,
    context: ToolExecutionContext
  ): AsyncIterable<ToolRuntimeEvent> {
    const route = this.routes.find((candidate) => candidate.matches(call));
    if (!route) {
      yield { type: 'error', error: new Error(`Unknown tool: ${call.name}`) };
      return;
    }
    yield* route.runtime.execute(call, context);
  }
}
