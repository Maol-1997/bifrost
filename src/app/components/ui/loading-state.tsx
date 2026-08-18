import { Skeleton } from './skeleton';

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
