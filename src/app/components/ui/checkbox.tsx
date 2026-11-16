import * as React from 'react';
import { Check, Minus } from 'lucide-react';
import { cn } from '@app/lib/cn';

export type CheckboxState = boolean | 'indeterminate';

export type CheckboxProps = Omit<React.InputHTMLAttributes<HTMLInputElement>, 'checked' | 'onChange'> & {
  checked: CheckboxState;
  onCheckedChange: (checked: boolean) => void;
};

export const Checkbox = React.forwardRef<HTMLInputElement, CheckboxProps>(
  ({ checked, className, onCheckedChange, ...props }, forwardedRef) => {
    const localRef = React.useRef<HTMLInputElement | null>(null);
    const setRef = React.useCallback(
      (element: HTMLInputElement | null) => {
        localRef.current = element;
        if (typeof forwardedRef === 'function') forwardedRef(element);
        else if (forwardedRef) forwardedRef.current = element;
      },
      [forwardedRef],
    );

    React.useEffect(() => {
      if (localRef.current) localRef.current.indeterminate = checked === 'indeterminate';
    }, [checked]);

    return (
      <span className="relative flex size-4 shrink-0 items-center justify-center">
        <input
          {...props}
          ref={setRef}
          type="checkbox"
          checked={checked === true}
          className={cn(
            'peer size-4 appearance-none rounded-[4px] border border-control-border bg-app-bg-secondary outline-none transition-[border-color,background-color] checked:border-brand checked:bg-brand indeterminate:border-brand indeterminate:bg-brand focus-visible:ring-2 focus-visible:ring-brand/60 disabled:opacity-50',
            className,
          )}
          onChange={(event) => {
            onCheckedChange(event.currentTarget.checked);
          }}
        />
        {checked === true ? (
          <Check aria-hidden="true" className="pointer-events-none absolute size-3 text-white" strokeWidth={2.5} />
        ) : null}
        {checked === 'indeterminate' ? (
          <Minus aria-hidden="true" className="pointer-events-none absolute size-3 text-white" strokeWidth={2.5} />
        ) : null}
      </span>
    );
  },
);
Checkbox.displayName = 'Checkbox';
