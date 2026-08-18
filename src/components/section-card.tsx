import { Card } from '@/components/ui/card';
import { cn } from '@/lib/utils';

export function SectionCard({ children, className }: { children: React.ReactNode; className?: string }): React.JSX.Element {
  return <Card className={cn('gap-0 rounded-[10px] border-[0.5px] border-app-border-pane bg-app-bg-secondary py-0 shadow-none', className)}>{children}</Card>;
}
