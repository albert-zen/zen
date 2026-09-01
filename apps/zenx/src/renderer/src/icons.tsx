import type { ReactNode, SVGProps } from "react";
import type { ZenXPluginIconName } from "../../main/capabilities/types.js";

import React from "react";

export type IconName =
  | ZenXPluginIconName
  | "arrow-down"
  | "archive"
  | "check"
  | "chevron-down"
  | "chevron-left"
  | "chevron-right"
  | "compose"
  | "copy"
  | "folder"
  | "file"
  | "inbox"
  | "folder-plus"
  | "grip"
  | "layers"
  | "lock"
  | "moon"
  | "more"
  | "paperclip"
  | "panel-left"
  | "panel-right"
  | "pin"
  | "pin-off"
  | "reasoning"
  | "restore"
  | "settings"
  | "search"
  | "thread"
  | "trigger"
  | "tree"
  | "stop"
  | "send"
  | "terminal"
  | "users"
  | "x"
  | "warning";

type IconProps = SVGProps<SVGSVGElement> & {
  name: IconName;
  size?: number;
};

const paths: Record<IconName, ReactNode> = {
  "arrow-down": <path d="M8 2.2v11.2m-4-4 4 4 4-4" />,
  archive: (
    <>
      <path d="M2.2 4.8h11.6v8.5H2.2zM1.6 2.3h12.8v2.5H1.6z" />
      <path d="M6 8h4" />
    </>
  ),
  check: <path d="m2.4 8.4 3.4 3.4 7.8-7.8" />,
  clock: (
    <>
      <circle cx="8" cy="8" r="5.7" />
      <path d="M8 4.5V8l2.5 1.5" />
    </>
  ),
  "chevron-down": <path d="m3.6 6 4.4 4.4L12.4 6" />,
  "chevron-left": <path d="m10 3.6-4.4 4.4 4.4 4.4" />,
  "chevron-right": <path d="m6 3.6 4.4 4.4L6 12.4" />,
  compose: (
    <>
      <path d="M7.3 3H3.4C2.6 3 2 3.6 2 4.4v8.2c0 .8.6 1.4 1.4 1.4h8.2c.8 0 1.4-.6 1.4-1.4V8.7" />
      <path d="M12.6 1.9a1.6 1.6 0 0 1 2.3 2.3L9 10.1l-3 .7.7-3 5.9-5.9Z" />
    </>
  ),
  copy: (
    <>
      <rect x="5.2" y="2.2" width="8.6" height="8.6" rx="1.4" />
      <path d="M10.8 10.8v1.4c0 .9-.7 1.6-1.6 1.6H3.8c-.9 0-1.6-.7-1.6-1.6V6.8c0-.9.7-1.6 1.6-1.6h1.4" />
    </>
  ),
  folder: (
    <path d="M1.8 4.2C1.8 3.5 2.3 3 3 3h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2Z" />
  ),
  "folder-plus": (
    <>
      <path d="M1.8 4.2C1.8 3.5 2.3 3 3 3h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2Z" />
      <path d="M8 7v4M6 9h4" />
    </>
  ),
  grip: (
    <>
      <circle cx="5.5" cy="4" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="4" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="8" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="8" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="5.5" cy="12" r="0.6" fill="currentColor" stroke="none" />
      <circle cx="10.5" cy="12" r="0.6" fill="currentColor" stroke="none" />
    </>
  ),
  file: (
    <>
      <path d="M4 1.8h5.2l2.8 2.8v9.6H4z" />
      <path d="M9.2 1.8v3h3" />
    </>
  ),
  inbox: (
    <>
      <path d="M2 9.5h3.4l1.2 1.8h2.8l1.2-1.8H14" />
      <path d="M3.4 3.4h9.2L14 9.5v3.1c0 .6-.5 1-1 1H3c-.5 0-1-.4-1-1V9.5l1.4-6.1Z" />
    </>
  ),
  moon: <path d="M13.4 9.4A5.8 5.8 0 0 1 6.6 2.6a5.8 5.8 0 1 0 6.8 6.8Z" />,
  more: <path d="M3 8h.01M8 8h.01M13 8h.01" strokeWidth="2.8" />,
  layers: (
    <>
      <path d="m8 2 6 3.2-6 3.2-6-3.2Z" />
      <path d="m2 8.2 6 3.2 6-3.2M2 11.1l6 3.2 6-3.2" />
    </>
  ),
  lock: (
    <>
      <rect x="3" y="7" width="10" height="7" rx="1.5" />
      <path d="M5.5 7V5a2.5 2.5 0 0 1 5 0v2" />
    </>
  ),
  paperclip: (
    <path d="m13.5 7.7-6.2 6.2a3.5 3.5 0 0 1-5-5l7-7a2.4 2.4 0 0 1 3.4 3.4l-7 7a1.3 1.3 0 0 1-1.8-1.8l6.2-6.2" />
  ),
  "panel-left": (
    <>
      <rect x="1.8" y="2.2" width="12.4" height="11.6" rx="1.5" />
      <path d="M5.8 2.2v11.6" />
    </>
  ),
  "panel-right": (
    <>
      <rect x="1.8" y="2.2" width="12.4" height="11.6" rx="1.5" />
      <path d="M10.2 2.2v11.6" />
    </>
  ),
  pin: (
    <>
      <path d="m5 2 6 6M4.2 7.2l4.6 4.6M3 10l3 3M6.2 3.2l6.6 6.6-2.7.3-3.9-3.9.3-2.7Z" />
      <path d="m6 12-3 3" />
    </>
  ),
  plug: (
    <>
      <path d="M5.2 2.2v3M10.8 2.2v3M3.8 5.2h8.4v1.5A4.2 4.2 0 0 1 8 10.9 4.2 4.2 0 0 1 3.8 6.7V5.2Z" />
      <path d="M8 10.9v2.9" />
    </>
  ),
  "pin-off": (
    <>
      <path d="m4 2 10 12M6.2 3.2l6.6 6.6-2.1.2M4.2 7.2l4.6 4.6M3 10l3 3M6 12l-3 3" />
    </>
  ),
  reasoning: (
    <>
      <path d="M8 2.1a4.4 4.4 0 0 0-2.7 7.9c.5.4.8.9.8 1.5h3.8c0-.6.3-1.1.8-1.5A4.4 4.4 0 0 0 8 2.1Z" />
      <path d="M6.5 13.8h3M6.2 11.5h3.6" />
    </>
  ),
  restore: (
    <>
      <path d="M3.1 5.6A5.4 5.4 0 1 1 2.8 10" />
      <path d="M2.8 2.5v3.7h3.7" />
    </>
  ),
  settings: (
    <>
      <circle cx="8" cy="8" r="2.2" />
      <path d="M8 1.8v1.3M8 12.9v1.3M1.8 8h1.3M12.9 8h1.3M3.6 3.6l.9.9M11.5 11.5l.9.9M12.4 3.6l-.9.9M4.5 11.5l-.9.9" />
    </>
  ),
  search: (
    <>
      <circle cx="7.2" cy="7.2" r="4.6" />
      <path d="m10.8 10.8 3.4 3.4" />
    </>
  ),
  thread: (
    <>
      <path d="M2.5 3.5h11M5.5 8h8M5.5 12.5h8" />
      <circle cx="3" cy="8" r=".2" />
      <circle cx="3" cy="12.5" r=".2" />
    </>
  ),
  trigger: <path d="M8.8 1.6 3.4 9h3.4l-.9 5.4L11.3 7H7.9l.9-5.4Z" />,
  stop: <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.5" />,
  send: <path d="m3 8 5-5 5 5M8 3v10" />,
  terminal: (
    <>
      <rect x="1.8" y="2.4" width="12.4" height="11.2" rx="1.8" />
      <path d="m4.5 6 2 2-2 2M8.5 10h3" />
    </>
  ),
  tree: (
    <>
      <path d="M2.5 3.5h11M5.5 8h8M5.5 12.5h8" />
      <circle cx="3" cy="8" r=".2" />
      <circle cx="3" cy="12.5" r=".2" />
    </>
  ),
  users: (
    <>
      <circle cx="6" cy="5.2" r="2.2" />
      <path d="M1.8 13c.3-2.8 1.7-4 4.2-4s3.9 1.2 4.2 4" />
      <circle cx="11.7" cy="6" r="1.6" />
      <path d="M10.5 9.8c2.2-.3 3.4.7 3.7 2.6" />
    </>
  ),
  x: <path d="m3 3 10 10M13 3 3 13" />,
  warning: (
    <>
      <path d="M8 2 1.8 13h12.4L8 2Z" />
      <path d="M8 6.5v3M8 11.6v.1" />
    </>
  ),
};

export function Icon({ name, size = 16, ...props }: IconProps) {
  return (
    <svg
      aria-hidden="true"
      data-icon={name}
      fill="none"
      height={size}
      viewBox="0 0 16 16"
      width={size}
      {...props}
    >
      <g
        stroke="currentColor"
        strokeLinecap="round"
        strokeLinejoin="round"
        strokeWidth="1.6"
      >
        {paths[name]}
      </g>
    </svg>
  );
}
