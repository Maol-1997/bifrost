import { Button } from '@/components/ui/button';
import { Skeleton } from '@/components/ui/skeleton';

export function EmptyState({ title, body, action, tone = 'neutral' }: { title: string; body: string; action?: React.ReactNode; tone?: 'neutral' | 'accent' | 'result' }): React.JSX.Element {
  return (
    <div className={tone === 'accent' ? 'mt-6 rounded-[11px] border border-brand/35 bg-brand/8 px-5 py-5 text-left' : tone === 'result' ? 'mt-[18px] text-center' : 'mt-6 rounded-[10px] border-[0.5px] border-dashed border-app-border-pane px-8 py-9 text-center'}>
      <div className={tone === 'result' ? 'text-lg font-semibold tracking-[-0.01em]' : 'text-sm font-semibold'}>{title}</div>
      <div className={tone === 'result' ? 'mx-auto mt-2 max-w-xl text-[13px] leading-[1.6] text-app-text-tertiary text-pretty' : 'mx-auto mt-1.5 max-w-xl text-[12.5px] leading-5 text-app-text-tertiary'}>{body}</div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}

export function LoadingState({ label = 'Loading…' }: { label?: string }): React.JSX.Element {
  return (
    <div aria-live="polite" aria-busy="true">
      <div className="mt-6 overflow-hidden rounded-[10px] border-[0.5px] border-app-border-pane bg-app-bg-secondary">
        {Array.from({ length: 4 }, (_, index) => (
          <div className="flex items-center gap-3 border-t-[0.5px] border-app-border-pane p-3.5 first:border-t-0" key={index}>
            <Skeleton className="animate-design-pulse size-8 rounded-lg bg-white/7" />
            <div className="flex flex-1 flex-col gap-2"><Skeleton className="animate-design-pulse h-2.5 w-30 bg-white/7" /><Skeleton className="animate-design-pulse h-2 w-65 bg-white/5" /></div>
            <Skeleton className="animate-design-pulse h-2.5 w-20 bg-white/6" />
          </div>
        ))}
      </div>
      <div className="mt-3 text-center text-xs text-app-text-quaternary">{label}</div>
    </div>
  );
}

export function ErrorState({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="mt-6 rounded-[10px] border border-danger/25 bg-danger/5 p-6 text-center" role="alert">
      <div className="text-sm font-semibold text-danger">{title}</div>
      <div className="mt-1.5 text-[12.5px] leading-5 text-app-text-tertiary">{body}</div>
      <Button variant="outline" size="sm" onClick={onRetry} className="mt-3.5">Retry</Button>
    </div>
  );
}
