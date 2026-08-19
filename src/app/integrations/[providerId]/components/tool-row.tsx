import { Switch } from '@app/components/ui/switch';
import { cn } from '@app/lib/cn';
import type { ProviderTool } from '@app/api/bifrost';

export function ToolRow({ tool, isAvailable, onToggle }: { tool: ProviderTool; isAvailable: boolean; onToggle: (isEnabled: boolean) => void }): React.JSX.Element {
  return (
    <div className={cn('flex min-h-11 items-center gap-3 border-t-[0.5px] border-app-border-pane px-3.5 py-2.5', !isAvailable && 'opacity-50')}>
      <div className="min-w-0 flex-1">
        <div><span className="text-[13px] font-medium">{tool.title}</span><span className="ml-2 text-xs text-app-text-tertiary">{tool.description}</span></div>
        {/* The name the agent calls. Worth showing: it is what you grep for in a log. */}
        <code className="mt-0.5 block truncate font-mono text-[11px] text-app-text-quaternary">{tool.name}</code>
      </div>
      <Switch
        aria-label={`${tool.isEnabled ? 'Disable' : 'Enable'} ${tool.title}`}
        checked={tool.isEnabled}
        disabled={!isAvailable}
        onCheckedChange={onToggle}
      />
    </div>
  );
}
