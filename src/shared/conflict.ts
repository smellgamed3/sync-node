import type { FileVersion } from './types.js';

export function resolveConflict(local: FileVersion, remote: FileVersion): 'local' | 'remote' {
  if (remote.version !== local.version) {
    return remote.version > local.version ? 'remote' : 'local';
  }

  if (remote.updatedAt !== local.updatedAt) {
    return remote.updatedAt > local.updatedAt ? 'remote' : 'local';
  }

  if (remote.modTime !== local.modTime) {
    return remote.modTime > local.modTime ? 'remote' : 'local';
  }

  return remote.updatedBy.localeCompare(local.updatedBy) > 0 ? 'remote' : 'local';
}
