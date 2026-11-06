import { Fragment, type ReactNode } from 'react';

// Literal, bounded terms: punctuation is not a regular expression and a long
// query cannot create an unbounded number of marks in every visible row.
export function searchPattern(query: string): RegExp | null {
  const terms = [...new Set(query.slice(0, 256).trim().split(/\s+/u).filter(Boolean).slice(0, 6).map(term => term.slice(0, 64)))];
  if (!terms.length) return null;
  return new RegExp(terms.sort((a, b) => b.length - a.length).map(term => term.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')).join('|'), 'giu');
}

export function Highlight({text, pattern}: {text: string; pattern: RegExp | null}) {
  if (!pattern) return text;
  const parts: ReactNode[] = [];
  let end = 0, count = 0;
  for (const match of text.matchAll(pattern)) {
    if (count++ >= 8) break;
    const start = match.index!;
    parts.push(text.slice(end, start), <mark key={start}>{match[0]}</mark>);
    end = start + match[0].length;
  }
  parts.push(text.slice(end));
  return <Fragment>{parts}</Fragment>;
}
