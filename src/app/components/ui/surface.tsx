import * as React from 'react';
import { Slot } from '@radix-ui/react-slot';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@app/lib/cn';

const surfaceVariants = cva('relative', {
  variants: {
    variant: {
      settings: 'rounded-[10px] bg-linear-input shadow-linear-settings',
      inset: 'rounded-md border border-linear-inset-border bg-linear-inset px-3 py-1.5',
    },
  },
  defaultVariants: {
    variant: 'settings',
  },
});

type SurfaceProps = React.ComponentPropsWithoutRef<'div'> &
  VariantProps<typeof surfaceVariants> & {
    asChild?: boolean;
  };

const Surface = React.forwardRef<HTMLDivElement, SurfaceProps>(
  ({ asChild = false, className, variant, ...props }, ref) => {
    const Component = asChild ? Slot : 'div';

    return <Component ref={ref} className={cn(surfaceVariants({ variant }), className)} {...props} />;
  },
);
Surface.displayName = 'Surface';

export { Surface, type SurfaceProps };
