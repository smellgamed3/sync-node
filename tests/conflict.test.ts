import { describe, expect, it } from 'vitest';
import { resolveConflict } from '../src/shared/conflict.js';

const base = {
  syncId: 's1',
  path: 'a.txt',
  cid: 'cid-1',
  size: 1,
  modTime: 100,
  version: 1,
  updatedBy: 'peer-a',
  updatedAt: 100,
};

describe('resolveConflict', () => {
  it('prefers the higher version', () => {
    expect(resolveConflict(base, { ...base, cid: 'cid-2', version: 2 })).toBe('remote');
  });

  it('prefers the latest timestamp when versions match', () => {
    expect(resolveConflict(base, { ...base, cid: 'cid-2', updatedAt: 200 })).toBe('remote');
  });
});
