import { describe, expect, it } from 'vitest';
import { toggleHighlightMarkers } from './highlight';

describe('toggleHighlightMarkers', () => {
  it('wraps a selection with markers and selects the inner text', () => {
    expect(toggleHighlightMarkers('Hello world', 6, 11)).toEqual({
      text: 'Hello ****world****',
      caretStart: 10,
      caretEnd: 15,
    });
  });

  it('unwraps an already wrapped selection', () => {
    expect(
      toggleHighlightMarkers('Hello ****world****', 10, 15)
    ).toEqual({
      text: 'Hello world',
      caretStart: 6,
      caretEnd: 11,
    });
  });

  it('inserts an empty marker pair on a collapsed caret', () => {
    expect(toggleHighlightMarkers('Hello', 5, 5)).toEqual({
      text: 'Hello********',
      caretStart: 9,
      caretEnd: 9,
    });
  });

  it('tolerates reversed and out-of-range selections', () => {
    expect(toggleHighlightMarkers('Hi', 5, 0)).toEqual({
      text: '****Hi****',
      caretStart: 4,
      caretEnd: 6,
    });
  });

  it('round-trips wrap then unwrap', () => {
    const wrapped = toggleHighlightMarkers('a b c', 2, 3);
    expect(wrapped.text).toBe('a ****b**** c');
    const unwrapped = toggleHighlightMarkers(
      wrapped.text,
      wrapped.caretStart,
      wrapped.caretEnd
    );
    expect(unwrapped.text).toBe('a b c');
  });
});
