import { cn } from '@app/lib/cn';
import { SettingsGroup } from './settings-group';

export function SectionCard({
  children,
  className,
}: {
  children: React.ReactNode;
  className?: string;
}): React.JSX.Element {
  return <SettingsGroup className={cn('py-0', className)}>{children}</SettingsGroup>;
}
