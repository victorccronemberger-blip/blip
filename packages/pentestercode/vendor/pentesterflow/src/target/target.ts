// Engagement target. A pointer shared between the http tool and the
// agent's system prompt so /target updates propagate to both without
// rewiring.

export interface TargetSnapshot {
  baseURL: string;
  name: string;
}

export class Target {
  private _baseURL = '';
  private _name = '';

  baseURL(): string {
    return this._baseURL;
  }

  name(): string {
    return this._name;
  }

  setBaseURL(u: string): void {
    this._baseURL = u.trim();
  }

  setName(n: string): void {
    this._name = n.trim();
  }

  clear(): void {
    this._baseURL = '';
    this._name = '';
  }

  empty(): boolean {
    return this._baseURL === '' && this._name === '';
  }

  /** Replace this target's fields from another, in place. */
  copyFrom(other: TargetSnapshot | Target | null | undefined): void {
    if (!other) return;
    if (other instanceof Target) {
      this._baseURL = other._baseURL;
      this._name = other._name;
      return;
    }
    this._baseURL = other.baseURL ?? '';
    this._name = other.name ?? '';
  }

  /** JSON shape kept stable so saved sessions interop across versions. */
  toJSON(): TargetSnapshot {
    return { baseURL: this._baseURL, name: this._name };
  }

  static fromJSON(raw: unknown): Target {
    const t = new Target();
    if (raw && typeof raw === 'object') {
      const obj = raw as Record<string, unknown>;
      if (typeof obj.baseURL === 'string') t._baseURL = obj.baseURL;
      if (typeof obj.name === 'string') t._name = obj.name;
    }
    return t;
  }
}

export function newTarget(): Target {
  return new Target();
}
