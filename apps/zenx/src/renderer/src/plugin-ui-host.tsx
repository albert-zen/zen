import { i18n } from "./i18n.js";
import { useTranslation } from "react-i18next";
import {
  usePluginTheme,
  pluginBaseStyles,
  type PluginThemeV1,
} from "./ui/plugin-theme.js";
import React, { useEffect, useMemo, useRef } from "react";

import type { ZenXPluginSnapshot } from "../../main/capabilities/types.js";

export interface PluginUiSdkV1 {
  readonly version: 1;
  readonly pluginId: string;
  readonly theme: "light" | "dark";
  readonly appearance?: PluginThemeV1;
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
  useTranslation("panels");
  const surface = (snapshot.surfaces ?? []).find(
    (candidate) =>
      candidate.pluginId === pluginId && candidate.id === surfaceId,
  );
  const bundle = (snapshot.bundles ?? []).find(
    (candidate) =>
      candidate.pluginId === pluginId && candidate.id === surface?.bundleId,
  );
  const appearance = usePluginTheme();
  const sdk = useMemo<PluginUiSdkV1>(
    () =>
      Object.freeze({
        version: 1 as const,
        pluginId,
        theme,
        appearance,
        context: immutableClone(context),
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
    [
      context,
      executeCommand,
      navigate,
      pluginId,
      readHandle,
      theme,
      appearance,
    ],
  );

  if (surface === undefined || bundle === undefined) {
    return (
      <p role="status">{i18n.t("panels:pluginSurfaceIsNoLongerAvailable")}</p>
    );
  }
  if (bundle.apiVersion !== 1) {
    return (
      <p role="status">{i18n.t("panels:pluginUiApiVersionIsNotSupported")}</p>
    );
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
    return <p role="status">{i18n.t("panels:pluginUiModuleIsUnavailable")}</p>;
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

function immutableClone<T>(value: T): T {
  const clone = structuredClone(value);
  const freeze = (entry: unknown): void => {
    if (typeof entry !== "object" || entry === null || Object.isFrozen(entry))
      return;
    for (const child of Array.isArray(entry)
      ? entry
      : Object.values(entry as Record<string, unknown>))
      freeze(child);
    Object.freeze(entry);
  };
  freeze(clone);
  return clone;
}

export function IsolatedPluginSurface({
  bundleHtml,
  exportName,
  sdk,
  className,
  requireUserActivationFor,
  interactionScope,
}: {
  bundleHtml: string;
  exportName: string;
  sdk: PluginUiSdkV1;
  className?: string;
  /** Board effects need a click/key in the focused frame; not a second permission prompt. */
  requireUserActivationFor?: readonly string[];
  interactionScope?: string;
}) {
  useTranslation("panels");
  const frame = useRef<HTMLIFrameElement>(null);
  const channel = useMemo(
    () => `zenx-ui-${crypto.getRandomValues(new Uint32Array(4)).join("-")}`,
    [],
  );
  const gesture = useRef<{
    nonce: string;
    sequence: number;
    expiresAt: number;
  } | null>(null);
  const previousFocus = useRef<HTMLElement | null>(null);
  useEffect(() => {
    gesture.current = null;
  }, [bundleHtml]);
  useEffect(() => {
    if (!requireUserActivationFor) return;
    let pending: number | undefined;
    const remember = (event: FocusEvent) => {
      if (event.target instanceof HTMLElement && event.target !== frame.current)
        previousFocus.current = event.target;
    };
    const restore = () => {
      pending = requestAnimationFrame(() => {
        if (
          document.hasFocus() &&
          document.activeElement === frame.current &&
          (gesture.current?.expiresAt ?? 0) <= performance.now() &&
          previousFocus.current?.isConnected
        )
          previousFocus.current.focus({ preventScroll: true });
      });
    };
    document.addEventListener("focusin", remember);
    window.addEventListener("blur", restore);
    return () => {
      document.removeEventListener("focusin", remember);
      window.removeEventListener("blur", restore);
      if (pending !== undefined) cancelAnimationFrame(pending);
    };
  }, [requireUserActivationFor]);
  const interactions = useRef(
    new Map<string, { scope: string | undefined; expiresAt: number }>(),
  );
  useEffect(() => {
    interactions.current.clear();
  }, [bundleHtml, interactionScope]);
  useEffect(() => {
    const receive = (event: MessageEvent) => {
      const requestWindow = frame.current?.contentWindow;
      if (
        !requestWindow ||
        event.source !== requestWindow ||
        event.data?.channel !== channel
      )
        return;
      // The bootstrap runs before custom scripts and keeps this witness in a closure.
      // Browser-created pointer/key input can emit it; focus(), .click() and page messages cannot mint it.
      if (event.data.type === "zenx-plugin-ui:gesture-register") {
        if (
          gesture.current === null &&
          typeof event.data.nonce === "string" &&
          event.data.nonce.length <= 128
        )
          gesture.current = {
            nonce: event.data.nonce,
            sequence: 0,
            expiresAt: 0,
          };
        return;
      }
      if (event.data.type === "zenx-plugin-ui:gesture") {
        if (
          gesture.current &&
          event.data.nonce === gesture.current.nonce &&
          Number.isSafeInteger(event.data.sequence) &&
          event.data.sequence > gesture.current.sequence
        ) {
          gesture.current.sequence = event.data.sequence;
          gesture.current.expiresAt = performance.now() + 5_000;
        }
        return;
      }
      if (event.data.type === "zenx-plugin-ui:ready") {
        requestWindow.postMessage(
          {
            channel,
            type: "zenx-plugin-ui:update",
            theme: sdk.theme,
            appearance: sdk.appearance,
            context: sdk.context,
          },
          "*",
        );
        return;
      }
      if (!isUiRequest(event.data, channel)) return;
      const activated =
        document.activeElement === frame.current &&
        (gesture.current?.expiresAt ?? 0) > performance.now();
      const validInteraction =
        typeof event.data.interactionId === "string" &&
        interactions.current.has(event.data.interactionId) &&
        interactions.current.get(event.data.interactionId)?.scope ===
          interactionScope &&
        performance.now() <
          interactions.current.get(event.data.interactionId)!.expiresAt;
      let operation: Promise<unknown>;
      if (event.data.operation === "interaction.begin") {
        for (const [id, entry] of interactions.current)
          if (performance.now() >= entry.expiresAt)
            interactions.current.delete(id);
        if (!requireUserActivationFor || !activated)
          operation = Promise.reject(
            new Error(
              "This Board interaction requires a user click or key press in its custom content",
            ),
          );
        else if (interactions.current.size >= 4)
          operation = Promise.reject(
            new Error("Too many active Board interactions"),
          );
        else {
          const token = crypto.randomUUID();
          for (const [id, entry] of interactions.current)
            if (performance.now() >= entry.expiresAt)
              interactions.current.delete(id);
          interactions.current.set(token, {
            scope: interactionScope,
            expiresAt: performance.now() + 5 * 60_000,
          });
          operation = Promise.resolve(token);
        }
      } else if (event.data.operation === "interaction.end") {
        interactions.current.delete(event.data.id);
        operation = Promise.resolve(null);
      } else if (
        requireUserActivationFor &&
        ((event.data.operation === "commands.execute" &&
          requireUserActivationFor.includes(event.data.id)) ||
          event.data.operation === "navigation.navigate") &&
        (event.data.interactionId !== undefined
          ? !validInteraction
          : !activated)
      ) {
        operation = Promise.reject(
          new Error(
            "This Board action requires a user click or key press in its custom content",
          ),
        );
      } else
        operation =
          event.data.operation === "commands.execute"
            ? sdk.commands.execute(event.data.id, event.data.input)
            : event.data.operation === "handles.read"
              ? sdk.handles.read(event.data.id)
              : Promise.resolve(
                  sdk.navigation.navigate(String(event.data.input)),
                );
      void operation.then(
        (value) => {
          if (frame.current?.contentWindow !== requestWindow) return;
          requestWindow.postMessage(
            {
              channel,
              type: "zenx-plugin-ui:result",
              requestId: event.data.requestId,
              value,
            },
            "*",
          );
        },
        (error: unknown) => {
          if (frame.current?.contentWindow !== requestWindow) return;
          requestWindow.postMessage(
            {
              channel,
              type: "zenx-plugin-ui:error",
              requestId: event.data.requestId,
              message: error instanceof Error ? error.message : String(error),
            },
            "*",
          );
        },
      );
    };
    window.addEventListener("message", receive);
    return () => window.removeEventListener("message", receive);
  }, [channel, sdk, requireUserActivationFor, interactionScope]);
  const initialized = useRef(new WeakSet<HTMLIFrameElement>());
  const initialSdk = useRef(sdk);
  initialSdk.current = sdk;
  const html = useMemo(
    () =>
      isolatedDocument(bundleHtml, {
        channel,
        exportName,
        pluginId: initialSdk.current.pluginId,
        theme: initialSdk.current.theme,
        appearance: initialSdk.current.appearance,
        context: initialSdk.current.context,
      }),
    [bundleHtml, channel, exportName, sdk.pluginId],
  );
  const update = () =>
    frame.current?.contentWindow?.postMessage(
      {
        channel,
        type: "zenx-plugin-ui:update",
        theme: sdk.theme,
        appearance: sdk.appearance,
        context: sdk.context,
      },
      "*",
    );
  useEffect(() => {
    update();
  }, [sdk, channel]);

  return (
    <iframe
      key={html}
      className={className}
      ref={frame}
      sandbox="allow-scripts"
      title={`${sdk.pluginId} plugin surface`}
      src="./plugin-frame.html"
      onLoad={(event) => {
        const element = event.currentTarget;
        if (initialized.current.has(element)) {
          if (
            requireUserActivationFor &&
            document.activeElement === element &&
            (gesture.current?.expiresAt ?? 0) <= performance.now() &&
            previousFocus.current?.isConnected
          )
            previousFocus.current.focus({ preventScroll: true });
          return;
        }
        if (
          document.activeElement instanceof HTMLElement &&
          document.activeElement !== element
        )
          previousFocus.current = document.activeElement;
        initialized.current.add(element);
        element.contentWindow?.postMessage(
          { type: "zenx-plugin-ui:document", html },
          "*",
        );
      }}
    />
  );
}

export function isolatedDocument(
  html: string,
  init: Readonly<Record<string, unknown>>,
): string {
  const payload = JSON.stringify(init).replaceAll("<", "\\u003c");
  // Bootstrap precedes all custom HTML. The random input witness is not placed in
  // document markup, SDK properties or messages delivered back to this frame.
  return `<!doctype html><html data-theme="${String(init.theme)}"><head><meta charset="utf-8"><meta http-equiv="Content-Security-Policy" content="default-src 'none'; img-src data:; style-src 'unsafe-inline'; script-src 'unsafe-inline'"><style>${pluginBaseStyles}</style></head><body><script>(()=>{
const init=${payload};const deepFreeze=(value)=>{if(!value||typeof value!=='object'||Object.isFrozen(value))return value;Object.values(value).forEach(deepFreeze);return Object.freeze(value)};
const post=parent.postMessage.bind(parent), listen=addEventListener.bind(window);
const nonce=crypto.getRandomValues(new Uint32Array(8)).join('-');let gestureSequence=0;
post({channel:init.channel,type:'zenx-plugin-ui:gesture-register',nonce},'*');
const witness=(event)=>{if(event.isTrusted)post({channel:init.channel,type:'zenx-plugin-ui:gesture',nonce,sequence:++gestureSequence},'*')};
listen('pointerdown',witness,true);listen('keydown',witness,true);
function applyTheme(){document.documentElement.dataset.theme=init.theme;document.documentElement.style.colorScheme=init.theme;Object.entries(init.appearance?.variables||{}).forEach(([key,value])=>document.documentElement.style.setProperty(key,value));}applyTheme();
let sequence=0;const pending=new Map();
function request(operation,id,input,interactionId){const requestId=String(++sequence);return new Promise((resolve,reject)=>{pending.set(requestId,{resolve,reject});post({channel:init.channel,type:'zenx-plugin-ui:request',requestId,operation,id,input,interactionId},'*')});}
Object.defineProperty(window,'zenxPluginUi',{value:Object.freeze({version:1,pluginId:init.pluginId,get theme(){return init.theme},get appearance(){return deepFreeze(init.appearance)},get context(){return deepFreeze(init.context)},commands:{execute:(id,input)=>request('commands.execute',id,input)},handles:{read:(id)=>request('handles.read',id)},navigation:{navigate:(route)=>request('navigation.navigate','route',route)},interaction:{run:async(callback)=>{const token=await request('interaction.begin','interaction');try{return await callback({commands:{execute:(id,input)=>request('commands.execute',id,input,token)},navigation:{navigate:(route)=>request('navigation.navigate','route',route,token)}})}finally{await request('interaction.end',token)}}}})});
listen('message',(event)=>{const message=event.data;if(!message||message.channel!==init.channel||event.source!==parent)return;if(message.type==='zenx-plugin-ui:update'){init.theme=message.theme;init.appearance=message.appearance;init.context=message.context;applyTheme();dispatchEvent(new CustomEvent('zenx-plugin-ui:change',{detail:{sdk:window.zenxPluginUi}}));return;}if(message.type!=='zenx-plugin-ui:result'&&message.type!=='zenx-plugin-ui:error')return;const waiter=pending.get(message.requestId);if(!waiter)return;pending.delete(message.requestId);message.type==='zenx-plugin-ui:result'?waiter.resolve(message.value):waiter.reject(new Error(message.message));});
post({channel:init.channel,type:'zenx-plugin-ui:ready'},'*');
})();</script>${html}<script>dispatchEvent(new CustomEvent('zenx-plugin-ui:init',{detail:{exportName:${JSON.stringify(init.exportName)},sdk:window.zenxPluginUi}}));</script></body></html>`;
}

function isUiRequest(
  value: unknown,
  channel: string,
): value is {
  channel: string;
  type: "zenx-plugin-ui:request";
  requestId: string;
  operation:
    | "commands.execute"
    | "handles.read"
    | "navigation.navigate"
    | "interaction.begin"
    | "interaction.end";
  interactionId?: string;
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
      message.operation === "navigation.navigate" ||
      message.operation === "interaction.begin" ||
      message.operation === "interaction.end") &&
    typeof message.id === "string" &&
    message.id.length > 0
  );
}
