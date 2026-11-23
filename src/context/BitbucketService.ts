import type * as vscode from 'vscode';
import type { ReviewNoteDraft } from '../shared/protocol';
import type {
  BitbucketAuth,
  BitbucketPrMetadata,
  BitbucketRemoteInfo,
} from './types';

const SECRET_KEY_PREFIX = 'reviewAgents.bitbucket.auth';

export interface ParsedPrUrl {
  kind: 'cloud' | 'server';
  baseUrl: string;
  workspaceOrProject: string;
  repoSlug: string;
  prId: number;
}

export class BitbucketService {
  /**
   * Parses Bitbucket Cloud or Server/Data Center git remote URLs.
   */
  public parseRemoteUrl(
    remoteName: string,
    rawUrl: string,
    serverBaseUrlOverride?: string
  ): BitbucketRemoteInfo | null {
    const trimmed = rawUrl.trim();
    if (!trimmed) {
      return null;
    }

    // 1. Bitbucket Cloud SSH: git@bitbucket.org:workspace/repo.git
    const cloudSsh = trimmed.match(
      /^(?:ssh:\/\/)?git@bitbucket\.org[:/]([^/]+)\/([^/]+?)(?:\.git)?$/i
    );
    if (cloudSsh) {
      const workspace = cloudSsh[1];
      const repoSlug = cloudSsh[2];
      return {
        kind: 'cloud',
        remoteName,
        baseUrl: 'https://api.bitbucket.org/2.0',
        webBaseUrl: 'https://bitbucket.org',
        workspaceOrProject: workspace,
        repoSlug,
      };
    }

    // 2. Bitbucket Cloud HTTPS: https://[user@]bitbucket.org/workspace/repo.git
    const cloudHttps = trimmed.match(
      /^https?:\/\/(?:[^@]+@)?bitbucket\.org\/([^/]+)\/([^/]+?)(?:\.git)?$/i
    );
    if (cloudHttps) {
      const workspace = cloudHttps[1];
      const repoSlug = cloudHttps[2];
      return {
        kind: 'cloud',
        remoteName,
        baseUrl: 'https://api.bitbucket.org/2.0',
        webBaseUrl: 'https://bitbucket.org',
        workspaceOrProject: workspace,
        repoSlug,
      };
    }

    // 3. Bitbucket Server / Data Center SSH or HTTPS
    // e.g. ssh://git@bb.corp.com:7999/proj/repo.git
    //      ssh://git@bb.corp.com:7999/scm/proj/repo.git
    //      git@bb.corp.com:proj/repo.git
    //      https://bb.corp.com/scm/proj/repo.git
    let hostOrigin = '';
    let pathPart = '';

    if (/^https?:\/\//i.test(trimmed)) {
      try {
        const u = new URL(trimmed);
        hostOrigin = `${u.protocol}//${u.host}`;
        pathPart = u.pathname;
      } catch {
        return null;
      }
    } else if (/^ssh:\/\//i.test(trimmed)) {
      try {
        const u = new URL(trimmed);
        hostOrigin = `https://${u.hostname}`;
        pathPart = u.pathname;
      } catch {
        return null;
      }
    } else {
      const scpLike = trimmed.match(/^(?:[^@]+@)?([^:]+):(.+)$/);
      if (!scpLike) {
        return null;
      }
      hostOrigin = `https://${scpLike[1]}`;
      pathPart = `/${scpLike[2]}`;
    }

    // Ignore non-bitbucket well-known hosts unless explicitly overridden
    if (
      !serverBaseUrlOverride?.trim() &&
      /^(https?:\/\/)?(github\.com|gitlab\.com)$/i.test(hostOrigin)
    ) {
      return null;
    }

    const segments = pathPart
      .replace(/\.git$/i, '')
      .split('/')
      .filter(Boolean);

    if (segments.length < 2) {
      return null;
    }

    let contextPrefix = '';
    let project = '';
    let repoSlug = '';

    const scmIdx = segments.indexOf('scm');
    if (scmIdx !== -1 && segments.length >= scmIdx + 3) {
      if (scmIdx > 0) {
        contextPrefix = `/${segments.slice(0, scmIdx).join('/')}`;
      }
      project = segments[scmIdx + 1];
      repoSlug = segments[scmIdx + 2];
    } else {
      project = segments[segments.length - 2];
      repoSlug = segments[segments.length - 1];
      if (segments.length > 2) {
        contextPrefix = `/${segments.slice(0, segments.length - 2).join('/')}`;
      }
    }

    const effectiveBase = serverBaseUrlOverride?.trim()
      ? serverBaseUrlOverride.trim().replace(/\/+$/, '')
      : `${hostOrigin}${contextPrefix}`.replace(/\/+$/, '');

    return {
      kind: 'server',
      remoteName,
      baseUrl: effectiveBase,
      webBaseUrl: effectiveBase,
      workspaceOrProject: project,
      repoSlug,
    };
  }

