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
import {logger as defaultLogger, Logger} from '../util/logger';
import {PatchVersionUpdate} from '../versioning-strategy';

interface Package {
  path: string;
  name: string; // canonical display name
  version: string | null;
  setupCfg?: string | null;
  setupPy?: string | null;
  pyproject?: string | null;
}

interface EnhancedPyProject extends PyProject {
  tool?: {
    poetry?: any;
    releasePlease?: {
      extraVersions?: Record<string, string>;
    };
  };
}

/**
 * Text-based updater that edits or creates the [tool.release-please.extra-versions]
 * section inside a pyproject.toml file.
 *
 * It exposes updateContent(old?: string): string to match updater contract.
 */
class PyProjectExtraVersionsUpdater {
  private extraVersions: Record<string, string>;
  constructor(options: {extraVersions: Record<string, string>}) {
    this.extraVersions = options?.extraVersions || {};
  }

  updateContent(oldContent?: string): string {
    let content = oldContent || '';

    const headerRe = /^\s*\[tool\.release-please\.extra-versions\]\s*$/m;
    if (headerRe.test(content)) {
      // Find section start
      const start = content.search(headerRe);
      if (start === -1) return this.appendNewSection(content);

      // Find end of section (next top-level [section] or EOF)
      const after = content.slice(start);
      const nextTableRe = /^\s*\[.+\]/m;
      const m = nextTableRe.exec(after.slice(1)); // skip header line first char
      let endIndex: number;
      if (m && m.index >= 0) {
        endIndex = start + 1 + m.index;
      } else {
        endIndex = content.length;
      }

      const before = content.slice(0, start);
      const section = content.slice(start, endIndex);
      const afterSection = content.slice(endIndex);

      // Parse existing entries
      const lines = section.split(/\r?\n/);
      const existing: Record<string, string> = {};
      for (const line of lines) {
        const trimmed = line.trim();
        if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
        const eq = line.indexOf('=');
        if (eq === -1) continue;
        const key = line.slice(0, eq).trim();
        const valRaw = line.slice(eq + 1).trim();
        const val = valRaw.replace(/^['"]|['"]$/g, '');
        existing[key] = val;
      }

      const merged = {...existing};
      for (const k of Object.keys(this.extraVersions)) merged[k] = this.extraVersions[k];

      const headerLine = '[tool.release-please.extra-versions]';
      const entryLines = Object.keys(merged).sort().map(k => `${k} = "${merged[k]}"`);
      const newSection = [headerLine, ...entryLines].join('\n') + '\n';

      return before + newSection + afterSection;
    } else {
      return this.appendNewSection(content);
    }
  }

  private appendNewSection(content: string): string {
    const headerLine = '\n[tool.release-please.extra-versions]\n';
    const entryLines = Object.keys(this.extraVersions).sort().map(k => `${k} = "${this.extraVersions[k]}"`);
    return content + headerLine + entryLines.join('\n') + '\n';
  }
}

export class PythonWorkspace extends WorkspacePlugin<Package> {
  private normalizedToCanonical: Map<string, string> = new Map();
  private extraVersions: Map<string, string> = new Map();

  constructor(
    github: GitHub,
    targetBranch: string,
    repositoryConfig: RepositoryConfig,
    options: WorkspacePluginOptions = {}
  ) {
    super(github, targetBranch, repositoryConfig, options);
  }

  protected async buildAllPackages(
    candidates: CandidateReleasePullRequest[]
  ): Promise<{allPackages: Package[]; candidatesByPackage: Record<string, CandidateReleasePullRequest>}> {
    this.logger.info('Building all packages');

    const candidatesByPath = new Map<string, CandidateReleasePullRequest>();
    for (const c of candidates) candidatesByPath.set(c.path, c);

    const candidatesByPackage: Record<string, CandidateReleasePullRequest> = {};
    const packages: Package[] = [];

    for (const path in this.repositoryConfig) {
      const cfg = this.repositoryConfig[path];
      if (cfg.releaseType !== 'python') continue;

      const candidate = candidatesByPath.get(path);

      let setupCfgContent: string | null = null;
      let setupPyContent: string | null = null;
      let pyprojectContent: string | null = null;

      if (candidate) {
        const uCfg = candidate.pullRequest.updates.find(u => u.path === addPath(path, 'setup.cfg'));
        if (uCfg?.cachedFileContents) setupCfgContent = uCfg.cachedFileContents.parsedContent;
        const uPy = candidate.pullRequest.updates.find(u => u.path === addPath(path, 'setup.py'));
        if (uPy?.cachedFileContents) setupPyContent = uPy.cachedFileContents.parsedContent;
        const uProj = candidate.pullRequest.updates.find(u => u.path === addPath(path, 'pyproject.toml'));
        if (uProj?.cachedFileContents) pyprojectContent = uProj.cachedFileContents.parsedContent;
      }

      try {
        if (!pyprojectContent) {
          const f = await this.github.getFileContentsOnBranch(addPath(path, 'pyproject.toml'), this.targetBranch);
          pyprojectContent = f.parsedContent;
        }
      } catch {
        /* ignore */
      }
      try {
        if (!setupCfgContent) {
          const f = await this.github.getFileContentsOnBranch(addPath(path, 'setup.cfg'), this.targetBranch);
          setupCfgContent = f.parsedContent;
        }
      } catch {
        /* ignore */
      }
      try {
        if (!setupPyContent) {
          const f = await this.github.getFileContentsOnBranch(addPath(path, 'setup.py'), this.targetBranch);
          setupPyContent = f.parsedContent;
        }
      } catch {
        /* ignore */
      }

      let name = path;
      let version: string | null = null;

      if (pyprojectContent) {
        try {
          const parsed = parsePyProject(pyprojectContent) as EnhancedPyProject;
          const project = parsed.project || parsed.tool?.poetry;
          if (project?.name) name = project.name;
          if (project?.version) version = project.version;
          if (parsed.tool?.releasePlease?.extraVersions) {
            for (const [pkgName, pkgVer] of Object.entries(parsed.tool.releasePlease.extraVersions)) {
              this.extraVersions.set(normalizePkgName(pkgName), String(pkgVer));
            }
          }
        } catch {
          this.logger.debug(`Failed to parse pyproject.toml for ${path}`);
        }
      }

      if ((!name || name === path) && setupPyContent) {
        const m = setupPyContent.match(/name\s*=\s*['"]([^'"]+)['"]/m);
        if (m && m[1]) name = m[1];
      }

      const VERSION_PATTERN = /\bversion\s*=\s*([0-9A-Za-z_.+\-]+)/i;
      if (setupCfgContent && version === null) {
        const m = setupCfgContent.match(VERSION_PATTERN);
        if (m) version = m[1];
      }
      if (setupPyContent && version === null) {
        const m = setupPyContent.match(VERSION_PATTERN);
        if (m) version = m[1];
      }

      const pkg: Package = {path, name, version, setupCfg: setupCfgContent, setupPy: setupPyContent, pyproject: pyprojectContent};
      packages.push(pkg);

      if (candidate) {
        candidatesByPackage[normalizePkgName(pkg.name)] = candidate;
        this.logger.debug(`associated candidate for ${pkg.name}`);
      }
    }

    // build normalized -> canonical map
    this.normalizedToCanonical = new Map();
    for (const p of packages) this.normalizedToCanonical.set(normalizePkgName(p.name), p.name);

    return {allPackages: packages, candidatesByPackage};
  }

  protected bumpVersion(pkg: Package): Version {
    const norm = normalizePkgName(pkg.name);
    const extra = this.extraVersions.get(norm);
    if (extra) {
      return Version.parse(extra);
    }
    if (!pkg.version) {
      this.logger.info(`No static version for ${pkg.name}; falling back to 0.1.0`);
      return Version.parse('0.1.0');
    }
    return new PatchVersionUpdate().bump(Version.parse(pkg.version));
  }

  protected updateCandidate(
    existingCandidate: CandidateReleasePullRequest,
    pkg: Package,
    updatedVersions: VersionsMap
  ): CandidateReleasePullRequest {
    const normalizedUpdated = new Map<string, Version>();
    updatedVersions.forEach((v, k) => normalizedUpdated.set(normalizePkgName(String(k)), v as Version));

    const normName = normalizePkgName(pkg.name);
    const newVersion = normalizedUpdated.get(normName);
    if (!newVersion) throw new Error(`Didn't find updated version for ${pkg.name}`);

    existingCandidate.pullRequest.updates = existingCandidate.pullRequest.updates.map(update => {
      if (update.path === addPath(existingCandidate.path, 'setup.cfg')) {
        update.updater = new CompositeUpdater(update.updater, new SetupCfg({version: newVersion}));
      } else if (update.path === addPath(existingCandidate.path, 'setup.py')) {
        update.updater = new CompositeUpdater(update.updater, new SetupPy({version: newVersion}));
      } else if (update.path === addPath(existingCandidate.path, 'pyproject.toml')) {
        // compose updater to also write extra-versions when applicable
        const extraToWrite: Record<string, string> = {};
        normalizedUpdated.forEach((v, k) => {
          const canonical = this.normalizedToCanonical.get(k) || k;
          extraToWrite[canonical] = String(v);
        });
        if (Object.keys(extraToWrite).length > 0) {
          // CompositeUpdater accepts multiple updaters (implementation-specific); if not, adapt to your CompositeUpdater API.
          update.updater = new CompositeUpdater(update.updater, new PyProjectToml({version: newVersion}), new (PyProjectExtraVersionsUpdater as any)({extraVersions: extraToWrite}) as any);
        } else {
          update.updater = new CompositeUpdater(update.updater, new PyProjectToml({version: newVersion}));
        }
      }
      return update;
    });

    const versionFiles = existingCandidate.pullRequest.updates
      .filter(u => u.path.endsWith('version.py') || u.path.endsWith('__init__.py'))
      .map(u => u.path);
    for (const f of versionFiles) {
      const update = existingCandidate.pullRequest.updates.find(u => u.path === f)!;
      update.updater = new CompositeUpdater(update.updater, new PythonFileWithVersion({version: newVersion}));
    }

    const dependencyNotes = this.getChangelogDepsNotes(pkg, normalizedUpdated);
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
          component: this.normalizedToCanonical.get(normName) || pkg.name,
          version: newVersion,
          notes: appendDependenciesSectionToChangelog('', dependencyNotes, this.logger),
        });
      }
    }

    return existingCandidate;
  }

  protected async newCandidate(pkg: Package, updatedVersions: VersionsMap): Promise<CandidateReleasePullRequest> {
    const normalizedUpdated = new Map<string, Version>();
    updatedVersions.forEach((v, k) => normalizedUpdated.set(normalizePkgName(String(k)), v as Version));

    const normName = normalizePkgName(pkg.name);
    const newVersion = normalizedUpdated.get(normName);
    if (!newVersion) throw new Error(`Didn't find updated version for ${pkg.name}`);

    const dependencyNotes = this.getChangelogDepsNotes(pkg, normalizedUpdated);

    const updates: any[] = [];
    if (pkg.setupCfg !== null) {
      updates.push({path: addPath(pkg.path, 'setup.cfg'), createIfMissing: false, updater: new SetupCfg({version: newVersion})});
    }
    if (pkg.setupPy !== null) {
      updates.push({path: addPath(pkg.path, 'setup.py'), createIfMissing: false, updater: new SetupPy({version: newVersion})});
    }
    if (pkg.pyproject !== null) {
      updates.push({path: addPath(pkg.path, 'pyproject.toml'), createIfMissing: false, updater: new PyProjectToml({version: newVersion})});
    }

    const versionPyFiles = await this.github.findFilesByFilenameAndRef('version.py', this.targetBranch, pkg.path);
    for (const vf of versionPyFiles) {
      updates.push({path: addPath(pkg.path, vf), createIfMissing: false, updater: new PythonFileWithVersion({version: newVersion})});
    }

    try {
      await this.github.getFileContentsOnBranch(addPath(pkg.path, 'CHANGELOG.md'), this.targetBranch);
      updates.push({path: addPath(pkg.path, 'CHANGELOG.md'), createIfMissing: false, updater: new Changelog({version: newVersion, changelogEntry: dependencyNotes})});
    } catch {
      /* no changelog; skip */
    }

    const canonical = this.normalizedToCanonical.get(normName) || pkg.name;
    const pullRequest: ReleasePullRequest = {
      title: PullRequestTitle.ofTargetBranch(this.targetBranch),
      body: new PullRequestBody([
        {component: canonical, version: newVersion, notes: appendDependenciesSectionToChangelog('', dependencyNotes, this.logger)},
      ]),
      updates,
      labels: [],
      headRefName: BranchName.ofTargetBranch(this.targetBranch).toString(),
      version: newVersion,
      draft: false,
    };

    return {path: pkg.path, pullRequest, config: {releaseType: 'python'}};
  }

  protected postProcessCandidates(candidates: CandidateReleasePullRequest[], _updatedVersions: VersionsMap): CandidateReleasePullRequest[] {
    if (candidates.length <= 1) return candidates;

    const primary = candidates[0];

    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i];

      for (const l of c.pullRequest.labels) {
        if (!primary.pullRequest.labels.includes(l)) primary.pullRequest.labels.push(l);
      }

      for (const u of c.pullRequest.updates) {
        const existing = primary.pullRequest.updates.find(x => x.path === u.path);
        if (!existing) {
          primary.pullRequest.updates.push(u);
        } else if (existing.updater instanceof Changelog && u.updater instanceof Changelog) {
          existing.updater.changelogEntry = appendDependenciesSectionToChangelog(existing.updater.changelogEntry, u.updater.changelogEntry, this.logger);
        }
      }

      if (c.pullRequest.draft && !primary.pullRequest.draft) {
        primary.pullRequest = {...primary.pullRequest, draft: true};
      }

      for (const rd of c.pullRequest.body.releaseData) {
        const exists = primary.pullRequest.body.releaseData.some(p => p.component === rd.component && String(p.version) === String(rd.version));
        if (!exists) primary.pullRequest.body.releaseData.push(rd);
      }
    }

    // aggregate extra notes and append
    const extraNotes: string[] = [];
    for (let i = 1; i < candidates.length; i++) {
      for (const rd of candidates[i].pullRequest.body.releaseData) {
        if (rd?.notes) extraNotes.push(rd.notes);
      }
    }
    if (extraNotes.length > 0) {
      const combined = extraNotes.join('\n\n');
      primary.pullRequest.updates = primary.pullRequest.updates.map(update => {
        if (update.updater instanceof Changelog) {
          update.updater.changelogEntry = appendDependenciesSectionToChangelog(update.updater.changelogEntry, combined, this.logger);
        }
        return update;
      });
      if (primary.pullRequest.body.releaseData.length > 0) {
        primary.pullRequest.body.releaseData[0].notes = appendDependenciesSectionToChangelog(primary.pullRequest.body.releaseData[0].notes, combined, this.logger);
      } else {
        primary.pullRequest.body.releaseData.push({component: primary.path, version: primary.pullRequest.version, notes: appendDependenciesSectionToChangelog('', combined, this.logger)});
      }
    }

    // If there are version entries in primary.releaseData, ensure pyproject extra-versions updaters exist
    const normalizedUpdated = new Map<string, Version>();
    for (const rd of primary.pullRequest.body.releaseData) {
      if (rd.component && rd.version) normalizedUpdated.set(normalizePkgName(String(rd.component)), rd.version as Version);
    }
    if (normalizedUpdated.size > 0) {
      const extraToWrite: Record<string, string> = {};
      normalizedUpdated.forEach((v, k) => {
        const canonical = this.normalizedToCanonical.get(k) || k;
        extraToWrite[canonical] = String(v);
      });
      primary.pullRequest.updates = primary.pullRequest.updates.map(update => {
        if (update.path.endsWith('pyproject.toml')) {
          update.updater = new CompositeUpdater(update.updater, new (PyProjectExtraVersionsUpdater as any)({extraVersions: extraToWrite}) as any);
        }
        return update;
      });
    }

    return [primary];
  }

  protected async buildGraph(allPackages: Package[]): Promise<DependencyGraph<Package>> {
    const graph = new Map<string, DependencyNode<Package>>();

    this.normalizedToCanonical = new Map();
    for (const p of allPackages) this.normalizedToCanonical.set(normalizePkgName(p.name), p.name);

    for (const pkg of allPackages) {
      const deps: string[] = [];
      if (pkg.pyproject) {
        try {
          const parsed = parsePyProject(pkg.pyproject) as PyProject & any;
          if (parsed.tool?.poetry?.dependencies) {
            for (const depName of Object.keys(parsed.tool.poetry.dependencies)) {
              const normalized = normalizePkgName(depName);
              if (this.normalizedToCanonical.has(normalized)) deps.push(normalized);
            }
          }
          if (parsed.project?.dependencies && Array.isArray(parsed.project.dependencies)) {
            for (const dep of parsed.project.dependencies) {
              const raw = String(dep);
              const depName = raw.split(/\s|>=|==|<=|<|>|\[/)[0];
              const normalized = normalizePkgName(depName);
              if (this.normalizedToCanonical.has(normalized)) deps.push(normalized);
            }
          }
        } catch {
          // ignore
        }
      }
      const pkgKey = normalizePkgName(pkg.name);
      graph.set(pkgKey, {deps, value: pkg});
    }

    return graph;
  }

  protected buildGraphOrder(graph: DependencyGraph<Package>, packageNamesToUpdate: string[]): Package[] {
    this.logger.info(`building graph order (forward traversal), packageNamesToUpdate: ${packageNamesToUpdate}`);
    const visited: Set<Package> = new Set();

    const normalizedNames = packageNamesToUpdate.map(n => normalizePkgName(n));
    for (const name of normalizedNames) this.visitForward(graph, name, visited, []);

    return Array.from(visited).sort((a, b) => this.packageNameFromPackage(a).localeCompare(this.packageNameFromPackage(b)));
  }

  private visitForward(graph: DependencyGraph<Package>, name: string, visited: Set<Package>, path: string[]) {
    this.logger.debug(`visiting ${name}, path: ${path.join(' -> ')}`);
    if (path.indexOf(name) !== -1) throw new Error(`found cycle in dependency graph: ${[...path, name].join(' -> ')}`);
    const node = graph.get(name);
    if (!node) {
      this.logger.warn(`Didn't find node: ${name} in graph`);
      return;
    }
    const nextPath = [...path, name];
    for (const depName of node.deps) this.visitForward(graph, depName, visited, nextPath);
    if (!visited.has(node.value)) visited.add(node.value);
  }

  protected inScope(candidate: CandidateReleasePullRequest): boolean {
    return candidate.config.releaseType === 'python';
  }

  protected packageNameFromPackage(pkg: Package): string {
    return normalizePkgName(pkg.name);
  }

  protected pathFromPackage(pkg: Package): string {
    return pkg.path;
  }

  protected getChangelogDepsNotes(pkg: Package, normalizedUpdated: Map<string, Version>): string {
    const depUpdates: string[] = [];

    try {
      if (pkg.pyproject) {
        const parsed = parsePyProject(pkg.pyproject) as PyProject & any;
        if (parsed.tool?.poetry?.dependencies) {
          for (const depName of Object.keys(parsed.tool.poetry.dependencies)) {
            if (depName.toLowerCase() === 'python') continue;
            const normalized = normalizePkgName(depName);
            if (!this.normalizedToCanonical.has(normalized)) continue;
            const newV = normalizedUpdated.get(normalized);
            if (newV) depUpdates.push(`* ${this.normalizedToCanonical.get(normalized) || depName} bumped to ${String(newV)}`);
          }
        }
        if (parsed.project?.dependencies && Array.isArray(parsed.project.dependencies)) {
          for (const dep of parsed.project.dependencies) {
            const raw = String(dep);
            const depName = raw.split(/\s|>=|==|<=|<|>|\[/)[0];
            const normalized = normalizePkgName(depName);
            if (!this.normalizedToCanonical.has(normalized)) continue;
            const newV = normalizedUpdated.get(normalized);
            if (newV) depUpdates.push(`* ${this.normalizedToCanonical.get(normalized) || depName} bumped to ${String(newV)}`);
          }
        }
      }

      if (pkg.setupCfg) {
        const match = pkg.setupCfg.match(/\[options\]([\s\S]*?)(\n\[|$)/m);
        if (match) {
          const section = match[1];
          const lines = section.split(/\r?\n/);
          let inInstallRequires = false;
          for (const line of lines) {
            const t = line.trim();
            if (t.startsWith('install_requires')) {
              const parts = t.split('=');
              if (parts.length >= 2) {
                const deps = parts[1].split(',').map(s => s.trim()).filter(Boolean);
                for (const d of deps) {
                  const depName = d.split(/[\s;>=<\[]/)[0];
                  const normalized = normalizePkgName(depName);
                  if (!this.normalizedToCanonical.has(normalized)) continue;
                  const newV = normalizedUpdated.get(normalized);
                  if (newV) depUpdates.push(`* ${this.normalizedToCanonical.get(normalized) || depName} bumped to ${String(newV)}`);
                }
              }
              inInstallRequires = true;
            } else if (inInstallRequires && (t === '' || /^\S/.test(t))) {
              inInstallRequires = false;
            } else if (inInstallRequires && t) {
              const depName = t.split(/[\s;>=<\[]/)[0];
              const normalized = normalizePkgName(depName);
              if (!this.normalizedToCanonical.has(normalized)) continue;
              const newV = normalizedUpdated.get(normalized);
              if (newV) depUpdates.push(`* ${this.normalizedToCanonical.get(normalized) || depName} bumped to ${String(newV)}`);
            }
          }
        }
      }

      if (pkg.setupPy) {
        const m = pkg.setupPy.match(/install_requires\s*=\s*\[([\s\S]*?)\]/m);
        if (m) {
          const list = m[1];
          const depNames = list.match(/['"]([^'"]+)['"]/g) || [];
          for (const raw of depNames) {
            const dep = raw.replace(/['"]/g, '').split(/[\s;>=<\[]/)[0];
            const normalized = normalizePkgName(dep);
            if (!this.normalizedToCanonical.has(normalized)) continue;
            const newV = normalizedUpdated.get(normalized);
            if (newV) depUpdates.push(`* ${this.normalizedToCanonical.get(normalized) || dep} bumped to ${String(newV)}`);
          }
        }
      }
    } catch (e) {
      this.logger.debug('getChangelogDepsNotes parse error', (e as Error).message);
    }

    if (depUpdates.length === 0) return '';
    return `* The following workspace dependencies were updated:\n${depUpdates.join('\n')}`;
  }
}

/**
 * Normalize package/dependency names for comparison:
 * - strip extras (foo[bar])
 * - strip markers (foo; python_version<"3.8")
 * - lower-case
 * - normalize underscores to hyphens
 */
function normalizePkgName(name: string): string {
  if (!name) return name;
  const beforeMarker = name.split(';')[0];
  const beforeExtras = beforeMarker.split('[')[0];
  return beforeExtras.trim().toLowerCase().replace(/_+/g, '-');
}
