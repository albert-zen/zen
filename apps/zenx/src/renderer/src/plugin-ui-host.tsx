import React, { useEffect, useMemo, useRef } from "react";

import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";

export interface PluginUiSdkV1 {
  readonly version: 1;
  readonly pluginId: string;
  readonly theme: "light" | "dark";
  readonly context: Readonly<Record<string, unknown>>;
  readonly navigation: { navigate(route: string): void };
  readonly handles: { read(handleId: string): Promise<unknown> };
  readonly commands: {
    execute(commandId: string, input?: unknown): Promise<unknown>;
  };
}

export interface PluginUiSurfaceProps {
  sdk: PluginUiSdkV1;
}

export type PluginUiModule = Record<
  string,
  React.ComponentType<PluginUiSurfaceProps>
>;

export interface PluginUiRegistry {
  registerTrusted(entry: string, module: PluginUiModule): () => void;
  resolveTrusted(entry: string): PluginUiModule | undefined;
}

export function createPluginUiRegistry(): PluginUiRegistry {
  const trusted = new Map<string, PluginUiModule>();
  return {
    registerTrusted(entry, module) {
      if (trusted.has(entry))
        throw new Error(
          `Trusted plugin UI bundle already registered: ${entry}`,
        );
      trusted.set(entry, module);
      return () => {
        if (trusted.get(entry) === module) trusted.delete(entry);
      };
    },
    resolveTrusted: (entry) => trusted.get(entry),
  };
}

export function GenericPluginUiHost({
  registry,
  snapshot,
  pluginId,
  surfaceId,
  context,
  theme,
  executeCommand,
  readHandle,
  className,
  navigate = () => {},
}: {
  registry: PluginUiRegistry;
  snapshot: ZenXPluginSnapshot;
  pluginId: string;
  surfaceId: string;
  context: Readonly<Record<string, unknown>>;
  theme: "light" | "dark";
  executeCommand(
    pluginId: string,
    commandId: string,
    input?: unknown,
  ): Promise<unknown>;
  readHandle(pluginId: string, handleId: string): Promise<unknown>;
  navigate?(route: string): void;
  className?: string;
}) {
  const surface = (snapshot.surfaces ?? []).find(
    (candidate) =>
      candidate.pluginId === pluginId && candidate.id === surfaceId,
  );
  const bundle = (snapshot.bundles ?? []).find(
    (candidate) =>
      candidate.pluginId === pluginId && candidate.id === surface?.bundleId,
  );
  const sdk = useMemo<PluginUiSdkV1>(
    () =>
      Object.freeze({
        version: 1 as const,
        pluginId,
        theme,
        context: Object.freeze(structuredClone(context)),
        navigation: Object.freeze({ navigate }),
        handles: Object.freeze({
          read: async (handleId: string) =>
            await readHandle(pluginId, handleId),
        }),
        commands: Object.freeze({
          execute: async (commandId: string, input?: unknown) =>
            await executeCommand(pluginId, commandId, input),
        }),
      }),
    [context, executeCommand, navigate, pluginId, readHandle, theme],
  );

  if (surface === undefined || bundle === undefined) {
    return <p role="status">Plugin surface is no longer available.</p>;
  }
  if (bundle.apiVersion !== 1) {
    return <p role="status">Plugin UI API version is not supported.</p>;
  }
  if (bundle.kind === "isolated") {
    return (
      <IsolatedPluginSurface
        className={className}
        bundleHtml={bundle.entry}
        exportName={surface.exportName}
        sdk={sdk}
      />
    );
  }
  const module = registry.resolveTrusted(bundle.entry);
  const Surface = module?.[surface.exportName];
  if (Surface === undefined) {
    return <p role="status">Plugin UI module is unavailable.</p>;
  }
  return (
    <section
      className={className}
      data-plugin-surface={`${pluginId}:${surfaceId}`}
    >
      <Surface sdk={sdk} />
    </section>
  );
}

function IsolatedPluginSurface({
  bundleHtml,
  exportName,
  sdk,
  className,
}: {
  bundleHtml: string;
  exportName: string;
  sdk: PluginUiSdkV1;
  className?: string;
}) {
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useMemo(
    () => `zenx-ui-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`,
    [],
  );
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      if (
        event.source !== frame.current?.contentWindow ||
        !isUiRequest(event.data, channel)
      )
        return;
      const operation =
        event.data.operation === "commands.execute"
          ? sdk.commands.execute(event.data.id, event.data.input)
          : event.data.operation === "handles.read"
            ? sdk.handles.read(event.data.id)
            : Promise.resolve(
                sdk.navigation.navigate(String(event.data.input)),
              );
      void operation.then(
        (value) =>
          frame.current?.contentWindow?.postMessage(
            {
              channel,
              type: "zenx-plugin-ui:result",
              requestId: event.data.requestId,
              value,
            },
            "*",
          ),
        (error: unknown) =>
          frame.current?.contentWindow?.postMessage(
            {
              channel,
              type: "zenx-plugin-ui:error",
              requestId: event.data.requestId,
              message: error instanceof Error ? error.message : String(error),
            },
            "*",
          ),
      );
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [channel, sdk]);
  return (
    <iframe
      className={className}
      ref={frame}
      sandbox="allow-scripts"
      title={`${sdk.pluginId} plugin surface`}
      srcDoc={isolatedDocument(bundleHtml, {
        channel,
        exportName,
        pluginId: sdk.pluginId,
        theme: sdk.theme,
        context: sdk.context,
      })}
    />
  );
}

function isolatedDocument(
  html: string,
  init: Readonly<Record<string, unknown>>,
): string {
  const payload = JSON.stringify(init).replaceAll("<", "\\u003c");
  return `<!doctype html><html data-theme="${String(init.theme)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"></head><body>${html}<script>(()=>{const init=${payload};window.zenxPluginUi=Object.freeze({version:1,pluginId:init.pluginId,theme:init.theme,context:Object.freeze(init.context),commands:{execute:(id,input)=>request('commands.execute',id,input)},handles:{read:(id)=>request('handles.read',id)},navigation:{navigate:(route)=>request('navigation.navigate','route',route)}});let sequence=0;const pending=new Map();function request(operation,id,input){const requestId=String(++sequence);parent.postMessage({channel:init.channel,type:'zenx-plugin-ui:request',requestId,operation,id,input},'*');return new Promise((resolve,reject)=>pending.set(requestId,{resolve,reject}));}addEventListener('message',(event)=>{const message=event.data;if(!message||message.channel!==init.channel)return;const waiter=pending.get(message.requestId);if(!waiter)return;pending.delete(message.requestId);message.type==='zenx-plugin-ui:result'?waiter.resolve(message.value):waiter.reject(new Error(message.message));});dispatchEvent(new CustomEvent('zenx-plugin-ui:init',{detail:{exportName:init.exportName,sdk:window.zenxPluginUi}}));})();</script></body></html>`;
}

function isUiRequest(
  value: unknown,
  channel: string,
): value is {
  channel: string;
  type: "zenx-plugin-ui:request";
  requestId: string;
  operation: "commands.execute" | "handles.read" | "navigation.navigate";
  id: string;
  input?: unknown;
} {
  if (typeof value !== "object" || value === null) return false;
  const message = value as Record<string, unknown>;
  return (
    message.channel === channel &&
    message.type === "zenx-plugin-ui:request" &&
    typeof message.requestId === "string" &&
    (message.operation === "commands.execute" ||
      message.operation === "handles.read" ||
      message.operation === "navigation.navigate") &&
    typeof message.id === "string" &&
    message.id.length > 0
  );
}
