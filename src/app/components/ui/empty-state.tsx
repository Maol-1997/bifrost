export function EmptyState({
  title,
  body,
  action,
  tone = 'neutral',
}: {
  title: string;
  body: string;
  action?: React.ReactNode;
  tone?: 'neutral' | 'accent' | 'result';
}): React.JSX.Element {
  return (
    <div
      className={
        tone === 'accent'
          ? 'mt-6 rounded-[11px] border border-brand/35 bg-brand/8 px-5 py-5 text-left'
          : tone === 'result'
            ? 'mt-[18px] text-center'
            : 'mt-6 rounded-[10px] border-[0.5px] border-dashed border-app-border-pane px-8 py-9 text-center'
      }
    >
      <div className={tone === 'result' ? 'text-lg font-semibold tracking-[-0.01em]' : 'text-sm font-semibold'}>
        {title}
      </div>
      <div
        className={
          tone === 'result'
            ? 'mx-auto mt-2 max-w-xl text-[13px] leading-[1.6] text-app-text-tertiary text-pretty'
            : 'mx-auto mt-1.5 max-w-xl text-[12.5px] leading-5 text-app-text-tertiary'
        }
      >
        {body}
      </div>
      {action ? <div className="mt-4">{action}</div> : null}
    </div>
  );
}
