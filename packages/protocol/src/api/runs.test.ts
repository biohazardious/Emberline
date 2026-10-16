import { describe, expect, it } from 'vitest';
import { PROVIDER_REGISTRY } from './runs.js';

describe('PROVIDER_REGISTRY terms', () => {
  it('every provider carries a dated terms note with an https link and a risk level', () => {
    for (const entry of Object.values(PROVIDER_REGISTRY)) {
      const { terms } = entry;
      expect(terms, entry.id).toBeDefined();
      expect(terms.url, entry.id).toMatch(/^https:\/\//);
      expect(terms.checked, entry.id).toMatch(/^\d{4}-\d{2}-\d{2}$/);
      expect(Number.isNaN(Date.parse(terms.checked)), entry.id).toBe(false);
      expect(['low', 'medium', 'high'], entry.id).toContain(terms.risk);
      expect(terms.summary.length, entry.id).toBeGreaterThan(0);
    }
  });
});
