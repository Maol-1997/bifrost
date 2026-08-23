import { Switch } from '@app/components/ui/switch';
import { ExpandableText } from '@app/components/ui/expandable-text';
import { SettingsRow } from '@app/components/ui/settings-group';
import { cn } from '@app/lib/cn';
import type { ProviderTool } from '@app/api/bifrost';

export function ToolRow({ disabled, tool, isAvailable, onToggle }: { disabled: boolean; tool: ProviderTool; isAvailable: boolean; onToggle: (isEnabled: boolean) => void }): React.JSX.Element {
  return (
    <SettingsRow className={cn('h-auto min-h-[65px] items-start', !isAvailable && 'opacity-50')}>
      <div className="min-w-0 flex-1">
        <div className="text-[13px] font-medium">{tool.title}</div>
        <ExpandableText label={tool.title} text={tool.description} />
        {/* The name the agent calls. Worth showing: it is what you grep for in a log. */}
        <code className="mt-0.5 block truncate font-mono text-[11px] text-app-text-quaternary">{tool.name}</code>
      </div>
      <Switch
        aria-label={`${tool.isEnabled ? 'Disable' : 'Enable'} ${tool.title}`}
        checked={tool.isEnabled}
        className="mt-0.5"
        disabled={disabled || !isAvailable}
        onCheckedChange={onToggle}
      />
    </SettingsRow>
  );
}
