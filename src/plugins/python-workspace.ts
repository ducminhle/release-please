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

function wrapUpdater(u: any): {updateContent(old?: string): string} {
  if (!u) {
    return {updateContent: (old?: string) => old || ''};
  }
  if (typeof u.updateContent === 'function') return u;
  if (typeof u.update === 'function') {
    return {updateContent: (old?: string) => u.update(old)};
  }
  if (typeof u.apply === 'function') {
    return {updateContent: (old?: string) => u.apply(old)};
  }
  if (typeof u.transform === 'function') {
    return {updateContent: (old?: string) => u.transform(old)};
  }
  return {
    updateContent: (old?: string) => {
      if (typeof u === 'string') return u;
      if (u && typeof u.toString === 'function') return u.toString();
      return old || '';
    },
  };
}

class PyProjectExtraVersionsUpdater {
  private extraVersions: Record<string, string>;
  constructor(options: {extraVersions: Record<string, string>}) {
    this.extraVersions = options?.extraVersions || {};
  }

  updateContent(oldContent?: string): string {
    const content = oldContent || '';

    // detect canonical section exactly (safe) and merge
    const headerRe = /^\s*\[tool\.release-please\.extra-versions\]\s*$/m;
    if (headerRe.test(content)) {
      const start = content.search(headerRe);
      if (start === -1) return this.appendNewSection(content);

      const after = content.slice(start);
      const nextTableRe = /^\s*\[.+\]/m;
      const m = nextTableRe.exec(after.slice(1));
      let endIndex: number;
      if (m && m.index >= 0) {
        endIndex = start + 1 + m.index;
      } else {
        endIndex = content.length;
      }

      const before = content.slice(0, start);
      const section = content.slice(start, endIndex);
      const afterSection = content.slice(endIndex);

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
  private pyprojectPaths: Set<string> = new Set();
  private pyprojectContents: Map<string, string> = new Map();

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

    // collect all pyproject.toml files in repo (under targetBranch)
    try {
      const allPyproj = await this.github.findFilesByFilenameAndRef('pyproject.toml', this.targetBranch);
      for (const p of allPyproj) {
        const pPath = typeof p === 'string' ? p : (p as any).path;
        if (!pPath) continue;
        this.pyprojectPaths.add(pPath);
        try {
          const f = await this.github.getFileContentsOnBranch(pPath, this.targetBranch);
          if (f && typeof f.parsedContent === 'string') {
            this.pyprojectContents.set(pPath, f.parsedContent);
          }
        } catch {
          // ignore read errors for individual pyproject files
        }
      }
      this.logger.info(`found pyproject paths: ${Array.from(this.pyprojectPaths).join(', ')}`);
      this.logger.info(`pyprojectContents keys: ${Array.from(this.pyprojectContents.keys()).join(', ')}`);
    } catch (e) {
      this.logger.debug('scan pyproject.toml failed', (e as Error).message);
    }

    // Try to detect repo-root pyproject.toml once and add to pyprojectPaths if present
    try {
      const rootProj = await this.github.getFileContentsOnBranch('pyproject.toml', this.targetBranch);
      if (rootProj && rootProj.parsedContent !== undefined) {
        this.pyprojectPaths.add('pyproject.toml');
        if (typeof rootProj.parsedContent === 'string') this.pyprojectContents.set('pyproject.toml', rootProj.parsedContent);
      }
    } catch {
      // no root pyproject
    }

    for (const path in this.repositoryConfig) {
      const cfg = this.repositoryConfig[path];
      if (cfg.releaseType !== 'python') continue;

      const candidate = candidatesByPath.get(path);

      let setupCfgContent: string | null = null;
      let setupPyContent: string | null = null;
      let pyprojectContent: string | null = null;
      const pyprojectRelPath = addPath(path, 'pyproject.toml');

      if (candidate) {
        const uCfg = candidate.pullRequest.updates.find(u => u.path === addPath(path, 'setup.cfg'));
        if (uCfg?.cachedFileContents) setupCfgContent = uCfg.cachedFileContents.parsedContent;
        const uPy = candidate.pullRequest.updates.find(u => u.path === addPath(path, 'setup.py'));
        if (uPy?.cachedFileContents) setupPyContent = uPy.cachedFileContents.parsedContent;
        const uProj = candidate.pullRequest.updates.find(u => u.path === pyprojectRelPath);
        if (uProj?.cachedFileContents) pyprojectContent = uProj.cachedFileContents.parsedContent;
      }

      try {
        if (!pyprojectContent) {
          const f = await this.github.getFileContentsOnBranch(pyprojectRelPath, this.targetBranch);
          pyprojectContent = f.parsedContent;
        }
        if (pyprojectContent !== null && pyprojectContent !== undefined) {
          this.pyprojectPaths.add(pyprojectRelPath);
          if (typeof pyprojectContent === 'string') this.pyprojectContents.set(pyprojectRelPath, pyprojectContent);
        }
      } catch {
        /* ignore missing per-package pyproject */
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

      const pkg: Package = {
        path,
        name,
        version,
        setupCfg: setupCfgContent,
        setupPy: setupPyContent,
        pyproject: pyprojectContent,
      };
      packages.push(pkg);

      if (candidate) {
        candidatesByPackage[normalizePkgName(pkg.name)] = candidate;
        this.logger.debug(`associated candidate for ${pkg.name}`);
      }
    }

    // build normalized -> canonical map
    this.normalizedToCanonical = new Map();
    for (const p of packages) this.normalizedToCanonical.set(normalizePkgName(p.name), p.name);

    this.logger.info(`normalizedToCanonical keys: ${Array.from(this.normalizedToCanonical.keys()).join(', ')}`);

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
        update.updater = new CompositeUpdater(wrapUpdater(update.updater) as any, wrapUpdater(new SetupCfg({version: newVersion})) as any) as any;
      } else if (update.path === addPath(existingCandidate.path, 'setup.py')) {
        update.updater = new CompositeUpdater(wrapUpdater(update.updater) as any, wrapUpdater(new SetupPy({version: newVersion})) as any) as any;
      } else if (update.path === addPath(existingCandidate.path, 'pyproject.toml')) {
        const extraToWrite: Record<string, string> = {};
        normalizedUpdated.forEach((v, k) => {
          const canonical = this.normalizedToCanonical.get(k) || k;
          extraToWrite[canonical] = String(v);
        });
        const base = wrapUpdater(update.updater);
        const pyprojUpd = wrapUpdater(new PyProjectToml({version: newVersion}));
        if (Object.keys(extraToWrite).length > 0) {
          const extraUpd = wrapUpdater(new PyProjectExtraVersionsUpdater({extraVersions: extraToWrite}));
          update.updater = new CompositeUpdater(new CompositeUpdater(base as any, pyprojUpd as any) as any, extraUpd as any) as any;
        } else {
          update.updater = new CompositeUpdater(base as any, pyprojUpd as any) as any;
        }
      }
      return update;
    });

