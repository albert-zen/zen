import * as React from 'react';

import { cn } from '../../lib/utils';

export type TextareaProps = React.TextareaHTMLAttributes<HTMLTextAreaElement>;

export const Textarea = React.forwardRef<HTMLTextAreaElement, TextareaProps>(
  ({ className, ...props }, ref) => (
    <textarea
      ref={ref}
      className={cn(
        'min-h-11 max-h-44 w-full resize-none border-0 bg-transparent px-1 py-2.5 text-base leading-relaxed text-zinc-100 outline-none placeholder:text-zinc-500',
        className
      )}
      {...props}
    />
  )
);
Textarea.displayName = 'Textarea';
