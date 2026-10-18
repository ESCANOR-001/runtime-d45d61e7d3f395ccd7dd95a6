import { expect, test } from 'bun:test';
import { claudeModelLabels } from '../src/claude-code/model-presentation';

test('unlisted resolved defaults retain their exact model ID instead of guessing a model family', () => {
  const model = { value: 'default', resolvedModel: 'claude-new-model', displayName: 'Default (recommended)', description: '' };
  expect(claudeModelLabels(model, [model])).toEqual({ name: 'claude-new-model (default)', shortName: 'claude-new-model' });
});
test('older SDKs without a resolved default never falsely claim a particular model', () => {
  const model = { value: 'default', displayName: 'Default (recommended)', description: '' };
  expect(claudeModelLabels(model, [model])).toEqual({ name: 'Default model (default)', shortName: 'Default model' });
  expect(claudeModelLabels({ ...model, value: 'sonnet', displayName: 'Sonnet' }, [])).toEqual({ name: 'Sonnet' });
});
