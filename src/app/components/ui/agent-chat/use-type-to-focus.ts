import * as React from 'react';

const EDITABLE_SELECTOR = "input, textarea, select, [contenteditable]:not([contenteditable='false'])";
// Radix unmounts closed overlays, so any of these in the document means one is open.
const OPEN_OVERLAY_SELECTOR = "[role='dialog'], [role='alertdialog'], [role='menu'], [role='listbox']";

/**
 * Sends typing that starts anywhere on the page into `ref`, the way chat apps
 * do. It has to happen on keydown: focusing there makes the browser insert the
 * character into the newly focused field itself, while by keypress/input the
 * character has already gone to the old target.
 *
 * Only printable keys qualify, plus dead keys so an accented first letter
 * ("á") composes in the field. Shortcuts, navigation keys, other editable
 * fields and open overlays are left alone.
 */
function useTypeToFocus(ref: React.RefObject<HTMLTextAreaElement | null>, enabled: boolean) {
  React.useEffect(() => {
    if (!enabled) return;

    function handleKeyDown(event: KeyboardEvent) {
      const field = ref.current;
      if (!field || field.disabled || document.activeElement === field) return;
      if (event.defaultPrevented || event.isComposing || event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.key.length !== 1 && event.key !== 'Dead') return;
      if (event.target instanceof Element && event.target.closest(EDITABLE_SELECTOR)) return;
      if (document.querySelector(OPEN_OVERLAY_SELECTOR)) return;

      field.focus();
      // Typing continues after whatever is already there, not wherever the caret was left.
      field.setSelectionRange(field.value.length, field.value.length);
    }

    document.addEventListener('keydown', handleKeyDown);
    return () => {
      document.removeEventListener('keydown', handleKeyDown);
    };
  }, [enabled, ref]);
}

export { useTypeToFocus };
