// Copyright 2025 Google LLC
//
// Licensed under the Apache License, Version 2.0 (the "License");
// you may not use this file except in compliance with the License.
// You may obtain a copy of the License at
//
//      http://www.apache.org/licenses/LICENSE-2.0
//
// Unless required by applicable law or agreed to in writing, software
// distributed under the License is distributed on an "AS IS" BASIS,
// WITHOUT WARRANTIES OR CONDITIONS OF ANY KIND, either express or implied.
// See the License for the specific language governing permissions and
// limitations under the License.

import {GitHub} from '../github';
import {CandidateReleasePullRequest, RepositoryConfig} from '../manifest';
import {Version, VersionsMap} from '../version';
import {PullRequestTitle} from '../util/pull-request-title';
import {PullRequestBody} from '../util/pull-request-body';
import {ReleasePullRequest} from '../release-pull-request';
import {BranchName} from '../util/branch-name';
import {Changelog} from '../updaters/changelog';
import {
  WorkspacePlugin,
  DependencyGraph,
  DependencyNode,
  WorkspacePluginOptions,
  appendDependenciesSectionToChangelog,
  addPath,
} from './workspace';
import {SetupCfg} from '../updaters/python/setup-cfg';
import {SetupPy} from '../updaters/python/setup-py';
import {PyProjectToml, parsePyProject, PyProject} from '../updaters/python/pyproject-toml';
import {PythonFileWithVersion} from '../updaters/python/python-file-with-version';
import {CompositeUpdater} from '../updaters/composite';
import {Logger} from '../util/logger';
import {PatchVersionUpdate} from '../versioning-strategy';

interface Package {
  path: string;
  name: string;
  // version may be unknown/null if it's dynamically generated or missing
  version: string | null;
  // contents or null if file missing
  setupCfg?: string | null;
  setupPy?: string | null;
  pyproject?: string | null;
}

export class PythonWorkspace extends WorkspacePlugin<Package> {
  private normalizedToCanonical: Map<string, string>;

  private extraVersions: Map<string, string> = new Map();

  constructor(
    github: GitHub,
    targetBranch: string,
    repositoryConfig: RepositoryConfig,
    options: WorkspacePluginOptions = {}
  ) {
    super(github, targetBranch, repositoryConfig, options);
    this.normalizedToCanonical = new Map<string, string>(); // Initialize here
  }

