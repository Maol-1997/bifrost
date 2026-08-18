import { Badge } from '@/components/ui/badge';
import { cn } from '@/lib/utils';
import type { ClientHealth, ConnectionStatus, SystemHealth } from '@/api/bifrost';

type StatusValue = ConnectionStatus | ClientHealth | SystemHealth;

const statusLabels: Record<StatusValue, string> = {
  connected: 'Connected',
  'needs-reconnect': 'Reconnect needed',
  'not-connected': 'Not connected',
  unavailable: 'Unavailable',
  healthy: 'Healthy',
  'needs-renewal': 'Needs renewal',
  operational: 'Operational',
  degraded: 'Degraded',
  down: 'Down',
  unknown: 'Unknown',
};

function statusColor(status: StatusValue): string {
  if (status === 'connected' || status === 'healthy' || status === 'operational') return 'text-success';
  if (status === 'needs-reconnect' || status === 'needs-renewal' || status === 'degraded') return 'text-warning';
  if (status === 'down') return 'text-danger';
  return 'text-app-text-quaternary';
}

function StatusDot({ status, className }: { status: StatusValue; className?: string }): React.JSX.Element {
  const isHollow = status === 'not-connected';
  return <span aria-hidden className={cn('size-1.5 shrink-0 rounded-full', statusColor(status), isHollow ? 'border-[1.5px] border-current bg-transparent' : 'bg-current', className)} />;
}

export function StatusBadge({ status, label, className }: { status: StatusValue; label?: string; className?: string }): React.JSX.Element {
  return (
    <Badge variant="outline" className={cn('h-auto gap-1.5 border-0 bg-transparent p-0 text-xs font-normal', statusColor(status), className)}>
      <StatusDot status={status} />
      {label ?? statusLabels[status]}
    </Badge>
  );
}
