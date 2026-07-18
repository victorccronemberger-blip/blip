// confirm_finding tool. The model calls this when it has reproduced a
// vulnerability end-to-end. Writes a markdown file under ./findings/ and
// emits a notifier callback so the TUI can show an in-transcript alert.

import { type Finding, type Severity, type Store, slugify } from '../findings/store.js';
import type { Prompter } from '../permission/permission.js';
import { type Tool, argString } from './types.js';

const SEVERITIES: Severity[] = ['critical', 'high', 'medium', 'low', 'info'];

export type FindingNotifier = (f: Finding, path: string) => void;

export class ConfirmFindingTool implements Tool {
  private readonly store: Store;
  private readonly notifier: FindingNotifier;

  constructor(store: Store, notifier: FindingNotifier = () => undefined) {
    this.store = store;
    this.notifier = notifier;
  }

  name(): string {
    return 'confirm_finding';
  }

  description(): string {
    return [
      'Persist a CONFIRMED vulnerability finding. Call this ONLY after you have reproduced the bug end-to-end with a real request and observed a response that proves it.',
      '',
      "Writes a markdown report under ./findings/<slug>.md and surfaces a banner in the TUI. Do not call for theoretical findings, scanner hits you haven't manually verified, or 'suspected' behavior.",
    ].join('\n');
  }

  schema(): Record<string, unknown> {
    return {
      type: 'object',
      properties: {
        title: { type: 'string', description: 'Short descriptive title.' },
        severity: {
          type: 'string',
          enum: SEVERITIES,
          description: 'Severity (Bugcrowd VRT P1–P5 → critical/high/medium/low/info).',
        },
        url: { type: 'string', description: 'Exact affected endpoint URL.' },
        parameter: { type: 'string', description: 'Parameter injected/abused, if applicable.' },
        payload: { type: 'string', description: 'Exact payload that triggered the bug.' },
        method: { type: 'string', description: 'HTTP method (GET/POST/PUT/...).' },
        response_excerpt: {
          type: 'string',
          description: 'Short response snippet proving the bug.',
        },
        impact: {
          type: 'string',
          description: 'One concrete sentence: what an attacker can do.',
        },
        curl: { type: 'string', description: 'Copy-pasteable curl one-liner to reproduce.' },
        remediation: { type: 'string', description: 'Brief remediation guidance (optional).' },
      },
      required: ['title', 'severity', 'url', 'impact'],
    };
  }

  /** No permission gate — writing a markdown file is benign and the user
   *  explicitly invited findings to land here. */
  requiresPermission(): boolean {
    return false;
  }

  summarize(args: Record<string, unknown>): { summary: string; detail: string } {
    const title = argString(args, 'title');
    const severity = argString(args, 'severity');
    return { summary: `finding (${severity}): ${title}`, detail: JSON.stringify(args, null, 2) };
  }

  async run(args: Record<string, unknown>, _signal: AbortSignal, _p: Prompter): Promise<string> {
    const title = argString(args, 'title');
    const severityRaw = argString(args, 'severity').toLowerCase();
    const url = argString(args, 'url');
    const impact = argString(args, 'impact');

    if (!title) throw new Error('title is required');
    if (!url) throw new Error('url is required');
    if (!impact) throw new Error('impact is required');
    if (!isSeverity(severityRaw)) {
      throw new Error(`severity must be one of: ${SEVERITIES.join(', ')}`);
    }

    const finding: Finding = {
      title,
      severity: severityRaw,
      url,
      impact,
      method: argString(args, 'method') || undefined,
      parameter: argString(args, 'parameter') || undefined,
      payload: argString(args, 'payload') || undefined,
      responseExcerpt: argString(args, 'response_excerpt') || undefined,
      curl: argString(args, 'curl') || undefined,
      remediation: argString(args, 'remediation') || undefined,
      createdAt: new Date().toISOString(),
      slug: slugify(title) || `finding-${Date.now()}`,
    };

    const path = await this.store.save(finding);
    this.notifier(finding, path);

    return `Finding "${finding.title}" written to ${path}`;
  }
}

function isSeverity(s: string): s is Severity {
  return (SEVERITIES as string[]).includes(s);
}
