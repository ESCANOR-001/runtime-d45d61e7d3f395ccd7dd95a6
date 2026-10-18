import type { ModelInfo } from '@anthropic-ai/claude-agent-sdk';

/** Display the SDK's resolved default without pinning the user's selection to it. */
export function claudeModelLabels(model: ModelInfo, catalog: readonly ModelInfo[]): { name: string; shortName?: string } {
  if (model.value !== 'default') return { name: model.displayName };
  const resolved = model.resolvedModel?.trim();
  const match = resolved ? catalog.find(candidate => candidate.value !== 'default'
    && (candidate.value === resolved || candidate.resolvedModel === resolved)) : undefined;
  const name = match?.displayName || (resolved && resolved !== 'default' ? resolved : 'Default model');
  return { name: `${name} (default)`, shortName: name };
}
