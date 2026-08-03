import { describe, it, expect } from 'vitest';
import { diffWords } from './diffWords';

describe('diffWords', () => {
  it('returns all "same" tokens for identical text', () => {
    const result = diffWords('hello world', 'hello world');
    expect(result.every((t) => t.type === 'same')).toBe(true);
  });

  it('detects an appended word as "added"', () => {
    const result = diffWords('Patient is stable', 'Patient is stable now');
    const added = result.filter((t) => t.type === 'added').map((t) => t.text);
    expect(added).toContain('now');
  });

  it('detects a removed word as "removed"', () => {
    const result = diffWords('Patient is very stable', 'Patient is stable');
    const removed = result.filter((t) => t.type === 'removed').map((t) => t.text);
    expect(removed).toContain('very');
  });

  it('handles a full replacement (old text entirely removed, new entirely added)', () => {
    const result = diffWords('foo', 'bar');
    expect(result.some((t) => t.type === 'removed' && t.text === 'foo')).toBe(true);
    expect(result.some((t) => t.type === 'added' && t.text === 'bar')).toBe(true);
  });

  it('handles empty strings without throwing', () => {
    expect(() => diffWords('', '')).not.toThrow();
    expect(() => diffWords('', 'new text')).not.toThrow();
    expect(() => diffWords('old text', '')).not.toThrow();
  });

  it('reconstructs the new text exactly when concatenating same+added tokens', () => {
    const oldText = 'The patient reports mild discomfort';
    const newText = 'The patient reports significant discomfort today';
    const result = diffWords(oldText, newText);
    const reconstructed = result
      .filter((t) => t.type === 'same' || t.type === 'added')
      .map((t) => t.text)
      .join('');
    expect(reconstructed).toBe(newText);
  });
});