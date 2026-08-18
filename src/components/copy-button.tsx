import { useEffect, useRef, useState } from 'react';
import { Button } from '@/components/ui/button';
import { cn } from '@/lib/utils';

export function CopyButton({ value, className }: { value: string; className?: string }): React.JSX.Element {
  const [isCopied, setIsCopied] = useState(false);
  const timeoutRef = useRef<number | undefined>(undefined);

  useEffect(() => () => window.clearTimeout(timeoutRef.current), []);

  async function copy(): Promise<void> {
    await navigator.clipboard.writeText(value);
    setIsCopied(true);
    window.clearTimeout(timeoutRef.current);
    timeoutRef.current = window.setTimeout(() => setIsCopied(false), 1600);
  }

  return <Button type="button" variant="outline" onClick={() => void copy()} className={cn('min-w-[72px]', isCopied && 'border-success/30 bg-success/15 text-success', className)}>{isCopied ? 'Copied ✓' : 'Copy'}</Button>;
}
