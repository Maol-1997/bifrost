import { cn } from '@app/lib/cn';
import { cva, type VariantProps } from 'class-variance-authority';

const skeletonVariants = cva('animate-design-pulse', {
  variants: {
    variant: {
      default: 'bg-white/7',
      subtle: 'bg-white/5',
      secondary: 'bg-white/6',
    },
    shape: {
      default: 'rounded-md',
      control: 'rounded-lg',
      checkbox: 'rounded-[4px]',
    },
  },
  defaultVariants: { variant: 'default', shape: 'default' },
});

function Skeleton({
  className,
  variant,
  shape,
  ...props
}: React.HTMLAttributes<HTMLDivElement> & VariantProps<typeof skeletonVariants>) {
  return <div className={cn(skeletonVariants({ variant, shape }), className)} {...props} />;
}

export { Skeleton };
