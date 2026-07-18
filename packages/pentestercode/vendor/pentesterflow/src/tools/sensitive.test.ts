// Sensitive-path classification test cases.

import { homedir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { isSensitivePath } from './sensitive.js';

const home = homedir();

describe('isSensitivePath', () => {
  const cases: Array<{ path: string; want: boolean }> = [
    { path: join(home, '.ssh', 'id_rsa'), want: true },
    { path: join(home, '.aws', 'credentials'), want: true },
    { path: join(home, '.kube', 'config'), want: true },
    { path: join(home, '.bash_history'), want: true },
    { path: '/etc/shadow', want: true },
    { path: '/etc/sudoers', want: true },

    { path: join(home, 'Documents', 'notes.txt'), want: false },
    { path: '/etc/passwd', want: false },
    { path: join(home, '.ssh_other'), want: false },
    { path: join(home, '.aws-not'), want: false },
  ];

  for (const tc of cases) {
    it(`${tc.path} → ${tc.want}`, () => {
      expect(isSensitivePath(tc.path)).toBe(tc.want);
    });
  }
});
