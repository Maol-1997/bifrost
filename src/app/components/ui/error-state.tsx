import { Button } from './button';

export function ErrorState({ title, body, onRetry }: { title: string; body: string; onRetry: () => void }): React.JSX.Element {
  return (
    <div className="mt-6 rounded-[10px] border border-danger/25 bg-danger/5 p-6 text-center" role="alert">
      <div className="text-sm font-semibold text-danger">{title}</div>
      <div className="mt-1.5 text-[12.5px] leading-5 text-app-text-tertiary">{body}</div>
      <Button variant="outline" size="sm" onClick={onRetry} className="mt-3.5">Retry</Button>
    </div>
  );
}
