import { arch, homedir, platform } from 'node:os';

export function getPlatformInfo() {
  return {
    platform: platform(),
    arch: arch(),
    home: homedir(),
  };
}
