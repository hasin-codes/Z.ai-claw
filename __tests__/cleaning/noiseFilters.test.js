const {
  isEmpty,
  isEmojiOnly,
  isShortAcknowledgement,
  isTooShort,
  isDuplicate,
  isNoise,
} = require('../../lib/cleaning/noiseFilters');

describe('noiseFilters', () => {
  describe('isEmpty', () => {
    test('returns true for null', () => expect(isEmpty(null)).toBe(true));
    test('returns true for undefined', () => expect(isEmpty(undefined)).toBe(true));
    test('returns true for empty string', () => expect(isEmpty('')).toBe(true));
    test('returns true for whitespace only', () => expect(isEmpty('   ')).toBe(true));
    test('returns false for text', () => expect(isEmpty('hello')).toBe(false));
  });

  describe('isTooShort', () => {
    test('returns true for single char', () => expect(isTooShort('a')).toBe(true));
    test('returns true for empty', () => expect(isTooShort('')).toBe(true));
    test('returns false for 2 chars', () => expect(isTooShort('ab')).toBe(false));
    test('returns false for longer text', () => expect(isTooShort('hello')).toBe(false));
    test('ignores whitespace trimming', () => expect(isTooShort(' a ')).toBe(true));
  });

  describe('isEmojiOnly', () => {
    test('returns true for single emoji', () => expect(isEmojiOnly('😂')).toBe(true));
    test('returns true for multiple emojis', () => expect(isEmojiOnly('😂🔥💯')).toBe(true));
    test('returns false for text with emoji', () => expect(isEmojiOnly('hello 😂')).toBe(false));
    test('returns false for plain text', () => expect(isEmojiOnly('hello')).toBe(false));
    test('returns true for emoji with whitespace', () => expect(isEmojiOnly('   😂   ')).toBe(true));
  });

  describe('isShortAcknowledgement', () => {
    test('removes "ok"', () => expect(isShortAcknowledgement('ok')).toBe(true));
    test('removes "k"', () => expect(isShortAcknowledgement('k')).toBe(true));
    test('removes "yes"', () => expect(isShortAcknowledgement('yes')).toBe(true));
    test('removes "no"', () => expect(isShortAcknowledgement('no')).toBe(true));
    test('removes "thanks"', () => expect(isShortAcknowledgement('thanks')).toBe(true));
    test('removes "ty"', () => expect(isShortAcknowledgement('ty')).toBe(true));
    test('removes "ok!"', () => expect(isShortAcknowledgement('ok!')).toBe(true));
    test('removes "ok."', () => expect(isShortAcknowledgement('ok.')).toBe(true));
    test('removes "yep"', () => expect(isShortAcknowledgement('yep')).toBe(true));
    test('removes "nah"', () => expect(isShortAcknowledgement('nah')).toBe(true));

    // IMPORTANT: must preserve short technical messages
    test('preserves "403 error?"', () => expect(isShortAcknowledgement('403 error?')).toBe(false));
    test('preserves "endpoint broken?"', () => expect(isShortAcknowledgement('endpoint broken?')).toBe(false));
    test('preserves "try the coding api"', () => expect(isShortAcknowledgement('try the coding api')).toBe(false));
    test('preserves "ok then try this"', () => expect(isShortAcknowledgement('ok then try this')).toBe(false));
    test('preserves "no it doesnt work"', () => expect(isShortAcknowledgement('no it doesnt work')).toBe(false));
  });

  describe('isDuplicate', () => {
    const base = { user_id: 'u1', content: 'hello world', timestamp: '2026-01-01T00:00:00Z' };

    test('detects same user, same content, within window', () => {
      const prev = [{ user_id: 'u1', content: 'hello world', timestamp: '2026-01-01T00:00:30Z' }];
      expect(isDuplicate(base, prev, 60)).toBe(true);
    });

    test('ignores different user', () => {
      const prev = [{ user_id: 'u2', content: 'hello world', timestamp: '2026-01-01T00:00:30Z' }];
      expect(isDuplicate(base, prev, 60)).toBe(false);
    });

    test('ignores different content', () => {
      const prev = [{ user_id: 'u1', content: 'different', timestamp: '2026-01-01T00:00:30Z' }];
      expect(isDuplicate(base, prev, 60)).toBe(false);
    });

    test('ignores messages outside time window', () => {
      const prev = [{ user_id: 'u1', content: 'hello world', timestamp: '2026-01-01T00:00:00Z' }];
      // base is at 00:00:00, prev at 00:00:00 — same time, within window
      // But let's test outside: prev 2 minutes before
      const prev2 = [{ user_id: 'u1', content: 'hello world', timestamp: '2025-12-31T23:58:00Z' }];
      expect(isDuplicate(base, prev2, 60)).toBe(false);
    });

    test('returns false for empty recent list', () => {
      expect(isDuplicate(base, [], 60)).toBe(false);
    });
  });

  describe('isNoise (combined)', () => {
    test('removes empty message', () => {
      expect(isNoise({ content: null })).toEqual({ isNoise: true, reason: 'empty' });
    });

    test('removes too short message', () => {
      expect(isNoise({ content: 'x' })).toEqual({ isNoise: true, reason: 'too_short' });
    });

    test('removes emoji-only message', () => {
      expect(isNoise({ content: '😂🔥' })).toEqual({ isNoise: true, reason: 'emoji_only' });
    });

    test('removes acknowledgement', () => {
      expect(isNoise({ content: 'ok' })).toEqual({ isNoise: true, reason: 'acknowledgement' });
    });

    test('removes duplicate', () => {
      const recent = [{ user_id: 'u1', content: 'hello', timestamp: '2026-01-01T00:00:30Z' }];
      expect(isNoise({ user_id: 'u1', content: 'hello', timestamp: '2026-01-01T00:00:45Z' }, recent))
        .toEqual({ isNoise: true, reason: 'duplicate' });
    });

    test('keeps normal message', () => {
      expect(isNoise({ content: 'hey can someone help me with this error?' }))
        .toEqual({ isNoise: false, reason: null });
    });

    test('keeps short technical message', () => {
      expect(isNoise({ content: '403 error?' }))
        .toEqual({ isNoise: false, reason: null });
    });

    test('filter order: emoji_only catches single emoji (multi-byte)', () => {
      // "🔥" is 2 UTF-16 code units in JS, so isTooShort passes (>= 2)
      // It gets caught by isEmojiOnly instead
      expect(isNoise({ content: '🔥' })).toEqual({ isNoise: true, reason: 'emoji_only' });
    });
  });
});