  public parsePrUrl(rawUrl: string): ParsedPrUrl | null {
    let u: URL;
    try {
      u = new URL(rawUrl.trim());
    } catch {
      return null;
    }

    const parts = u.pathname.split('/').filter(Boolean);
    if (u.hostname.toLowerCase() === 'bitbucket.org') {
      // /{workspace}/{repo}/pull-requests/{id}
      const prIdx = parts.indexOf('pull-requests');
      if (prIdx >= 2 && parts[prIdx + 1]) {
        const prId = Number.parseInt(parts[prIdx + 1], 10);
        if (!Number.isNaN(prId)) {
          return {
            kind: 'cloud',
            baseUrl: 'https://api.bitbucket.org/2.0',
            workspaceOrProject: parts[prIdx - 2],
            repoSlug: parts[prIdx - 1],
            prId,
          };
        }
      }
      return null;
    }

    // Server / DC: [/{context}]/projects/{projectKey}/repos/{repoSlug}/pull-requests/{id}
    const projectsIdx = parts.indexOf('projects');
    const reposIdx = parts.indexOf('repos');
    const prIdx = parts.indexOf('pull-requests');
    if (
      projectsIdx !== -1 &&
      reposIdx === projectsIdx + 2 &&
      prIdx === reposIdx + 2 &&
      parts[prIdx + 1]
    ) {
      const prId = Number.parseInt(parts[prIdx + 1], 10);
      if (!Number.isNaN(prId)) {
        const contextPath =
          projectsIdx > 0 ? `/${parts.slice(0, projectsIdx).join('/')}` : '';
        return {
          kind: 'server',
          baseUrl: `${u.protocol}//${u.host}${contextPath}`,
          workspaceOrProject: parts[projectsIdx + 1],
          repoSlug: parts[reposIdx + 1],
          prId,
        };
      }
    }

    return null;
  }

  public async listOpenPullRequests(
    remote: BitbucketRemoteInfo,
    auth?: BitbucketAuth
  ): Promise<BitbucketPrMetadata[]> {
    if (remote.kind === 'cloud') {
      const url = `${remote.baseUrl}/repositories/${encodeURIComponent(
        remote.workspaceOrProject
      )}/${encodeURIComponent(remote.repoSlug)}/pullrequests?state=OPEN&pagelen=25`;
      const data = (await this.requestJson(url, auth)) as {
        values?: Array<Record<string, unknown>>;
      };
      return (data.values ?? []).map((item) => mapCloudPr(item));
    }

    const url = `${remote.baseUrl}/rest/api/1.0/projects/${encodeURIComponent(
      remote.workspaceOrProject
    )}/repos/${encodeURIComponent(remote.repoSlug)}/pull-requests?state=OPEN&limit=25`;
    const data = (await this.requestJson(url, auth)) as {
      values?: Array<Record<string, unknown>>;
    };
    return (data.values ?? []).map((item) => mapServerPr(item, remote));
  }

  public async getPullRequest(
    remote: BitbucketRemoteInfo,
    prId: number,
    auth?: BitbucketAuth
  ): Promise<BitbucketPrMetadata> {
    if (remote.kind === 'cloud') {
      const url = `${remote.baseUrl}/repositories/${encodeURIComponent(
        remote.workspaceOrProject
      )}/${encodeURIComponent(remote.repoSlug)}/pullrequests/${prId}`;
      const data = (await this.requestJson(url, auth)) as Record<string, unknown>;
      return mapCloudPr(data);
    }

    const url = `${remote.baseUrl}/rest/api/1.0/projects/${encodeURIComponent(
      remote.workspaceOrProject
    )}/repos/${encodeURIComponent(remote.repoSlug)}/pull-requests/${prId}`;
    const data = (await this.requestJson(url, auth)) as Record<string, unknown>;
    return mapServerPr(data, remote);
  }

  public async postPullRequestComment(
    remote: BitbucketRemoteInfo,
    prId: number,
    auth: BitbucketAuth,
    draft: Pick<ReviewNoteDraft, 'file' | 'line' | 'severity' | 'body'>
  ): Promise<void> {
    const formattedBody = `[${draft.severity.toUpperCase()}] ${draft.body}`;
    if (remote.kind === 'cloud') {
      const url = `${remote.baseUrl}/repositories/${encodeURIComponent(
        remote.workspaceOrProject
      )}/${encodeURIComponent(remote.repoSlug)}/pullrequests/${prId}/comments`;
      const payload: Record<string, unknown> = {
        content: { raw: formattedBody },
      };
      if (draft.file) {
        payload.inline =
          draft.line > 0
            ? { path: draft.file, to: draft.line }
            : { path: draft.file };
      }
      await this.requestJson(url, auth, 'POST', payload);
      return;
    }

    const url = `${remote.baseUrl}/rest/api/1.0/projects/${encodeURIComponent(
      remote.workspaceOrProject
    )}/repos/${encodeURIComponent(remote.repoSlug)}/pull-requests/${prId}/comments`;
    const payload: Record<string, unknown> = {
      text: formattedBody,
    };
    if (draft.file) {
      payload.anchor =
        draft.line > 0
          ? {
              path: draft.file,
              line: draft.line,
              lineType: 'ADDED',
              fileType: 'TO',
            }
          : {
              path: draft.file,
              fileType: 'TO',
            };
    }
    await this.requestJson(url, auth, 'POST', payload);
  }

