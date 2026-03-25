/**
 * Noise detection filters for community messages.
 *
 * These return true if the message is noise and should be REMOVED.
 * They are pure functions — no DB or external calls.
 */

/** Short acknowledgements that add no technical value */
const ACKNOWLEDGEMENTS = new Set([
  'ok', 'k', 'yes', 'no', 'thanks', 'ty', 'yep', 'nope', 'ya', 'yea',
  'yup', 'nah', 'thx', 'okk', 'oky', 'ok!', 'k.', 'kk', 'okk',
]);

/**
 * Check if message is empty/null.
 * @param {string|null|undefined} content
 * @returns {boolean}
 */
function isEmpty(content) {
  return !content || content.trim().length === 0;
}

/**
 * Check if message is emoji-only (no alphanumeric or meaningful characters).
 * @param {string} content
 * @returns {boolean}
 */
function isEmojiOnly(content) {
  // Strip all emojis, then check if anything meaningful remains
  const stripped = content.replace(
    /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu,
    ''
  );
  // Also strip common joiner chars
  const cleaned = stripped.replace(/[\s\u200b\u200c\u200d]/g, '');
  return cleaned.length === 0;
}

/**
 * Check if message is a very short acknowledgement with no technical context.
 * Preserves short technical messages like "403 error?" or "try the coding api".
 * @param {string} content
 * @returns {boolean}
 */
function isShortAcknowledgement(content) {
  const trimmed = content.trim().toLowerCase();
  // Only apply to very short messages (<= 6 chars to be safe)
  if (trimmed.length > 6) return false;

  // Check if it's a pure acknowledgement (possibly with punctuation)
  const base = trimmed.replace(/[!?.]+$/, '');
  return ACKNOWLEDGEMENTS.has(base);
}

/**
 * Check if message is shorter than 2 characters.
 * @param {string} content
 * @returns {boolean}
 */
function isTooShort(content) {
  return content.trim().length < 2;
}

/**
 * Check for duplicate messages from the same user within a time window.
 * @param {object} message - { user_id, content, timestamp }
 * @param {Array<object>} recentMessages - previously seen messages in this batch
 * @param {number} [windowSeconds=60] - time window for duplicate detection
 * @returns {boolean}
 */
function isDuplicate(message, recentMessages, windowSeconds = 60) {
  const msgTime = new Date(message.timestamp).getTime();

  return recentMessages.some(prev => {
    if (prev.user_id !== message.user_id) return false;
    if (prev.content !== message.content) return false;

    const prevTime = new Date(prev.timestamp).getTime();
    return Math.abs(msgTime - prevTime) <= windowSeconds * 1000;
  });
}

/**
 * Run all noise filters on a message. Returns true if message is noise.
 * @param {object} message - { content, user_id, timestamp, message_id }
 * @param {Array<object>} [recentMessages=[]] - for duplicate detection
 * @returns {{ isNoise: boolean, reason: string|null }}
 */
function isNoise(message, recentMessages = []) {
  if (isEmpty(message.content)) {
    return { isNoise: true, reason: 'empty' };
  }

  if (isTooShort(message.content)) {
    return { isNoise: true, reason: 'too_short' };
  }

  if (isEmojiOnly(message.content)) {
    return { isNoise: true, reason: 'emoji_only' };
  }

  if (isShortAcknowledgement(message.content)) {
    return { isNoise: true, reason: 'acknowledgement' };
  }

  if (isDuplicate(message, recentMessages)) {
    return { isNoise: true, reason: 'duplicate' };
  }

  return { isNoise: false, reason: null };
}

module.exports = {
  isEmpty,
  isEmojiOnly,
  isShortAcknowledgement,
  isTooShort,
  isDuplicate,
  isNoise,
};