    const versionFiles = existingCandidate.pullRequest.updates
      .filter(u => u.path.endsWith('version.py') || u.path.endsWith('__init__.py'))
      .map(u => u.path);
    for (const f of versionFiles) {
      const update = existingCandidate.pullRequest.updates.find(u => u.path === f)!;
      update.updater = new CompositeUpdater(wrapUpdater(update.updater) as any, wrapUpdater(new PythonFileWithVersion({version: newVersion})) as any) as any;
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

    const normalizedUpdated = new Map<string, Version>();
    for (const rd of primary.pullRequest.body.releaseData) {
      if (rd.component && rd.version) normalizedUpdated.set(normalizePkgName(String(rd.component)), rd.version as Version);
    }

    if (normalizedUpdated.size === 0) {
      this.logger.info('normalizedUpdated is empty; no extra-versions to write.');
      return [primary];
    }

    const extraToWrite: Record<string, string> = {};
    normalizedUpdated.forEach((v, k) => {
      const canonical = this.normalizedToCanonical.get(k) || k;
      extraToWrite[canonical] = String(v);
    });

    this.logger.info(`extraToWrite keys: ${Object.keys(extraToWrite).join(', ')}`);
    this.logger.info(`pyprojectPaths discovered: ${Array.from(this.pyprojectPaths).join(', ')}`);

    const keysToWrite = Object.keys(extraToWrite);
    const normalizedTargets = new Set<string>();
    keysToWrite.forEach(k => normalizedTargets.add(normalizePkgName(k)));

    for (const projPath of Array.from(this.pyprojectPaths)) {
      const content = this.pyprojectContents.get(projPath) || '';
      this.logger.info(`Checking ${projPath} for relevant package declarations or central section`);
      this.logger.debug(`Content head for ${projPath}:\n${content.split(/\n/).slice(0, 80).join('\n')}`);

      let shouldAdd = false;
      const matchedKeys: string[] = [];

      // Simple, robust detection of central section by lowercased substring checks.
      const lc = content.toLowerCase();
      const hasCanonicalSection = lc.indexOf('[tool.release-please.extra-versions]') !== -1;
      const hasCommonVariant1 = lc.indexOf('[tool.release-extras-versions]') !== -1;
      const hasCommonVariant2 = lc.indexOf('[tool.release_extras_versions]') !== -1;
      const hasSection = hasCanonicalSection || hasCommonVariant1 || hasCommonVariant2;

      if (hasSection) {
        shouldAdd = true;
        this.logger.info(`${projPath} declares [tool.release-please.extra-versions] (or variant) — will treat as central config`);
      } else {
        try {
          const parsed = parsePyProject(content) as PyProject & any;
          const projectName = (parsed.project && parsed.project.name) || (parsed.tool && parsed.tool.poetry && parsed.tool.poetry.name);
          if (projectName) {
            const normProjName = normalizePkgName(String(projectName));
            if (normalizedTargets.has(normProjName)) {
              shouldAdd = true;
              matchedKeys.push(this.normalizedToCanonical.get(normProjName) || String(projectName));
              this.logger.info(`${projPath} project.name matches target ${projectName}`);
            }
          }

          if (!shouldAdd && parsed.tool && parsed.tool.poetry && parsed.tool.poetry.dependencies) {
            for (const depName of Object.keys(parsed.tool.poetry.dependencies)) {
              const normDep = normalizePkgName(String(depName));
              if (normalizedTargets.has(normDep)) {
                shouldAdd = true;
                matchedKeys.push(this.normalizedToCanonical.get(normDep) || String(depName));
                this.logger.info(`${projPath} tool.poetry.dependencies contains ${depName}`);
                break;
              }
            }
          }

          if (!shouldAdd && parsed.project && Array.isArray(parsed.project.dependencies)) {
            for (const raw of parsed.project.dependencies) {
              const depRaw = String(raw);
              const depName = depRaw.split(/\s|>=|==|<=|<|>|\[/)[0];
              const normDep = normalizePkgName(depName);
              if (normalizedTargets.has(normDep)) {
                shouldAdd = true;
                matchedKeys.push(this.normalizedToCanonical.get(normDep) || depName);
                this.logger.info(`${projPath} project.dependencies contains ${depName}`);
                break;
              }
            }
          }
        } catch (e) {
          this.logger.debug(`parsePyProject failed for ${projPath}: ${(e as Error).message}`);
          const lowerContent = content.toLowerCase();
          for (const canonical of keysToWrite) {
            const normCanonical = normalizePkgName(canonical);
            const esc = normCanonical.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
            const re = new RegExp('^\\s*' + esc + '\\s*=\\s*["\\\']?[0-9A-Za-z_.+\\-]+["\\\']?(\\s*#.*)?', 'm');
            if (re.test(lowerContent)) {
              shouldAdd = true;
              matchedKeys.push(canonical);
            }
          }
        }
      }

      if (!shouldAdd) {
        this.logger.info(`Skipping ${projPath} — matchedKeys: ${matchedKeys.join(', ') || 'none'}; hasSection: ${hasSection}`);
        continue;
      }

      this.logger.info(`Will update ${projPath} (matchedKeys: ${matchedKeys.length > 0 ? matchedKeys.join(', ') : 'section-only'})`);
      const existing = primary.pullRequest.updates.find(u => u.path === projPath);
      const extraUpd = wrapUpdater(new PyProjectExtraVersionsUpdater({extraVersions: extraToWrite}));
      if (existing) {
        existing.updater = new CompositeUpdater(wrapUpdater(existing.updater) as any, extraUpd as any) as any;
        this.logger.info(`Composed extra-versions updater into existing updater for ${projPath}`);
      } else {
        primary.pullRequest.updates.push({
          path: projPath,
          createIfMissing: false,
          updater: new CompositeUpdater(extraUpd as any, extraUpd as any) as any,
        } as any);
        this.logger.info(`Added pyproject extra-versions updater for ${projPath}`);
      }
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
          // ignore parse errors
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

function normalizePkgName(name: string): string {
  if (!name) return name;
  const beforeMarker = name.split(';')[0];
  const beforeExtras = beforeMarker.split('[')[0];
  return beforeExtras.trim().toLowerCase().replace(/_+/g, '-');
}
