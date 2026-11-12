import { DEFAULT_MCP_SERVERS, DEFAULT_SKILL_PLUGINS } from '@emberline/protocol';
import { McpPluginsSection, type McpPluginsSectionProps } from './settings/McpPluginsSection';

export function McpPluginsPanel(props: McpPluginsSectionProps) {
  return (
    <McpPluginsSection
      {...props}
      mcpServers={props.mcpServers.length > 0 ? props.mcpServers : DEFAULT_MCP_SERVERS}
      skillPlugins={props.skillPlugins.length > 0 ? props.skillPlugins : DEFAULT_SKILL_PLUGINS}
    />
  );
}
