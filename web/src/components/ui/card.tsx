import * as React from "react";

import { cn } from "../../lib/utils";

export function Card({
  className,
  ...props
}: React.HTMLAttributes<HTMLDivElement>): React.ReactElement {
  return (
    <div
      className={cn("rounded-lg border border-zinc-800 bg-zinc-950", className)}
      {...props}
    />
  );
}
