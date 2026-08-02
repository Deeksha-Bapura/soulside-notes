// Basic word-level diff via Longest Common Subsequence. Deliberately NOT
// character-level (that's explicitly out of scope per our earlier scoping
// decision — word-level is enough to show what changed in a clinical note
// without the noise of char-by-char highlighting).

export type DiffToken = { text: string; type: 'same' | 'added' | 'removed' };

export function diffWords(oldText: string, newText: string): DiffToken[] {
  const oldWords = oldText.split(/(\s+)/); // keep whitespace as its own tokens
  const newWords = newText.split(/(\s+)/);

  const m = oldWords.length;
  const n = newWords.length;

  // Standard LCS length table.
  const lcs: number[][] = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0));
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      lcs[i][j] =
        oldWords[i - 1] === newWords[j - 1]
          ? lcs[i - 1][j - 1] + 1
          : Math.max(lcs[i - 1][j], lcs[i][j - 1]);
    }
  }

  // Walk the table backwards to reconstruct same/added/removed tokens.
  const result: DiffToken[] = [];
  let i = m;
  let j = n;
  while (i > 0 || j > 0) {
    if (i > 0 && j > 0 && oldWords[i - 1] === newWords[j - 1]) {
      result.unshift({ text: oldWords[i - 1], type: 'same' });
      i--;
      j--;
    } else if (j > 0 && (i === 0 || lcs[i][j - 1] >= lcs[i - 1][j])) {
      result.unshift({ text: newWords[j - 1], type: 'added' });
      j--;
    } else if (i > 0) {
      result.unshift({ text: oldWords[i - 1], type: 'removed' });
      i--;
    }
  }
  return result;
}