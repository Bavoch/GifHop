import { DEFAULT_ANIMATION_INTENT } from '../animation-prompt.mjs';

export function restorePromptInput(value) {
  // Older checkpoints stored the internal fallback as though it were a user draft.
  return !value || value.trim() === DEFAULT_ANIMATION_INTENT ? '' : value;
}
