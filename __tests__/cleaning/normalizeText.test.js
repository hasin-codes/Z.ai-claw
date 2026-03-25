const { normalize } = require('../../lib/cleaning/normalizeText');

describe('normalizeText', () => {
  test('returns null for null input', () => {
    expect(normalize(null)).toBeNull();
  });

  test('returns null for undefined input', () => {
    expect(normalize(undefined)).toBeNull();
  });

  test('returns null for empty string', () => {
    expect(normalize('')).toBeNull();
  });

  test('lowercases text', () => {
    expect(normalize('Hello World')).toBe('hello world');
  });

  test('trims whitespace', () => {
    expect(normalize('  hello  ')).toBe('hello');
  });

  test('collapses multiple spaces', () => {
    expect(normalize('hello    world')).toBe('hello world');
  });

  test('removes bold markdown', () => {
    expect(normalize('**bold text**')).toBe('bold text');
  });

  test('removes italic markdown', () => {
    expect(normalize('*italic text*')).toBe('italic text');
  });

  test('removes strikethrough', () => {
    expect(normalize('~~deleted~~')).toBe('deleted');
  });

  test('removes inline code', () => {
    expect(normalize('use `console.log()` here')).toBe('use console.log() here');
  });

  test('removes code blocks', () => {
    expect(normalize('before\n```\ncode\n```\nafter')).toBe('before after');
  });

  test('removes markdown links but keeps text', () => {
    expect(normalize('[click here](https://example.com)')).toBe('click here');
  });

  test('removes headings', () => {
    expect(normalize('## Heading')).toBe('heading');
  });

  test('removes blockquotes', () => {
    expect(normalize('> quoted text')).toBe('quoted text');
  });

  test('preserves Discord user mentions', () => {
    expect(normalize('<@1310813851511689299> help needed'))
      .toBe('<@1310813851511689299> help needed');
  });

  test('preserves multiple Discord mentions', () => {
    expect(normalize('<@111> and <@222> check this'))
      .toBe('<@111> and <@222> check this');
  });

  test('preserves role mentions', () => {
    expect(normalize('<@&123456789> role ping'))
      .toBe('<@&123456789> role ping');
  });

  test('preserves channel mentions', () => {
    expect(normalize('see <#987654321>'))
      .toBe('see <#987654321>');
  });

  test('removes emojis', () => {
    expect(normalize('hello 😂 world 🔥'))
      .toBe('hello world');
  });

  test('removes URLs', () => {
    expect(normalize('check https://example.com/path out'))
      .toBe('check out');
  });

  test('removes www URLs', () => {
    expect(normalize('go to www.example.com now'))
      .toBe('go to now');
  });

  test('combined: markdown + emoji + mention + lowercase', () => {
    expect(normalize('**Hey** <@1310813851511689299> check `this` out 😂'))
      .toBe('hey <@1310813851511689299> check this out');
  });

  test('returns null if only markdown and emojis remain', () => {
    expect(normalize('** 😂 **')).toBeNull();
  });

  test('handles complex real-world message', () => {
    const input = 'So I tried `npm install` and got a **403 error** 😡\n> Maybe try `<@123> suggested fix`?\n\n[docs](https://example.com)';
    const result = normalize(input);
    expect(result).toBe('so i tried npm install and got a 403 error\nmaybe try <@123> suggested fix?\ndocs');
  });

  test('handles underline markdown', () => {
    expect(normalize('__underlined__')).toBe('underlined');
  });

  test('handles horizontal rules', () => {
    expect(normalize('before\n---\nafter')).toBe('before after');
  });

  test('handles pipe characters from tables', () => {
    expect(normalize('| col1 | col2 |')).toBe('col1 col2');
  });
});
