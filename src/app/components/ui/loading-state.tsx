import { Skeleton } from './skeleton';

const DEFAULT_ROW_COUNT = 4;

export function LoadingState({
  label = 'Loading…',
  rowCount = DEFAULT_ROW_COUNT,
}: {
  label?: string;
  rowCount?: number;
}): React.JSX.Element {
  return (
    <div aria-live="polite" aria-busy="true">
      <div className="mt-6 overflow-hidden rounded-[10px] border-[0.5px] border-app-border-pane bg-app-bg-secondary">
        {Array.from({ length: rowCount }, (_, index) => (
          <div
            className="flex items-center gap-3 border-t-[0.5px] border-app-border-pane p-3.5 first:border-t-0"
            key={index}
          >
            <Skeleton shape="control" className="size-8" />
            <div className="flex flex-1 flex-col gap-2">
              <Skeleton className="h-2.5 w-30" />
              <Skeleton variant="subtle" className="h-2 w-65" />
            </div>
            <Skeleton variant="secondary" className="h-2.5 w-20" />
          </div>
        ))}
      </div>
      <div className="mt-3 text-center text-xs text-app-text-quaternary">{label}</div>
    </div>
  );
}
