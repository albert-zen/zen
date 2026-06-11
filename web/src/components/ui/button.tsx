import * as React from "react";
import { cva, type VariantProps } from "class-variance-authority";

import { cn } from "../../lib/utils";

const buttonVariants = cva(
  "inline-flex h-9 shrink-0 items-center justify-center gap-2 rounded-md border px-3 text-sm font-medium transition-colors disabled:pointer-events-none disabled:opacity-45",
  {
    variants: {
      variant: {
        default: "border-zinc-700 bg-zinc-800 text-zinc-100 hover:bg-zinc-700",
        ghost: "border-transparent bg-transparent text-zinc-100 hover:bg-zinc-800",
        primary: "border-teal-500 bg-teal-500 text-zinc-950 hover:bg-teal-400",
        subtle: "border-zinc-800 bg-zinc-900 text-zinc-300 hover:bg-zinc-800"
      },
      size: {
        default: "h-9 px-3",
        icon: "h-9 w-9 px-0"
      }
    },
    defaultVariants: {
      variant: "default",
      size: "default"
    }
  }
);

export type ButtonProps = React.ButtonHTMLAttributes<HTMLButtonElement> &
  VariantProps<typeof buttonVariants>;

export const Button = React.forwardRef<HTMLButtonElement, ButtonProps>(
  ({ className, variant, size, ...props }, ref) => (
    <button
      ref={ref}
      className={cn(buttonVariants({ variant, size }), className)}
      {...props}
    />
  )
);
Button.displayName = "Button";
