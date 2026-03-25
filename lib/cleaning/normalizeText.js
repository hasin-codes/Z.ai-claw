/**
 * Text normalization for community messages.
 *
 * Rules (from user requirements):
 * - Remove markdown formatting (bold, italic, code, links, etc.)
 * - Preserve Discord user mentions (<@123...>)
 * - Remove emojis
 * - Lowercase all text
 * - Trim and collapse whitespace
 */

/**
 * Normalize a message's text content for the clean dataset.
 * @param {string|null|undefined} content
 * @returns {string|null} normalized content, or null if empty after cleaning
 */
function normalize(content) {
  if (!content) return null;

  let text = content;

  // 1. Preserve Discord mentions by replacing them with a placeholder
  //    Matches <@123456789>, <@&123456789> (role), <#123456789> (channel)
  //    Pure ASCII placeholder — no special chars so no markdown regex can touch it
  const mentions = [];
  text = text.replace(/<(?:@|@&|#)\d+>/g, (match) => {
    mentions.push(match);
    return `DSCMENTION${mentions.length - 1}DSCMENTION`;
  });

  // 2. Remove markdown code blocks (``` ... ``` and inline ` ... `)
  text = text.replace(/```[\s\S]*?```/g, ' ');
  text = text.replace(/`([^`]+)`/g, '$1');

  // 3. Remove markdown links but keep the text: [text](url) → text
  text = text.replace(/\[([^\]]*)\]\([^)]*\)/g, '$1');

  // 4. Remove markdown formatting: bold, italic, strikethrough, underline
  text = text.replace(/\*\*\*([^*]+)\*\*\*/g, '$1'); // bold+italic
  text = text.replace(/\*\*([^*]+)\*\*/g, '$1');     // bold
  text = text.replace(/\*([^*]+)\*/g, '$1');         // italic
  text = text.replace(/~~([^~]+)~~/g, '$1');         // strikethrough
  text = text.replace(/__([^_]+)__/g, '$1');         // underline

  // 5. Remove markdown headings (# ## ### etc.)
  text = text.replace(/^#{1,6}\s+/gm, '');

  // 6. Remove blockquotes (> at start of line)
  text = text.replace(/^>\s?/gm, '');

  // 7. Remove horizontal rules (---, ***, ___)
  text = text.replace(/^[-*_]{3,}\s*$/gm, '');

  // 8. Remove remaining markdown syntax characters that are purely formatting
  //    but preserve common punctuation like . , ! ? : ;
  text = text.replace(/[*_~`#|]/g, '');

  // 9. Remove emojis (Unicode emoji ranges)
  text = text.replace(
    /[\p{Emoji_Presentation}\p{Extended_Pictographic}\u{FE0F}\u{200D}\u{20E3}]/gu,
    ''
  );

  // 10. Remove leftover URL text that's just "http..." or "www..."
  text = text.replace(/https?:\/\/\S+/g, ' ');
  text = text.replace(/www\.\S+/g, ' ');

  // 11. Restore Discord mentions
  for (let i = 0; i < mentions.length; i++) {
    text = text.replace(`DSCMENTION${i}DSCMENTION`, mentions[i].toLowerCase());
  }

  // 12. Lowercase
  text = text.toLowerCase();

  // 13. Trim and collapse whitespace
  text = text.trim().replace(/\s+/g, ' ');

  // Return null if nothing left after cleaning
  return text.length > 0 ? text : null;
}

module.exports = { normalize };
