export function PageHead({ title, subtitle }: { title: string; subtitle?: React.ReactNode }): React.JSX.Element {
  return (
    <header>
      <h1 className="text-lg font-semibold tracking-[-0.01em]">{title}</h1>
      {subtitle ? <div className="mt-1 max-w-[720px] text-[13px] leading-5 text-app-text-tertiary text-pretty">{subtitle}</div> : null}
    </header>
  );
}
