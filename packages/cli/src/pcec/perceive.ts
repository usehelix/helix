import Anthropic from '@anthropic-ai/sdk';

export interface PerceiveResult {
  failure_code: string;     // e.g. "string-comparison-missing-normalization"
  category: string;         // e.g. "search", "error-handling", "null-check"
  confidence: number;       // 0-1
  keywords: string[];       // extracted from issue for Gene Map lookup
  typical_files: string[];  // predicted file paths
}

// ~15 known bug types that cover the long tail of common issues.
// Keyword matching is a fast path; unknown types fall through to LLM classification.
const KNOWN_BUG_TYPES: Record<string, string[]> = {
  'string-comparison-missing-normalization': [
    'case insensitive', 'search not working', 'spacing', 'normalize',
    'tolowercase', 'includes', 'search fails', 'not found', 'inconsistent',
  ],
  'error-not-handled': [
    'prisma error', 'raw error', 'stack trace', 'unhandled', '500',
    'internal server error', 'finduniqueorthrow', 'findunique', 'throws', 'not caught',
  ],
  'null-not-checked': [
    'cannot read properties', 'undefined', 'null', 'typeerror',
    'is not a function', 'null reference',
  ],
  'missing-return-status': [
    '404', 'not found', 'wrong status', 'returns 500', 'should return',
    'incorrect status code',
  ],
  'async-not-awaited': [
    'promise', 'async', 'await missing', 'unresolved', 'then not called',
  ],
  'regex-too-strict': [
    'regex', 'invalid email', 'format not accepted', 'character not allowed',
    'validation fails', 'pattern',
  ],
  'race-condition': [
    'race condition', 'concurrent', 'parallel', 'conflict', 'double',
    'duplicate', 'nonce',
  ],
  'missing-validation': [
    'validation missing', 'no validation', 'accepts invalid',
    'should reject', 'unchecked input',
  ],
  'stale-cache': [
    'cache', 'stale', 'not updating', 'cached', 'invalidate', 'refresh',
  ],
  'type-mismatch': [
    'type error', 'string vs number', 'boolean', 'coercion', 'nan',
  ],
  'missing-dependency-check': [
    'dependency', 'import missing', 'module not found', 'undefined function',
  ],
  'off-by-one': [
    'off by one', 'boundary', 'fence post', 'index', 'length', 'last item',
  ],
  'memory-leak': [
    'memory leak', 'listener not removed', 'subscription', 'cleanup',
    'unmount', 'useeffect',
  ],
  'cors-missing': [
    'cors', 'cross-origin', 'blocked', 'access-control', 'preflight',
  ],
  'env-var-missing': [
    'environment variable', 'process.env', 'undefined env', 'config missing',
  ],
};

export async function perceive(issueTitle: string, issueBody: string): Promise<PerceiveResult> {
  const combined = `${issueTitle}\n${issueBody}`.toLowerCase();

  // Fast path: keyword matching (no LLM needed). Requires 2+ matches to avoid false positives.
  for (const [failure_code, keywords] of Object.entries(KNOWN_BUG_TYPES)) {
    const matches = keywords.filter(kw => combined.includes(kw.toLowerCase()));
    if (matches.length >= 2) {
      return {
        failure_code,
        category: failure_code.split('-')[0],
        confidence: Math.min(0.5 + matches.length * 0.1, 0.95),
        keywords: matches,
        typical_files: guessTypicalFiles(failure_code),
      };
    }
  }

  // Slow path: LLM classification (for unknown types).
  return perceiveWithLLM(issueTitle, issueBody);
}

async function perceiveWithLLM(issueTitle: string, issueBody: string): Promise<PerceiveResult> {
  try {
    const client = new Anthropic();
    const response = await client.messages.create({
      model: 'claude-opus-4-7',
      max_tokens: 300,
      messages: [{
        role: 'user',
        content: `Classify this GitHub issue into a bug type.

Issue title: ${issueTitle}
Issue body: ${issueBody.slice(0, 500)}

Respond ONLY with JSON (no markdown):
{
  "failure_code": "short-kebab-case-bug-type",
  "category": "one word category",
  "confidence": 0.7,
  "keywords": ["keyword1", "keyword2"],
  "typical_files": ["path/pattern/*.ts"]
}`,
      }],
    });

    const text = response.content[0].type === 'text' ? response.content[0].text : '';
    const clean = text.replace(/```json\n?|```\n?/g, '').trim();
    return JSON.parse(clean);
  } catch {
    return {
      failure_code: 'unknown-bug-type',
      category: 'unknown',
      confidence: 0.3,
      keywords: [],
      typical_files: [],
    };
  }
}

function guessTypicalFiles(failure_code: string): string[] {
  const fileMap: Record<string, string[]> = {
    'string-comparison-missing-normalization': ['components/*.tsx', 'modules/*/components/*.tsx', 'utils/*.ts'],
    'error-not-handled': ['pages/api/*.ts', 'app/api/**/*.ts', 'routes/*.ts', 'controllers/*.ts'],
    'null-not-checked': ['components/*.tsx', 'pages/*.tsx', 'utils/*.ts'],
    'missing-return-status': ['pages/api/*.ts', 'app/api/**/*.ts'],
    'regex-too-strict': ['middleware/*.ts', 'utils/validation*.ts', 'lib/*.ts'],
    'memory-leak': ['components/*.tsx', 'hooks/*.ts'],
  };
  return fileMap[failure_code] || ['src/**/*.ts'];
}