  protected async buildAllPackages(
    candidates: CandidateReleasePullRequest[]
  ): Promise<{allPackages: Package[]; candidatesByPackage: Record<string, CandidateReleasePullRequest>}> {
    this.logger.info('Building all packages');

    const candidatesByPath = new Map<string, CandidateReleasePullRequest>();
    for (const candidate of candidates) {
      candidatesByPath.set(candidate.path, candidate);
    }

    const candidatesByPackage: Record<string, CandidateReleasePullRequest> = {};
    const packages: Package[] = [];

    for (const path in this.repositoryConfig) {
      const config = this.repositoryConfig[path];
      if (config.releaseType !== 'python') continue;

      const candidate = candidatesByPath.get(path);

      // attempt to find cached update contents if there's an existing candidate
      let setupCfgContent: string | null = null;
      let setupPyContent: string | null = null;
      let pyprojectContent: string | null = null;

      if (candidate) {
        // look for updates that touch python metadata files
        const setupCfgUpdate = candidate.pullRequest.updates.find(u => u.path === addPath(path, 'setup.cfg'));
        if (setupCfgUpdate?.cachedFileContents) setupCfgContent = setupCfgUpdate.cachedFileContents.parsedContent;
        const setupPyUpdate = candidate.pullRequest.updates.find(u => u.path === addPath(path, 'setup.py'));
        if (setupPyUpdate?.cachedFileContents) setupPyContent = setupPyUpdate.cachedFileContents.parsedContent;
        const pyprojectUpdate = candidate.pullRequest.updates.find(u => u.path === addPath(path, 'pyproject.toml'));
        if (pyprojectUpdate?.cachedFileContents) pyprojectContent = pyprojectUpdate.cachedFileContents.parsedContent;
      }

      // if not cached, attempt to read from branch
      try {
        if (!pyprojectContent) {
          const pyproject = await this.github.getFileContentsOnBranch(addPath(path, 'pyproject.toml'), this.targetBranch);
          pyprojectContent = pyproject.parsedContent;
        }
      } catch (e) {
        this.logger.warn(`Failed to retrieve pyproject.toml from branch for path: ${path}`);
      }
      try {
        if (!setupCfgContent) {
          const setupCfg = await this.github.getFileContentsOnBranch(addPath(path, 'setup.cfg'), this.targetBranch);
          setupCfgContent = setupCfg.parsedContent;
        }
      } catch (e) {
        this.logger.warn(`Failed to retrieve setup.cfg from branch for path: ${path}`);
      }
      try {
        if (!setupPyContent) {
          const setupPy = await this.github.getFileContentsOnBranch(addPath(path, 'setup.py'), this.targetBranch);
          setupPyContent = setupPy.parsedContent;
        }
      } catch (e) {
        this.logger.warn(`Failed to retrieve setup.py from branch for path: ${path}`);
      }

      // Determine name and version. Prefer pyproject, then setup.cfg, then setup.py
      let name = path;
      let version: string | null = null;

      if (pyprojectContent) {
        try {
          const parsed = parsePyProject(pyprojectContent);
          const project = parsed.project || parsed.tool?.poetry;
          if (project?.name) name = project.name;
          if (project?.version) version = project.version;
        } catch (e) {
          this.logger.warn(`Failed to parse pyproject.toml for path: ${path}`);
        }
      }

      if ((!name || name === path) && setupPyContent) {
        const NAME_REGEX = /name\s*=\s*['\"]([^'\"]+)['\"]/m;
        const match = setupPyContent.match(NAME_REGEX as RegExp);
        if (match && match[1]) name = match[1];
      }

      // Accept common version formats including dev/rc/post (e.g. 1.0.0.dev1, 1.0.0rc1)
      // Broader version detection (PEP 440-ish): capture common version strings
      const VERSION_PATTERN = /\bversion\s*=\s*([0-9A-Za-z_.+\-]+)/i;
      if (setupCfgContent && version === null) {
        const m = setupCfgContent.match(VERSION_PATTERN);
        if (m) version = m[1];
      }
      if (setupPyContent && version === null) {
        const m = setupPyContent.match(VERSION_PATTERN);
        if (m) version = m[1];
      }

      const pkg: Package = {
        path,
        name,
        version,
        setupCfg: setupCfgContent,
        setupPy: setupPyContent,
        pyproject: pyprojectContent,
      };
      packages.push(pkg);

      this.logger.info(`Found package: ${name}, version: ${version}`);

      // if there is an associated candidate, index by normalized package name
      if (candidate) {
        candidatesByPackage[normalizePkgName(pkg.name)] = candidate;
        this.logger.debug(`Associated candidate pull request for package: ${name}`);
      }
    }

    return { allPackages: packages, candidatesByPackage };
  }

  protected bumpVersion(pkg: Package): Version {
    // Ưu tiên lấy version trong extraVersions
    const extraVer = this.extraVersions.get(normalizePkgName(pkg.name));
    if (extraVer) {
      return Version.parse(extraVer);
    }
    if (!pkg.version) {
      // If we couldn't detect a version (dynamically generated or missing),
      // fall back to a sensible initial python release version.
      return Version.parse('0.1.0');
    }
    return new PatchVersionUpdate().bump(Version.parse(pkg.version));
  }

  protected updateCandidate(
    existingCandidate: CandidateReleasePullRequest,
    pkg: Package,
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest {
    const newVersion = updatedVersions.get(normalizePkgName(pkg.name));
    if (!newVersion) throw new Error(`Didn't find updated version for ${pkg.name}`);

    existingCandidate.pullRequest.updates = existingCandidate.pullRequest.updates.map(update => {
      if (update.path === addPath(existingCandidate.path, 'setup.cfg')) {
        update.updater = new SetupCfg({version: newVersion});
      } else if (update.path === addPath(existingCandidate.path, 'setup.py')) {
        update.updater = new SetupPy({version: newVersion});
      } else if (update.path === addPath(existingCandidate.path, 'pyproject.toml')) {
        update.updater = new PyProjectToml({version: newVersion});
      } else if (update.updater instanceof Changelog) {
        // tiếp tục xử lý như cũ
      }
      return update;
    });

    // update version files like version.py
    const versionFiles = existingCandidate.pullRequest.updates
      .filter(u => u.path.endsWith('version.py') || u.path.endsWith('__init__.py'))
      .map(u => u.path);
    for (const f of versionFiles) {
      const update = existingCandidate.pullRequest.updates.find(u => u.path === f)!;
      update.updater = new CompositeUpdater(update.updater, new PythonFileWithVersion({version: newVersion}));
    }

    // build dependency notes and append to changelog updates / body
    const dependencyNotes = this.getChangelogDepsNotes(pkg, updatedVersions);
    if (dependencyNotes) {
      existingCandidate.pullRequest.updates = existingCandidate.pullRequest.updates.map(update => {
        if (update.updater instanceof Changelog) {
          update.updater.changelogEntry = appendDependenciesSectionToChangelog(update.updater.changelogEntry, dependencyNotes, this.logger);
        }
        return update;
      });

      if (existingCandidate.pullRequest.body.releaseData.length > 0) {
        existingCandidate.pullRequest.body.releaseData[0].notes = appendDependenciesSectionToChangelog(
          existingCandidate.pullRequest.body.releaseData[0].notes,
          dependencyNotes,
          this.logger
        );
      } else {
        existingCandidate.pullRequest.body.releaseData.push({
          component: pkg.name,
          version: existingCandidate.pullRequest.version,
          notes: appendDependenciesSectionToChangelog('', dependencyNotes, this.logger),
        });
      }
    }

    return existingCandidate;
  }

  protected async newCandidate(pkg: Package, updatedVersions: VersionsMap): Promise<CandidateReleasePullRequest> {
    const newVersion = updatedVersions.get(normalizePkgName(pkg.name));
    if (!newVersion) throw new Error(`Didn't find updated version for ${pkg.name}`);

    const dependencyNotes = this.getChangelogDepsNotes(pkg, updatedVersions);

    const updates: any[] = [];
    // Only create updates for files that exist in the repository/package
    if (pkg.setupCfg !== null) {
      updates.push({
        path: addPath(pkg.path, 'setup.cfg'),
        createIfMissing: false,
        updater: new SetupCfg({version: newVersion}),
      });
    }
    if (pkg.setupPy !== null) {
      updates.push({
        path: addPath(pkg.path, 'setup.py'),
        createIfMissing: false,
        updater: new SetupPy({version: newVersion}),
      });
    }
    if (pkg.pyproject !== null) {
      updates.push({
        path: addPath(pkg.path, 'pyproject.toml'),
        createIfMissing: false,
        updater: new PyProjectToml({version: newVersion}),
      });
    }

    // version files like package/__init__.py or version.py will be discovered by search
    const versionPyFiles = await this.github.findFilesByFilenameAndRef('version.py', this.targetBranch, pkg.path);
    for (const vf of versionPyFiles) {
      updates.push({
        path: addPath(pkg.path, vf),
        createIfMissing: false,
        updater: new PythonFileWithVersion({version: newVersion}),
      });
    }

    updates.push({
      path: addPath(pkg.path, 'CHANGELOG.md'),
      createIfMissing: false,
      updater: new Changelog({version: newVersion, changelogEntry: dependencyNotes}),
    });

    const pullRequest: ReleasePullRequest = {
      title: PullRequestTitle.ofTargetBranch(this.targetBranch),
      body: new PullRequestBody([
        {
          component: pkg.name,
          version: newVersion,
          notes: appendDependenciesSectionToChangelog('', dependencyNotes, this.logger),
        },
      ]),
      updates,
      labels: [],
      headRefName: BranchName.ofTargetBranch(this.targetBranch).toString(),
      version: newVersion,
      draft: false,
    };

    return {path: pkg.path, pullRequest, config: {releaseType: 'python'}};
  }

  protected postProcessCandidates(
    candidates: CandidateReleasePullRequest[],
    _updatedVersions: VersionsMap
  ): CandidateReleasePullRequest[] {
    if (candidates.length <= 1) return candidates;

    const primary = candidates[0];

    // Merge labels and updates from other candidates
    for (let i = 1; i < candidates.length; i++) {
      const candidate = candidates[i];

      // Merge labels
      for (const label of candidate.pullRequest.labels) {
        if (!primary.pullRequest.labels.includes(label)) {
          primary.pullRequest.labels.push(label);
        }
      }

      // Merge updates (avoid duplicates by path)
      for (const update of candidate.pullRequest.updates) {
        if (!primary.pullRequest.updates.some(u => u.path === update.path)) {
          primary.pullRequest.updates.push(update);
        }
      }

      // Merge draft flag: create new pullRequest with draft true if needed
      if (candidate.pullRequest.draft && !primary.pullRequest.draft) {
        primary.pullRequest = {
          ...primary.pullRequest,
          draft: true,
        };
      }

      // headRefName: keep primary as is or add custom logic here
    }

    // Merge changelog notes as existing logic handles

    return [primary, ...candidates.slice(1)];
  }

  protected async buildGraph(allPackages: Package[]): Promise<DependencyGraph<Package>> {
    const graph = new Map<string, DependencyNode<Package>>();

    // Build a normalized name -> canonical name map for workspace packages
    this.normalizedToCanonical = new Map<string, string>();
    for (const p of allPackages) {
      const normalized = normalizePkgName(p.name);
      this.normalizedToCanonical.set(normalized, p.name);
    }

    for (const pkg of allPackages) {
      const deps: string[] = [];
      if (pkg.pyproject) {
        try {
          const parsed = parsePyProject(pkg.pyproject) as PyProject & any;
          // poetry: tool.poetry.dependencies is an object mapping
          if (parsed.tool?.poetry?.dependencies) {
            for (const depName of Object.keys(parsed.tool.poetry.dependencies)) {
              const normalized = normalizePkgName(depName);
              // push normalized keys into graph (graph keys are normalized)
              if (this.normalizedToCanonical.has(normalized)) deps.push(normalized);
            }
          }
          // PEP621 project.dependencies is an array of strings
          if (parsed.project?.dependencies && Array.isArray(parsed.project.dependencies)) {
            for (const dep of parsed.project.dependencies) {
              const raw = String(dep);
              const depName = raw.split(/\s|>=|==|<=|<|>|\[/)[0];
              const normalized = normalizePkgName(depName);
              if (this.normalizedToCanonical.has(normalized)) deps.push(normalized);
            }
          }
        } catch (e) {
          // ignore parse errors
        }
      }

      // use normalized package name as graph key for consistent lookups
      const pkgKey = normalizePkgName(pkg.name);
      graph.set(pkgKey, {deps, value: pkg});
    }

    return graph;
  }

  protected buildGraphOrder(
    graph: DependencyGraph<Package>,
    packageNamesToUpdate: string[]
  ): Package[] {
    this.logger.info(
      `building graph order (forward traversal), existing package names: ${packageNamesToUpdate}`
    );
    const visited: Set<Package> = new Set();

    for (const name of packageNamesToUpdate) {
      this.visitForward(graph, name, visited, []);
    }

    return Array.from(visited).sort((a, b) =>
      this.packageNameFromPackage(a).localeCompare(this.packageNameFromPackage(b))
    );
  }

  private visitForward(
    graph: DependencyGraph<Package>,
    name: string,
    visited: Set<Package>,
    path: string[]
  ) {
    this.logger.debug(`visiting ${name}, path: ${path}`);
    if (path.indexOf(name) !== -1) {
      throw new Error(`found cycle in dependency graph: ${path.join(' -> ')} -> ${name}`);
    }
    const node = graph.get(name);
    if (!node) {
      this.logger.warn(`Didn't find node: ${name} in graph`);
      return;
    }
    const nextPath = [...path, name];
    for (const depName of node.deps) {
      this.logger.info(`visiting ${depName} next`);
      this.visitForward(graph, depName, visited, nextPath);
    }
    if (!visited.has(node.value)) {
      this.logger.debug(
        `marking ${name} as visited and adding ${this.packageNameFromPackage(node.value)} to order`
      );
      visited.add(node.value);
    }
  }

  protected inScope(candidate: CandidateReleasePullRequest): boolean {
    return candidate.config.releaseType === 'python';
  }

  protected packageNameFromPackage(pkg: Package): string {
    // return normalized package name to match graph keys and candidate indexing
    return normalizePkgName(pkg.name);
  }

  protected pathFromPackage(pkg: Package): string {
    return pkg.path;
  }

  /**
   * Generate changelog dependency notes for a package based on updated versions
   */
  protected getChangelogDepsNotes(pkg: Package, updatedVersions: VersionsMap): string {
    let notes = '';

    const depUpdates: string[] = [];

    try {
      // Parse pyproject.toml dependencies (poetry and PEP621)
      if (pkg.pyproject) {
        const parsed = parsePyProject(pkg.pyproject) as PyProject & any;
        if (parsed.tool?.poetry?.dependencies) {
          for (const depName of Object.keys(parsed.tool.poetry.dependencies)) {
            if (depName.toLowerCase() === 'python') continue;

            const normalized = normalizePkgName(depName);
            if (!this.normalizedToCanonical.has(normalized)) continue;

            const newVersion = updatedVersions.get(normalized);
            if (newVersion) {
              const canonical = this.normalizedToCanonical.get(normalized) || depName;
              depUpdates.push(`* ${canonical} bumped to ${newVersion}`);
            }
          }
        }
        if (parsed.project?.dependencies && Array.isArray(parsed.project.dependencies)) {
          for (const dep of parsed.project.dependencies) {
            const raw = String(dep);
            const depName = raw.split(/\s|>=|==|<=|<|>|\[/)[0];
            const normalized = normalizePkgName(depName);
            if (!this.normalizedToCanonical.has(normalized)) continue;

            const newVersion = updatedVersions.get(normalized);
            if (newVersion) {
              const canonical = this.normalizedToCanonical.get(normalized) || depName;
              depUpdates.push(`* ${canonical} bumped to ${newVersion}`);
            }
          }
        }
      }

      // Parse setup.cfg dependencies from [options] install_requires
      if (pkg.setupCfg) {
        // Simple parse of install_requires section
        // Matches lines under [options] section with install_requires =
        const installRequiresMatch = pkg.setupCfg.match(/\[options\]([\s\S]*?)(\n\[|$)/m);
        if (installRequiresMatch) {
          const optionsSection = installRequiresMatch[1];
          const lines = optionsSection.split(/\r?\n/);
          let inInstallRequires = false;
          for (const line of lines) {
            const trimmed = line.trim();
            if (trimmed.startsWith('install_requires')) {
              const parts = trimmed.split('=');
              if (parts.length >= 2) {
                const deps = parts[1].split(',').map(s => s.trim()).filter(Boolean);
                for (const depNameRaw of deps) {
                  const depName = depNameRaw.split(/[\s;>=<\[]/)[0];
                  const normalized = normalizePkgName(depName);
                  if (!this.normalizedToCanonical.has(normalized)) continue;
                  const newVersion = updatedVersions.get(normalized);
                  if (newVersion) {
                    const canonical = this.normalizedToCanonical.get(normalized) || depName;
                    depUpdates.push(`* ${canonical} bumped to ${newVersion}`);
                  }
                }
              }
              inInstallRequires = true;
            } else if (inInstallRequires && (trimmed === '' || /^\S/.test(trimmed))) {
              // End of install_requires multiline list on blank line or new section start
              inInstallRequires = false;
            } else if (inInstallRequires && trimmed) {
              const depName = trimmed.split(/[\s;>=<\[]/)[0];
              const normalized = normalizePkgName(depName);
              if (!this.normalizedToCanonical.has(normalized)) continue;
              const newVersion = updatedVersions.get(normalized);
              if (newVersion) {
                const canonical = this.normalizedToCanonical.get(normalized) || depName;
                depUpdates.push(`* ${canonical} bumped to ${newVersion}`);
              }
            }
          }
        }
      }

      // Parse setup.py install_requires with regex
      if (pkg.setupPy) {
        const installReqMatch = pkg.setupPy.match(/install_requires\s*=\s*\[([\s\S]*?)\]/m);
        if (installReqMatch) {
          const requiresList = installReqMatch[1];
          const depNames = requiresList.match(/['"]([^'"]+)['"]/g) || [];
          for (const depRaw of depNames) {
            const depName = depRaw.replace(/['"]/g, '').split(/[\s;>=<\[]/)[0];
            const normalized = normalizePkgName(depName);
            if (!this.normalizedToCanonical.has(normalized)) continue;
            const newVersion = updatedVersions.get(normalized);
            if (newVersion) {
              const canonical = this.normalizedToCanonical.get(normalized) || depName;
              depUpdates.push(`* ${canonical} bumped to ${newVersion}`);
            }
          }
        }
      }
    } catch {
      // Ignore parse errors
    }

    if (depUpdates.length > 0) {
      notes = `* The following workspace dependencies were updated:\n${depUpdates.join('\n')}`;
    }

    return notes;
  }
}

/**
 * Normalize package/dependency names for comparison:
 * - strip extras (foo[bar])
 * - strip markers (foo; python_version<"3.8")
 * - lower-case
 * - normalize hyphens/underscores to a single form
 */
function normalizePkgName(name: string): string {
  if (!name) return name;
  const beforeMarker = name.split(';')[0];
  const beforeExtras = beforeMarker.split('[')[0];
  return beforeExtras.trim().toLowerCase().replace(/[_]+/g, '-');
}
