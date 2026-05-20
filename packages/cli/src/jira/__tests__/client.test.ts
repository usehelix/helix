import axios from 'axios';
import { JiraClient } from '../client';

jest.mock('axios');
const mockedAxios = axios as jest.Mocked<typeof axios>;

describe('JiraClient', () => {
  let mockHttp: any;

  beforeEach(() => {
    mockHttp = {
      get: jest.fn(),
      post: jest.fn(),
    };
    mockedAxios.create.mockReturnValue(mockHttp);
  });

  it('getIssue: returns issue data on 200', async () => {
    mockHttp.get.mockResolvedValue({
      data: {
        key: 'HELIX-1',
        fields: {
          summary: 's',
          description: null,
          labels: [],
          project: { key: 'HELIX' },
          status: { name: 'To Do' },
          issuetype: { name: 'Bug' },
        },
      },
    });
    const client = new JiraClient({ baseUrl: 'https://x.atlassian.net', email: 'a@b.com', apiToken: 't' });
    const issue = await client.getIssue('HELIX-1');
    expect(issue.key).toBe('HELIX-1');
    expect(mockHttp.get).toHaveBeenCalledWith('/issue/HELIX-1');
  });

  it('getIssue: throws wrapped error on 401', async () => {
    const err: any = new Error('Unauthorized');
    err.isAxiosError = true;
    err.response = { status: 401, data: { errorMessages: ['Bad credentials'] } };
    mockHttp.get.mockRejectedValue(err);

    const client = new JiraClient({ baseUrl: 'https://x.atlassian.net', email: 'a@b.com', apiToken: 't' });
    await expect(client.getIssue('HELIX-1')).rejects.toThrow(/HTTP 401/);
  });

  it('getIssue: throws wrapped error on network failure', async () => {
    const err: any = new Error('ECONNREFUSED');
    err.isAxiosError = true;
    mockHttp.get.mockRejectedValue(err);

    const client = new JiraClient({ baseUrl: 'https://x.atlassian.net', email: 'a@b.com', apiToken: 't' });
    await expect(client.getIssue('HELIX-1')).rejects.toThrow(/ECONNREFUSED/);
  });

  it('addComment: wraps plain text in ADF format', async () => {
    mockHttp.post.mockResolvedValue({ data: {} });
    const client = new JiraClient({ baseUrl: 'https://x.atlassian.net', email: 'a@b.com', apiToken: 't' });
    await client.addComment('HELIX-1', 'hello world');
    expect(mockHttp.post).toHaveBeenCalledWith(
      '/issue/HELIX-1/comment',
      expect.objectContaining({
        body: expect.objectContaining({
          type: 'doc',
          version: 1,
          content: expect.arrayContaining([
            expect.objectContaining({
              type: 'paragraph',
              content: expect.arrayContaining([
                expect.objectContaining({ type: 'text', text: 'hello world' }),
              ]),
            }),
          ]),
        }),
      }),
    );
  });

  it('strips trailing slash from baseUrl when creating axios instance', () => {
    new JiraClient({ baseUrl: 'https://x.atlassian.net/', email: 'a@b.com', apiToken: 't' });
    expect(mockedAxios.create).toHaveBeenCalledWith(
      expect.objectContaining({ baseURL: 'https://x.atlassian.net/rest/api/3' }),
    );
  });
});
