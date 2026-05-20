import { assessActionability } from '../actionability';

const makeIssue = (title: string, body: string, labels: string[] = []) => ({
  number: 1,
  title,
  body,
  labels: labels.map(name => ({ name })),
});

describe('assessActionability', () => {
  describe('actionable issues', () => {
    it('marks clear bug report as actionable', () => {
      const issue = makeIssue(
        'bug: POST /api/users returns 500 for emails with + character',
        `Steps to reproduce:
1. POST /api/users with { "email": "user+test@example.com" }
2. Expected: 201 Created
3. Actual: 500 Internal Server Error

Acceptance criteria:
- Returns 201 for emails with + character
- Existing tests pass

File: src/middleware/validation.ts`
      );
      const result = assessActionability(issue);
      expect(result.score).toBe('actionable');
      expect(result.confidence).toBeGreaterThan(0.7);
    });

    it('marks feature request with clear spec as actionable', () => {
      const issue = makeIssue(
        'feat: Add rate limiting to login endpoint',
        `Requirements:
- Max 5 attempts per IP per 15 minutes
- Return 429 with Retry-After header

Acceptance criteria:
- [ ] 6th attempt returns 429
- [ ] Retry-After header present

Test command: npm run test:auth`
      );
      const result = assessActionability(issue);
      expect(result.score).toBe('actionable');
    });

    it('marks dependency upgrade as actionable', () => {
      const issue = makeIssue(
        'chore: Upgrade express from 4.18.0 to 4.19.2',
        `Update package.json: express ^4.18.0 → ^4.19.2
Run npm install and verify npm test passes.

Acceptance criteria:
- [ ] package.json shows 4.19.2
- [ ] npm test passes with 0 failures`
      );
      const result = assessActionability(issue);
      expect(result.score).toBe('actionable');
    });
  });

  describe('needs_info issues', () => {
    it('marks vague bug as needs_info', () => {
      const issue = makeIssue(
        'The login is broken',
        'Users are saying login does not work. Please fix ASAP.'
      );
      const result = assessActionability(issue);
      expect(result.score).toBe('needs_info');
      expect(result.missing.length).toBeGreaterThan(0);
      expect(result.suggestedComment).toBeDefined();
    });

    it('marks no-metrics performance issue as needs_info', () => {
      const issue = makeIssue(
        'API is too slow',
        'Our users are complaining about slow response times.'
      );
      const result = assessActionability(issue);
      expect(result.score).toBe('needs_info');
    });
  });

  describe('not_actionable issues', () => {
    it('marks architectural decision as not_actionable', () => {
      const issue = makeIssue(
        'Should we migrate from in-memory to PostgreSQL?',
        'Should we use PostgreSQL or MongoDB? Which ORM should we use?',
        ['discussion']
      );
      const result = assessActionability(issue);
      expect(result.score).toBe('not_actionable');
    });

    it('marks too-large task as not_actionable', () => {
      const issue = makeIssue(
        'Redesign the entire authentication system',
        `We need to redesign the entire auth system with:
- OAuth2 support
- Refresh tokens
- 2FA
- Session management
- Password reset flow
- Email verification
- Role-based access control
- Audit logging
- SSO support`
      );
      const result = assessActionability(issue);
      expect(result.score).toBe('not_actionable');
    });
  });
});
