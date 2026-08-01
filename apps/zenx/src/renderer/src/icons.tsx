import type { ReactNode, SVGProps } from "react";

type IconName =
  | "check"
  | "chevron-down"
  | "chevron-right"
  | "compose"
  | "folder"
  | "inbox"
  | "panel-right"
  | "reasoning"
  | "search"
  | "thread"
  | "tree"
  | "stop"
  | "warning";

type IconProps = SVGProps<SVGSVGElement> & {
  name: IconName;
  size?: number;
};

const paths: Record<IconName, ReactNode> = {
  check: <path d="m2.4 8.4 3.4 3.4 7.8-7.8" />,
  "chevron-down": <path d="m3.6 6 4.4 4.4L12.4 6" />,
  "chevron-right": <path d="m6 3.6 4.4 4.4L6 12.4" />,
  compose: (
    <>
      <path d="M7.3 3H3.4C2.6 3 2 3.6 2 4.4v8.2c0 .8.6 1.4 1.4 1.4h8.2c.8 0 1.4-.6 1.4-1.4V8.7" />
      <path d="M12.6 1.9a1.6 1.6 0 0 1 2.3 2.3L9 10.1l-3 .7.7-3 5.9-5.9Z" />
    </>
  ),
  folder: (
    <path d="M1.8 4.2C1.8 3.5 2.3 3 3 3h3l1.4 1.6H13c.7 0 1.2.5 1.2 1.2v6c0 .7-.5 1.2-1.2 1.2H3c-.7 0-1.2-.5-1.2-1.2V4.2Z" />
  ),
  inbox: (
    <>
      <path d="M2 9.5h3.4l1.2 1.8h2.8l1.2-1.8H14" />
      <path d="M3.4 3.4h9.2L14 9.5v3.1c0 .6-.5 1-1 1H3c-.5 0-1-.4-1-1V9.5l1.4-6.1Z" />
    </>
  ),
  "panel-right": (
    <>
      <rect x="1.8" y="2.2" width="12.4" height="11.6" rx="1.5" />
      <path d="M10.2 2.2v11.6" />
    </>
  ),
  reasoning: (
    <>
      <path d="M8 2.1a4.4 4.4 0 0 0-2.7 7.9c.5.4.8.9.8 1.5h3.8c0-.6.3-1.1.8-1.5A4.4 4.4 0 0 0 8 2.1Z" />
      <path d="M6.5 13.8h3M6.2 11.5h3.6" />
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
  stop: <rect x="3.2" y="3.2" width="9.6" height="9.6" rx="1.5" />,
  tree: (
    <>
      <path d="M2.5 3.5h11M5.5 8h8M5.5 12.5h8" />
      <circle cx="3" cy="8" r=".2" />
      <circle cx="3" cy="12.5" r=".2" />
    </>
  ),
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
