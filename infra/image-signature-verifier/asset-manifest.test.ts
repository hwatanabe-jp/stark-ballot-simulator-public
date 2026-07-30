import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface ExecutableAsset {
  version: string;
  url: string;
  archiveSha256?: string;
  executableSha256: string;
  installedPath: string;
  licenseUrl?: string;
  licenseSha256?: string;
  noticeUrl?: string;
  noticeSha256?: string;
}

interface AssetManifest {
  kind: string;
  verifierVersion: string;
  platforms: Record<
    string,
    {
      os: string;
      architecture: string;
      elfMachine: number;
      notation: ExecutableAsset;
      awsSignerPlugin: ExecutableAsset;
      ecrCredentialHelper: ExecutableAsset;
    }
  >;
  trustRoot: {
    name: string;
    url: string;
    sha256: string;
    installedPath: string;
  };
}

const manifestPath = path.join(process.cwd(), 'infra/image-signature-verifier/asset-manifest.json');

describe('image signature verifier asset manifest', () => {
  it('pins the audited native binaries and commercial AWS Signer trust root without schema versions', async () => {
    const raw = await readFile(manifestPath, 'utf8');
    const manifest = JSON.parse(raw) as AssetManifest;

    expect(manifest.kind).toBe('image-signature-verifier-assets');
    expect(manifest.verifierVersion).toBe('notation@1.3.2+aws-signer-plugin@1.0.2292');
    expect(raw).not.toContain('schemaVersion'); // operational-versioning-allow: rejection-fixture
    expect(createHash('sha256').update(raw).digest('hex')).toBe(
      '12934910cc512bc0a3cb86fa1b2797d58df1fe208be19872f0b0c0ed9eedcecf',
    );

    expect(manifest.platforms['linux-amd64']).toMatchObject({
      os: 'linux',
      architecture: 'amd64',
      elfMachine: 62,
      notation: {
        version: '1.3.2',
        url: 'https://github.com/notaryproject/notation/releases/download/v1.3.2/notation_1.3.2_linux_amd64.tar.gz',
        archiveSha256: 'e1a0f060308086bf8020b2d31defb7c5348f133ca0dba6a1a7820ef3cbb6dfe5',
        executableSha256: '489dc2cd1fe181ea39d78b4f85560857dcd1d814fdb29b22938bcefc33862dae',
        installedPath: 'bin/notation',
      },
      awsSignerPlugin: {
        version: '1.0.2292',
        url:
          'https://d2hvyiie56hcat.cloudfront.net/linux/amd64/plugin/latest/notation-aws-signer-plugin.zip' +
          '?versionId=qvud6WsClmu01IUQY_HQFmVThMdbEf7L',
        archiveSha256: 'f8efa548932edc4851f4ba464496994bad753cdf21cd32baa575f7291a26c7b9',
        executableSha256: '453d48ca47bfb2f0a5b401e39febc0f72f1fce17f20b31669da39353cb0e213a',
      },
      ecrCredentialHelper: {
        version: '0.12.0',
        url: 'https://amazon-ecr-credential-helper-releases.s3.us-east-2.amazonaws.com/0.12.0/linux-amd64/docker-credential-ecr-login',
        executableSha256: 'a22ab6d59dbac777b8fb31984709461da00a4c778b6ae14c8d3729e8d5ded1a6',
        licenseUrl:
          'https://raw.githubusercontent.com/awslabs/amazon-ecr-credential-helper/' +
          '7ff7d6bd7a06408ddb9646c9ebccf97dbd190d55/LICENSE',
        licenseSha256: 'ce65129252f145d6dd627bc354ccc28ba07c6cd27a8d278b7dcfde3ed6976a5a',
        noticeUrl:
          'https://raw.githubusercontent.com/awslabs/amazon-ecr-credential-helper/' +
          '7ff7d6bd7a06408ddb9646c9ebccf97dbd190d55/NOTICE',
        noticeSha256: '5a363e5e02576476f35ae8c98e980d0d9b2aaafd5cbc819ad9a1d48e5636e74b',
      },
    });

    expect(manifest.platforms['linux-arm64']).toMatchObject({
      os: 'linux',
      architecture: 'arm64',
      elfMachine: 183,
      notation: {
        version: '1.3.2',
        archiveSha256: '34143c7b816a50104824278080a5cf12bbf855488e003f62e6acf27ed25c423c',
        executableSha256: '14a9686d4018f4c5f8da0f2798ed026878d0cfe0b241bfdbf4ab4034f4c47214',
      },
      awsSignerPlugin: {
        version: '1.0.2292',
        url:
          'https://d2hvyiie56hcat.cloudfront.net/linux/arm64/plugin/latest/notation-aws-signer-plugin.zip' +
          '?versionId=btPGOLae36BvGUnf51aaTpYY2JAGNKEh',
        archiveSha256: 'b416954ac98a20d71f968c4f7cd7b13905328352f43298a405a8261016a8be51',
        executableSha256: 'c65940608ff6d5c7532915ce917365c0b6edb2dd7e7e4504eac6b3170488ec77',
      },
      ecrCredentialHelper: {
        version: '0.12.0',
        executableSha256: '5bdd30fb6c7a92462f5b454cce1aa906ca7926a6c2e39efad9613a7bf7661fac',
        licenseSha256: 'ce65129252f145d6dd627bc354ccc28ba07c6cd27a8d278b7dcfde3ed6976a5a',
        noticeSha256: '5a363e5e02576476f35ae8c98e980d0d9b2aaafd5cbc819ad9a1d48e5636e74b',
      },
    });

    expect(manifest.trustRoot).toEqual({
      name: 'aws-signer-ts',
      url:
        'https://d2hvyiie56hcat.cloudfront.net/aws-signer-notation-root.cert' +
        '?versionId=iiaChgo0ywBugl8.H3E7MDQNMQxdPcmD',
      sha256: '0ccf529561f610b9eb7f9b0ee02fffe2f74f7ffdf0ac56348ca224e879461c9b',
      installedPath: 'trust/aws-signer-notation-root.cert',
    });
  });
});
