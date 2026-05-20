import { stripMarkdownFence } from '../planner';

describe('stripMarkdownFence', () => {
  it('strips ```json fence wrapping', () => {
    const input = '```json\n{"steps":[]}\n```';
    expect(stripMarkdownFence(input)).toBe('{"steps":[]}');
  });

  it('strips bare ``` fence wrapping', () => {
    const input = '```\n{"steps":[]}\n```';
    expect(stripMarkdownFence(input)).toBe('{"steps":[]}');
  });

  it('passes through plain JSON unchanged (modulo trim)', () => {
    expect(stripMarkdownFence('{"a":1}')).toBe('{"a":1}');
    expect(stripMarkdownFence('  {"a":1}  ')).toBe('{"a":1}');
  });

  it('output is valid JSON parseable into the expected shape', () => {
    const raw = '```json\n{"steps":[{"index":1,"title":"x"}],"testCommand":"npm test"}\n```';
    const parsed = JSON.parse(stripMarkdownFence(raw));
    expect(parsed.steps).toHaveLength(1);
    expect(parsed.testCommand).toBe('npm test');
  });
});