  public async getStoredAuth(
    secrets: vscode.SecretStorage,
    baseUrl: string
  ): Promise<BitbucketAuth | undefined> {
    const raw = await secrets.get(secretKey(baseUrl));
    if (!raw) {
      return undefined;
    }
    try {
      const parsed = JSON.parse(raw) as BitbucketAuth;
      if (parsed.token) {
        return parsed;
      }
    } catch {
      return { token: raw };
    }
    return undefined;
  }

  public async saveStoredAuth(
    secrets: vscode.SecretStorage,
    baseUrl: string,
    auth: BitbucketAuth
  ): Promise<void> {
    await secrets.store(secretKey(baseUrl), JSON.stringify(auth));
  }

  private async requestJson(
    url: string,
    auth?: BitbucketAuth,
    method: 'GET' | 'POST' = 'GET',
    body?: unknown
  ): Promise<unknown> {
    const headers: Record<string, string> = {
      Accept: 'application/json',
    };
    if (body !== undefined) {
      headers['Content-Type'] = 'application/json';
    }
    if (auth?.token) {
      if (auth.username?.trim()) {
        const encoded = Buffer.from(`${auth.username.trim()}:${auth.token}`).toString(
          'base64'
        );
        headers.Authorization = `Basic ${encoded}`;
      } else {
        headers.Authorization = `Bearer ${auth.token}`;
      }
    }

    const res = await fetch(url, {
      method,
      headers,
      body: body !== undefined ? JSON.stringify(body) : undefined,
    });

    if (!res.ok) {
      const errText = await res.text().catch(() => '');
      throw new Error(
        `Bitbucket API ${method} ${url} failed (${res.status}): ${errText.slice(0, 300)}`
      );
    }

    const text = await res.text();
    return text ? JSON.parse(text) : {};
  }
}

function secretKey(baseUrl: string): string {
  return `${SECRET_KEY_PREFIX}:${baseUrl.replace(/\/+$/, '').toLowerCase()}`;
}

function mapCloudPr(raw: Record<string, unknown>): BitbucketPrMetadata {
  const source = (raw.source ?? {}) as Record<string, unknown>;
  const dest = (raw.destination ?? {}) as Record<string, unknown>;
  const sourceBranch = ((source.branch as Record<string, unknown>)?.name as string) ?? '';
  const sourceCommit = ((source.commit as Record<string, unknown>)?.hash as string) ?? '';
  const targetBranch = ((dest.branch as Record<string, unknown>)?.name as string) ?? '';
  const targetCommit = ((dest.commit as Record<string, unknown>)?.hash as string) ?? '';
  const authorObj = (raw.author ?? {}) as Record<string, unknown>;
  const links = (raw.links ?? {}) as Record<string, unknown>;
  const htmlLink = (links.html as Record<string, unknown>)?.href as string;

  return {
    id: Number(raw.id ?? 0),
    title: String(raw.title ?? ''),
    description: String(raw.description ?? ''),
    author: String(authorObj.display_name ?? authorObj.nickname ?? ''),
    state: String(raw.state ?? 'OPEN'),
    sourceBranch,
    sourceCommit,
    targetBranch,
    targetCommit,
    webUrl: htmlLink ?? '',
  };
}

function mapServerPr(
  raw: Record<string, unknown>,
  remote: BitbucketRemoteInfo
): BitbucketPrMetadata {
  const fromRef = (raw.fromRef ?? {}) as Record<string, unknown>;
  const toRef = (raw.toRef ?? {}) as Record<string, unknown>;
  const authorWrapper = (raw.author ?? {}) as Record<string, unknown>;
  const authorUser = (authorWrapper.user ?? {}) as Record<string, unknown>;
  const links = (raw.links ?? {}) as Record<string, unknown>;
  const selfArr = Array.isArray(links.self)
    ? (links.self as Array<Record<string, unknown>>)
    : [];
  const webUrl =
    (selfArr[0]?.href as string) ??
    `${remote.webBaseUrl}/projects/${remote.workspaceOrProject}/repos/${remote.repoSlug}/pull-requests/${raw.id}`;

  return {
    id: Number(raw.id ?? 0),
    title: String(raw.title ?? ''),
    description: String(raw.description ?? ''),
    author: String(authorUser.displayName ?? authorUser.name ?? ''),
    state: String(raw.state ?? 'OPEN'),
    sourceBranch: String(fromRef.displayId ?? ''),
    sourceCommit: String(fromRef.latestCommit ?? ''),
    targetBranch: String(toRef.displayId ?? ''),
    targetCommit: String(toRef.latestCommit ?? ''),
    webUrl,
  };
}
