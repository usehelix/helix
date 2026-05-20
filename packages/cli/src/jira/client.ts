import axios, { AxiosInstance, AxiosError } from 'axios';

export interface AdfDocument {
  type: string;
  version?: number;
  content?: AdfNode[];
}

export interface AdfNode {
  type: string;
  text?: string;
  content?: AdfNode[];
  attrs?: Record<string, unknown>;
}

export interface JiraIssue {
  key: string;
  fields: {
    summary: string;
    description: string | AdfDocument | null;
    labels: string[];
    project: { key: string };
    status: { name: string };
    issuetype: { name: string };
  };
}

export interface JiraCredentials {
  baseUrl: string;
  email: string;
  apiToken: string;
}

export class JiraClient {
  private http: AxiosInstance;

  constructor(creds: JiraCredentials) {
    const auth = Buffer.from(`${creds.email}:${creds.apiToken}`).toString('base64');
    this.http = axios.create({
      baseURL: `${creds.baseUrl.replace(/\/+$/, '')}/rest/api/3`,
      headers: {
        Authorization: `Basic ${auth}`,
        'Content-Type': 'application/json',
        Accept: 'application/json',
      },
      timeout: 10000,
    });
  }

  async getIssue(key: string): Promise<JiraIssue> {
    try {
      const { data } = await this.http.get(`/issue/${key}`);
      return data as JiraIssue;
    } catch (err) {
      throw wrapError(err, `getIssue(${key})`);
    }
  }

  /**
   * Post a comment using Jira v3 ADF format. Plain text input is wrapped.
   */
  async addComment(key: string, body: string): Promise<void> {
    try {
      await this.http.post(`/issue/${key}/comment`, {
        body: {
          type: 'doc',
          version: 1,
          content: [{
            type: 'paragraph',
            content: [{ type: 'text', text: body }],
          }],
        },
      });
    } catch (err) {
      throw wrapError(err, `addComment(${key})`);
    }
  }

  async transitionIssue(key: string, transitionId: string): Promise<void> {
    try {
      await this.http.post(`/issue/${key}/transitions`, {
        transition: { id: transitionId },
      });
    } catch (err) {
      throw wrapError(err, `transitionIssue(${key}, ${transitionId})`);
    }
  }
}

function wrapError(err: unknown, ctx: string): Error {
  const ax = err as AxiosError;
  if (ax.isAxiosError) {
    const status = ax.response?.status;
    const msg = (ax.response?.data as any)?.errorMessages?.[0] ?? ax.message;
    return new Error(`Jira ${ctx} failed${status ? ` (HTTP ${status})` : ''}: ${msg}`);
  }
  return err instanceof Error ? err : new Error(String(err));
}
