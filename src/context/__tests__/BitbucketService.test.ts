import { describe, expect, it } from 'vitest';
import { BitbucketService } from '../BitbucketService';

describe('BitbucketService', () => {
  const svc = new BitbucketService();

  it('parses Bitbucket Cloud SSH and HTTPS remote URLs', () => {
    expect(
      svc.parseRemoteUrl('origin', 'git@bitbucket.org:my-team/core-api.git')
    ).toEqual({
      kind: 'cloud',
      remoteName: 'origin',
      baseUrl: 'https://api.bitbucket.org/2.0',
      webBaseUrl: 'https://bitbucket.org',
      workspaceOrProject: 'my-team',
      repoSlug: 'core-api',
    });

    expect(
      svc.parseRemoteUrl('upstream', 'https://user@bitbucket.org/my-team/core-api.git')
    ).toEqual({
      kind: 'cloud',
      remoteName: 'upstream',
      baseUrl: 'https://api.bitbucket.org/2.0',
      webBaseUrl: 'https://bitbucket.org',
      workspaceOrProject: 'my-team',
      repoSlug: 'core-api',
    });
  });

  it('parses Bitbucket Server / Data Center SSH and HTTPS URLs', () => {
    expect(
      svc.parseRemoteUrl(
        'origin',
        'https://bitbucket.corp.internal/scm/PLAT/payment-service.git'
      )
    ).toEqual({
      kind: 'server',
      remoteName: 'origin',
      baseUrl: 'https://bitbucket.corp.internal',
      webBaseUrl: 'https://bitbucket.corp.internal',
      workspaceOrProject: 'PLAT',
      repoSlug: 'payment-service',
    });

    expect(
      svc.parseRemoteUrl(
        'origin',
        'ssh://git@bitbucket.corp.internal:7999/PLAT/payment-service.git'
      )
    ).toEqual({
      kind: 'server',
      remoteName: 'origin',
      baseUrl: 'https://bitbucket.corp.internal',
      webBaseUrl: 'https://bitbucket.corp.internal',
      workspaceOrProject: 'PLAT',
      repoSlug: 'payment-service',
    });
  });

  it('parses Cloud and Server PR URLs accurately', () => {
    expect(
      svc.parsePrUrl('https://bitbucket.org/acme/webapp/pull-requests/42/overview')
    ).toEqual({
      kind: 'cloud',
      baseUrl: 'https://api.bitbucket.org/2.0',
      workspaceOrProject: 'acme',
      repoSlug: 'webapp',
      prId: 42,
    });

    expect(
      svc.parsePrUrl(
        'https://bb.company.com/bitbucket/projects/ENG/repos/gateway/pull-requests/108/diff'
      )
    ).toEqual({
      kind: 'server',
      baseUrl: 'https://bb.company.com/bitbucket',
      workspaceOrProject: 'ENG',
      repoSlug: 'gateway',
      prId: 108,
    });
  });
});
