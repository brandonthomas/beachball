import fs from 'fs-extra';
import path from 'path';
import { git, addGitObserver, clearGitObservers } from 'workspace-tools';
import { generateChangeFiles } from '../__fixtures__/changeFiles';
import { defaultRemoteBranchName } from '../__fixtures__/gitDefaults';
import { initMockLogs } from '../__fixtures__/mockLogs';
import { MonoRepoFactory } from '../__fixtures__/monorepo';
import { npmShow, NpmShowResult } from '../__fixtures__/npmShow';
import { Registry } from '../__fixtures__/registry';
import { Repository, RepositoryFactory } from '../__fixtures__/repository';
import { publish } from '../commands/publish';
import { getDefaultOptions } from '../options/getDefaultOptions';
import { BeachballOptions } from '../types/BeachballOptions';

describe('publish command (e2e)', () => {
  let registry: Registry;
  let repositoryFactory: RepositoryFactory | MonoRepoFactory | undefined;

  // show error logs for these tests
  initMockLogs(['error']);

  function getOptions(repo: Repository, overrides?: Partial<BeachballOptions>): BeachballOptions {
    return {
      ...getDefaultOptions(),
      branch: defaultRemoteBranchName,
      registry: registry.getUrl(),
      path: repo.rootPath,
      command: 'publish',
      message: 'apply package updates',
      tag: 'latest',
      yes: true,
      access: 'public',
      ...overrides,
    };
  }

  beforeAll(() => {
    registry = new Registry();
    jest.setTimeout(30000);
  });

  afterAll(() => {
    registry.stop();
  });

  beforeEach(async () => {
    await registry.reset();
  });

  afterEach(() => {
    clearGitObservers();

    if (repositoryFactory) {
      repositoryFactory.cleanUp();
      repositoryFactory = undefined;
    }
  });

  it('can perform a successful npm publish', async () => {
    repositoryFactory = new RepositoryFactory();
    const repo = repositoryFactory.cloneRepository();

    generateChangeFiles(['foo'], repo.rootPath);

    repo.push();

    await publish(getOptions(repo));

    expect(npmShow(registry, 'foo')).toMatchObject<NpmShowResult>({
      name: 'foo',
      versions: ['1.1.0'],
      'dist-tags': { latest: '1.1.0' },
    });

    repo.updateDefaultBranch();
    const gitResults = git(['describe', '--abbrev=0'], { cwd: repo.rootPath });

    expect(gitResults.success).toBeTruthy();
    expect(gitResults.stdout).toBe('foo_v1.1.0');
  });

  it('can perform a successful npm publish in detached HEAD', async () => {
    repositoryFactory = new RepositoryFactory();
    const repo = repositoryFactory.cloneRepository();

    generateChangeFiles(['foo'], repo.rootPath);

    repo.push();

    git(['checkout', '--detach'], { cwd: repo.rootPath });

    await publish(getOptions(repo, { push: false }));

    expect(npmShow(registry, 'foo')).toMatchObject<NpmShowResult>({
      name: 'foo',
      versions: ['1.1.0'],
      'dist-tags': { latest: '1.1.0' },
    });
  });

  it('can perform a successful npm publish from a race condition', async () => {
    repositoryFactory = new RepositoryFactory();
    const repo = repositoryFactory.cloneRepository();

    generateChangeFiles(['foo'], repo.rootPath);

    repo.push();

    // Adds a step that injects a race condition
    let fetchCount = 0;

    addGitObserver((args, output) => {
      if (args[0] === 'fetch') {
        if (fetchCount === 0) {
          const anotherRepo = repositoryFactory!.cloneRepository();
          // inject a checkin
          const packageJsonFile = path.join(anotherRepo.rootPath, 'package.json');
          const contents = JSON.parse(fs.readFileSync(packageJsonFile, 'utf-8'));
          fs.writeFileSync(
            packageJsonFile,
            JSON.stringify(
              {
                ...contents,
                version: '1.0.2',
              },
              null,
              2
            )
          );

          git(['add', packageJsonFile], { cwd: anotherRepo.rootPath });
          git(['commit', '-m', 'test'], { cwd: anotherRepo.rootPath });
          anotherRepo.push();
        }

        fetchCount++;
      }
    });

    await publish(getOptions(repo));

    expect(npmShow(registry, 'foo')).toMatchObject<NpmShowResult>({
      name: 'foo',
      versions: ['1.1.0'],
      'dist-tags': { latest: '1.1.0' },
    });

    repo.updateDefaultBranch();
    const gitResults = git(['describe', '--abbrev=0'], { cwd: repo.rootPath });

    expect(gitResults.success).toBeTruthy();
    expect(gitResults.stdout).toBe('foo_v1.1.0');

    // this indicates 2 tries
    expect(fetchCount).toBe(2);
  });

  it('can perform a successful npm publish from a race condition in the dependencies', async () => {
    repositoryFactory = new RepositoryFactory();
    const repo = repositoryFactory.cloneRepository();

    generateChangeFiles(['foo'], repo.rootPath);

    repo.push();

    // Adds a step that injects a race condition
    let fetchCount = 0;

    addGitObserver((args, output) => {
      if (args[0] === 'fetch') {
        if (fetchCount === 0) {
          const anotherRepo = repositoryFactory!.cloneRepository();
          // inject a checkin
          const packageJsonFile = path.join(anotherRepo.rootPath, 'package.json');
          const contents = JSON.parse(fs.readFileSync(packageJsonFile, 'utf-8'));

          delete contents.dependencies.baz;

          fs.writeFileSync(packageJsonFile, JSON.stringify(contents, null, 2));

          git(['add', packageJsonFile], { cwd: anotherRepo.rootPath });
          git(['commit', '-m', 'test'], { cwd: anotherRepo.rootPath });
          anotherRepo.push();
        }

        fetchCount++;
      }
    });

    await publish(getOptions(repo));

    expect(npmShow(registry, 'foo')).toMatchObject<NpmShowResult>({
      name: 'foo',
      versions: ['1.1.0'],
      'dist-tags': { latest: '1.1.0' },
    });

    repo.updateDefaultBranch();
    const gitResults = git(['describe', '--abbrev=0'], { cwd: repo.rootPath });

    expect(gitResults.success).toBeTruthy();
    expect(gitResults.stdout).toBe('foo_v1.1.0');

    // this indicates 2 tries
    expect(fetchCount).toBe(2);

    const packageJsonFile = path.join(repo.rootPath, 'package.json');
    const contents = JSON.parse(fs.readFileSync(packageJsonFile, 'utf-8'));
    expect(contents.dependencies.baz).toBeUndefined();
  });

  it('can perform a successful npm publish without bump', async () => {
    repositoryFactory = new RepositoryFactory();
    const repo = repositoryFactory.cloneRepository();

    generateChangeFiles(['foo'], repo.rootPath);

    repo.push();

    await publish(getOptions(repo, { bump: false }));

    expect(npmShow(registry, 'foo')).toMatchObject<NpmShowResult>({
      name: 'foo',
      versions: ['1.0.0'],
      'dist-tags': { latest: '1.0.0' },
    });

    repo.updateDefaultBranch();

    const gitResults = git(['describe', '--abbrev=0'], { cwd: repo.rootPath });
    expect(gitResults.success).toBeFalsy();
  });

  it('should not perform npm publish on out-of-scope package', async () => {
    repositoryFactory = new MonoRepoFactory();
    const repo = repositoryFactory.cloneRepository();

    generateChangeFiles(['foo'], repo.rootPath);
    generateChangeFiles(['bar'], repo.rootPath);

    repo.push();

    await publish(getOptions(repo, { scope: ['!packages/foo'] }));

    npmShow(registry, 'foo', true /*shouldFail*/);

    const fooGitResults = git(['describe', '--abbrev=0'], { cwd: repo.rootPath });
    expect(fooGitResults.success).toBeFalsy();

    expect(npmShow(registry, 'bar')).toMatchObject<NpmShowResult>({
      name: 'bar',
      versions: ['1.4.0'],
      'dist-tags': { latest: '1.4.0' },
    });

    repo.updateDefaultBranch();
    const barGitResults = git(['describe', '--abbrev=0', 'bar_v1.4.0'], { cwd: repo.rootPath });

    expect(barGitResults.success).toBeTruthy();
    expect(barGitResults.stdout).toBe('bar_v1.4.0');
  });

  it('should respect prepublish hooks', async () => {
    repositoryFactory = new MonoRepoFactory();
    const repo = repositoryFactory.cloneRepository();

    generateChangeFiles(['foo'], repo.rootPath);

    repo.push();

    await publish(
      getOptions(repo, {
        path: repo.rootPath,
        hooks: {
          prepublish: (packagePath: string) => {
            const packageJsonPath = path.join(packagePath, 'package.json');
            const packageJson = fs.readJSONSync(packageJsonPath);
            if (packageJson.onPublish) {
              Object.assign(packageJson, packageJson.onPublish);
              delete packageJson.onPublish;
              fs.writeFileSync(packageJsonPath, JSON.stringify(packageJson, null, 2) + '\n');
            }
          },
        },
      })
    );

    // Query the information from package.json from the registry to see if it was successfully patched
    const show = npmShow(registry, 'foo')!;
    expect(show.name).toEqual('foo');
    expect(show.main).toEqual('lib/index.js');
    expect(show.hasOwnProperty('onPublish')).toBeFalsy();

    repo.updateDefaultBranch();

    // All git results should still have previous information
    const fooGitResults = git(['describe', '--abbrev=0'], { cwd: repo.rootPath });
    expect(fooGitResults.success).toBeTruthy();
    const fooPackageJson = fs.readJSONSync(path.join(repo.rootPath, 'packages/foo/package.json'));
    expect(fooPackageJson.main).toBe('src/index.ts');
    expect(fooPackageJson.onPublish.main).toBe('lib/index.js');
  });

  it('should respect postpublish hooks', async () => {
    repositoryFactory = new MonoRepoFactory();
    const repo = repositoryFactory.cloneRepository();
    let notified;

    generateChangeFiles(['foo'], repo.rootPath);

    repo.push();

    await publish(
      getOptions(repo, {
        path: repo.rootPath,
        hooks: {
          postpublish: packagePath => {
            const packageJsonPath = path.join(packagePath, 'package.json');
            const packageJson = fs.readJSONSync(packageJsonPath);
            if (packageJson.afterPublish) {
              notified = packageJson.afterPublish.notify;
            }
          },
        },
      })
    );

    const fooPackageJson = fs.readJSONSync(path.join(repo.rootPath, 'packages/foo/package.json'));
    expect(fooPackageJson.main).toBe('src/index.ts');
    expect(notified).toBe(fooPackageJson.afterPublish.notify);
  });

  it('can perform a successful npm publish without fetch', async () => {
    repositoryFactory = new RepositoryFactory();
    const repo = repositoryFactory.cloneRepository();

    generateChangeFiles(['foo'], repo.rootPath);

    repo.push();

    // Adds a step that injects a race condition
    let fetchCount = 0;

    addGitObserver((args, output) => {
      if (args[0] === 'fetch') {
        fetchCount++;
      }
    });

    await publish(getOptions(repo, { fetch: false }));

    expect(npmShow(registry, 'foo')).toMatchObject<NpmShowResult>({
      name: 'foo',
      versions: ['1.1.0'],
      'dist-tags': { latest: '1.1.0' },
    });

    // no fetch when flag set to false
    expect(fetchCount).toBe(0);
  });

  it('should specify fetch depth when depth param is defined', async () => {
    repositoryFactory = new RepositoryFactory();
    const repo = repositoryFactory.cloneRepository();

    generateChangeFiles(['foo'], repo.rootPath);

    repo.push();

    // Adds a step that injects a race condition
    let depthString: string = '';

    addGitObserver((args, output) => {
      if (args[0] === 'fetch') {
        depthString = args[3];
      }
    });

    await publish(getOptions(repo, { depth: 10 }));

    expect(npmShow(registry, 'foo')).toMatchObject<NpmShowResult>({
      name: 'foo',
      versions: ['1.1.0'],
      'dist-tags': { latest: '1.1.0' },
    });

    // no fetch when flag set to false
    expect(depthString).toEqual('--depth=10');
  });
});
