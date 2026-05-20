import { HelixError, ErrorCategory } from '../index';
import { displayError } from '../display';

describe('displayError', () => {
  let errOut: string;
  let origErr: typeof console.error;

  beforeEach(() => {
    errOut = '';
    origErr = console.error;
    console.error = (...args: any[]) => { errOut += args.join(' ') + '\n'; };
  });

  afterEach(() => {
    console.error = origErr;
  });

  it('formats a HelixError with message + remediation block', () => {
    const err = new HelixError({
      category: ErrorCategory.AUTH_NO_TOKEN,
      message: 'GitHub authentication required',
      remediation: ['Run: vial auth login', 'Or set GITHUB_TOKEN env var'],
    });
    displayError(err);
    expect(errOut).toContain('GitHub authentication required');
    expect(errOut).toContain('What to do:');
    expect(errOut).toContain('Run: vial auth login');
    expect(errOut).toContain('Or set GITHUB_TOKEN env var');
  });

  it('prompts to report when given a generic Error (not a HelixError)', () => {
    displayError(new Error('boom'));
    expect(errOut).toContain('Unexpected error');
    expect(errOut).toContain('boom');
    expect(errOut).toContain('github.com/adrianhihi/helix/issues/new');
  });

  it('survives a non-Error value (string, undefined, etc.)', () => {
    expect(() => displayError('something weird')).not.toThrow();
    expect(errOut).toContain('Unknown error');
    expect(errOut).toContain('something weird');
  });

  it('shows cause stack only when debug=true', () => {
    const err = new HelixError({
      category: ErrorCategory.CLAUDE_RATE_LIMITED,
      message: 'rate limited',
      remediation: ['wait'],
      cause: new Error('raw underlying error'),
    });

    displayError(err, { debug: true });
    expect(errOut).toContain('Debug info');
    expect(errOut).toContain('raw underlying error');

    errOut = '';
    displayError(err, { debug: false });
    expect(errOut).not.toContain('raw underlying error');
    expect(errOut).toContain('VIAL_DEBUG=1');
  });

  it('renders docsUrl when present', () => {
    const err = new HelixError({
      category: ErrorCategory.AUTH_NO_TOKEN,
      message: 'no token',
      remediation: ['Run: vial auth login'],
      docsUrl: 'https://helix.dev/docs/install#auth',
    });
    displayError(err);
    expect(errOut).toContain('helix.dev/docs/install');
  });

  it('mentions retryable hint when error.retryable=true', () => {
    const err = new HelixError({
      category: ErrorCategory.NETWORK_TIMEOUT,
      message: 'timed out',
      remediation: ['Retry'],
      retryable: true,
    });
    displayError(err);
    expect(errOut).toContain('transient');
  });
});
