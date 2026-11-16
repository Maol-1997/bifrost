import * as React from 'react';
import { animated, useTransition } from '@react-spring/web';
import * as TooltipPrimitive from '@radix-ui/react-tooltip';
import { cva, type VariantProps } from 'class-variance-authority';

import { cn } from '@app/lib/cn';
import { useMediaQuery } from './use-media-query';

function TooltipProvider({
  delayDuration = 450,
  skipDelayDuration = 400,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Provider>) {
  return <TooltipPrimitive.Provider delayDuration={delayDuration} skipDelayDuration={skipDelayDuration} {...props} />;
}

const TooltipOpenContext = React.createContext(false);

const tooltipContentVariants = cva(
  'pointer-events-none z-[1100] max-w-[calc(100vw-24px)] select-none rounded-lg border-[0.5px] border-linear-tooltip-border bg-linear-tooltip px-2 py-[5px] font-[450] shadow-linear-tooltip outline-none',
  {
    variants: {
      variant: {
        compact: 'w-max text-[11px] leading-[16.5px] text-linear-tooltip-foreground',
        rich: 'flex w-[521px] flex-col gap-2 text-[13px] [line-height:normal] text-linear-tooltip-muted [&_svg]:inline [&_svg]:size-4 [&_svg]:align-middle [&_svg]:text-inherit',
      },
    },
    defaultVariants: {
      variant: 'compact',
    },
  },
);

type TooltipContentProps = React.ComponentPropsWithoutRef<typeof TooltipPrimitive.Content> &
  VariantProps<typeof tooltipContentVariants>;

const TooltipContent = React.forwardRef<React.ComponentRef<typeof TooltipPrimitive.Content>, TooltipContentProps>(
  ({ children, className, variant, sideOffset = 8, collisionPadding = 12, style, ...props }, ref) => {
    const open = React.useContext(TooltipOpenContext);
    const prefersReducedMotion = useMediaQuery('(prefers-reduced-motion: reduce)');
    const transitions = useTransition(open, {
      from: { opacity: 0, scale: 0.98 },
      enter: { opacity: 2, scale: 1 },
      leave: { opacity: 0, scale: 0.98 },
      config: (_open, _index, phase) => ({
        tension: phase.toLowerCase() === 'leave' ? 2000 : 1500,
        friction: 100,
        precision: 0.01,
      }),
      immediate: prefersReducedMotion,
    });

    return transitions((springStyle, visible) =>
      visible ? (
        <TooltipPrimitive.Portal forceMount>
          <TooltipPrimitive.Content
            forceMount
            asChild
            sideOffset={sideOffset}
            collisionPadding={collisionPadding}
            {...props}
          >
            <animated.div
              ref={ref}
              data-linear-tooltip-content=""
              data-variant={variant ?? 'compact'}
              className={cn(tooltipContentVariants({ variant }), className)}
              style={{
                ...style,
                opacity: springStyle.opacity,
                transform: springStyle.scale.to((scale) => `scale(${scale})`),
                transformOrigin: 'var(--radix-tooltip-content-transform-origin)',
              }}
            >
              {children}
            </animated.div>
          </TooltipPrimitive.Content>
        </TooltipPrimitive.Portal>
      ) : null,
    );
  },
);
TooltipContent.displayName = TooltipPrimitive.Content.displayName;

function Tooltip({
  defaultOpen = false,
  onOpenChange,
  open: controlledOpen,
  ...props
}: React.ComponentProps<typeof TooltipPrimitive.Root>) {
  const [uncontrolledOpen, setUncontrolledOpen] = React.useState(defaultOpen);
  const open = controlledOpen ?? uncontrolledOpen;

  function handleOpenChange(nextOpen: boolean) {
    if (controlledOpen === undefined) {
      setUncontrolledOpen(nextOpen);
    }

    onOpenChange?.(nextOpen);
  }

  return (
    <TooltipOpenContext.Provider value={open}>
      <TooltipPrimitive.Root open={open} onOpenChange={handleOpenChange} {...props} />
    </TooltipOpenContext.Provider>
  );
}

const TooltipTrigger = TooltipPrimitive.Trigger;

export { Tooltip, TooltipContent, TooltipProvider, TooltipTrigger };
