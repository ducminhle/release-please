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
import {replaceTomlValue} from '../util/toml-edit';
import {PythonFileWithVersion} from '../updaters/python/python-file-with-version';
import {CompositeUpdater} from '../updaters/composite';
import {PatchVersionUpdate} from '../versioning-strategy';

interface Package {
  path: string;
  name: string;
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
      ['extra-versions']?: Record<string, string>;
    };
    ['release-please']?: {
      extraVersions?: Record<string, string>;
      ['extra-versions']?: Record<string, string>;
    };
  };
}

function wrapUpdater(u: any): {updateContent(old?: string): string} {
  if (!u) return {updateContent: (old?: string) => old || ''};
  if (typeof u.updateContent === 'function') return u;
  if (typeof u.update === 'function') return {updateContent: (old?: string) => u.update(old)};
  if (typeof u.apply === 'function') return {updateContent: (old?: string) => u.apply(old)};
  if (typeof u.transform === 'function') return {updateContent: (old?: string) => u.transform(old)};
  return {updateContent: (old?: string) => (typeof u === 'string' ? u : (u && typeof u.toString === 'function' ? u.toString() : old || ''))};
}

class PyProjectExtraVersionsUpdater {
  private extraVersions: Record<string, string>;
  constructor(options: {extraVersions: Record<string, string>}) {
    this.extraVersions = options?.extraVersions || {};
  }

  updateContent(oldContent?: string): string {
    const content = oldContent || '';
    const headerRe = /^\s*\[tool\.release-please\.extra-versions\]\s*$/m;
    const hasSection = headerRe.test(content);
    
    if (!hasSection) {
      return this.appendNewSection(content);
    }

    // Find the section and merge entries
    const start = content.search(headerRe);
    if (start === -1) return this.appendNewSection(content);

    // Find the end of this section (next [section] or EOF)
    const after = content.slice(start);
    const nextTableRe = /^\s*\[.+\]/m;
    const nextMatch = nextTableRe.exec(after.slice(after.indexOf('\n') + 1 || 0));
    let endIndex: number;
    
    if (nextMatch) {
      // Find the actual position in the original string
      const lineAfterHeader = after.indexOf('\n') + 1;
      endIndex = start + lineAfterHeader + nextMatch.index;
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
      const val = valRaw.replace(/^['"]|['"]$/g, '').split('#')[0].trim();
      if (key) existing[key] = val;
    }

    // Merge with new versions
    const merged: Record<string, string> = {...existing};
    for (const k of Object.keys(this.extraVersions)) {
      merged[k] = this.extraVersions[k];
    }

    // Reconstruct the section
    const headerLine = '[tool.release-please.extra-versions]';
    const entryLines = Object.keys(merged).sort().map(k => `${k} = "${merged[k]}" # x-release-please-version`);
    const newSection = headerLine + '\n' + entryLines.join('\n') + '\n';
    
    return before + newSection + afterSection;
  }

  private appendNewSection(content: string): string {
    const entryLines = Object.keys(this.extraVersions).sort().map(k => `${k} = "${this.extraVersions[k]}" # x-release-please-version`);
    const newSection = '\n[tool.release-please.extra-versions]\n' + entryLines.join('\n') + '\n';
    return content + newSection;
  }
}

// Combined updater that handles both version bump and extra-versions in a single pass
class PyProjectCombinedUpdater {
  constructor(private version: Version, private extraVersions?: Record<string, string>) {}

  updateContent(content: string): string {
    // First, update the version using the standard mechanism
    const parsed = parsePyProject(content);
    const project = parsed.project || parsed.tool?.poetry;

    if (!project?.version) {
      if (project?.dynamic && project.dynamic.includes('version')) {
        return content;
      }
      throw new Error('invalid file');
    }

    // Use TOML to rebuild with proper formatting
    let result = content;
    const pathToVersion = parsed.project ? ['project', 'version'] : ['tool', 'poetry', 'version'];
    result = replaceTomlValue(result, pathToVersion, this.version.toString());

    // Then, update extra-versions if provided
    if (this.extraVersions && Object.keys(this.extraVersions).length > 0) {
      const extraUpd = new PyProjectExtraVersionsUpdater({extraVersions: this.extraVersions});
      result = extraUpd.updateContent(result);
    }

    return result;
  }
}

export { PyProjectCombinedUpdater };

export class PythonWorkspace extends WorkspacePlugin<Package> {
  private normalizedToCanonical: Map<string, string> = new Map();
  private extraVersions: Map<string, string> = new Map();
  private extraVersionsDefinedIn: Map<string, string> = new Map();
  private allPackagesCache: Map<string, Package> = new Map();

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

    // FIRST: Scan ALL pyproject.toml files in repo to find where extra-versions are defined
    this.logger.info('Scanning for extra-versions definitions...');
    try {
      const allPyproj = await this.github.findFilesByFilenameAndRef('pyproject.toml', this.targetBranch) || [];
      this.logger.info(`Found ${Array.isArray(allPyproj) ? allPyproj.length : 0} pyproject.toml files`);
      for (const p of allPyproj) {
        const pPath = typeof p === 'string' ? p : (p as any).path;
        if (!pPath) continue;
        try {
          const f = await this.github.getFileContentsOnBranch(pPath, this.targetBranch);
          const raw = this.extractFileContentString(f);
          if (!raw) {
            this.logger.info(`No content for ${pPath}`);
            continue;
          }

          // parse and support both camelCase and kebab-case keys
          try {
            const parsed = parsePyProject(raw) as EnhancedPyProject;
            const toolKeys = parsed.tool ? Object.keys(parsed.tool) : [];
            this.logger.info(`Parsed structure for ${pPath}: ${JSON.stringify({hasProject: !!parsed.project, hasTool: !!parsed.tool, toolKeys})}`);

            // prefer camelCase then kebab-case for release-please section
            const rpCandidate =
              (parsed.tool && (parsed.tool as any).releasePlease) ||
              (parsed.tool && (parsed.tool as any)['release-please']) ||
              null;

            if (rpCandidate) {
              // prefer camelCase then kebab-case for extra-versions
              const ev = rpCandidate.extraVersions || rpCandidate['extra-versions'] || null;
              if (ev && typeof ev === 'object' && Object.keys(ev).length > 0) {
                this.logger.info(`Found extra-versions section in ${pPath}`);
                for (const [pkgName, pkgVer] of Object.entries(ev)) {
                  const normalized = normalizePkgName(pkgName);
                  this.extraVersions.set(normalized, String(pkgVer));
                  this.extraVersionsDefinedIn.set(normalized, pPath);
                  this.logger.info(`  ${pkgName} (normalized: ${normalized}) -> ${pPath}`);
                }
                continue;
              } else {
                this.logger.info(`release-please present but no extra-versions in ${pPath}`);
              }
            } else {
              this.logger.info(`No release-please tool entry in ${pPath}`);
            }
          } catch (parseErr) {
            this.logger.info(`Parser error for ${pPath}: ${(parseErr as Error).message}`);
          }

          // fallback: text-scan for [tool.release-please.extra-versions]
          const found = this.extractExtraVersionsFromContent(raw);
          if (found && Object.keys(found).length > 0) {
            this.logger.info(`Found extra-versions in ${pPath} via text-scan`);
            for (const [pkgName, pkgVer] of Object.entries(found)) {
              const normalized = normalizePkgName(pkgName);
              this.extraVersions.set(normalized, String(pkgVer));
              this.extraVersionsDefinedIn.set(normalized, pPath);
              this.logger.info(`  ${pkgName} (normalized: ${normalized}) -> ${pPath}`);
            }
          } else {
            this.logger.info(`No extra-versions found in ${pPath} by text-scan`);
          }
        } catch (err) {
          this.logger.info(`Failed to read ${pPath}: ${(err as Error).message}`);
        }
      }
    } catch (e) {
      this.logger.warn('scan pyproject.toml failed', (e as Error).message);
    }

    this.logger.info(`Scan complete. Found ${this.extraVersionsDefinedIn.size} packages with extra-versions`);
    for (const [pkg, path] of this.extraVersionsDefinedIn.entries()) {
      this.logger.info(`  ${pkg} -> ${path}`);
    }

    // SECOND: Build packages from configured paths
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
          pyprojectContent = this.extractFileContentString(f);
        }
      } catch {
        /* ignore missing per-package pyproject */
      }
      try {
        if (!setupCfgContent) {
          const f = await this.github.getFileContentsOnBranch(addPath(path, 'setup.cfg'), this.targetBranch);
          setupCfgContent = this.extractFileContentString(f);
        }
      } catch {
        /* ignore */
      }
      try {
        if (!setupPyContent) {
          const f = await this.github.getFileContentsOnBranch(addPath(path, 'setup.py'), this.targetBranch);
          setupPyContent = this.extractFileContentString(f);
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
        } catch {
          this.logger.info(`Failed to parse pyproject.toml for ${path}`);
        }
      }

      if ((!name || name === path) && setupPyContent) {
        const m = setupPyContent.match(/name\s*=\s*['"]([^'"]+)['"]/m);
        if (m && m[1]) name = m[1];
      }

      const VERSION_PATTERN = /\bversion\s*=\s*(['"])([^'"]+)\1/i;
      if (setupCfgContent && version === null) {
        const m = setupCfgContent.match(VERSION_PATTERN);
        if (m) version = m[2];
      }
      if (setupPyContent && version === null) {
        const m = setupPyContent.match(VERSION_PATTERN);
        if (m) version = m[2];
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
        this.logger.info(`associated candidate for ${pkg.name}`);
      }
    }

    // normalized -> canonical map
    this.normalizedToCanonical = new Map();
    for (const p of packages) this.normalizedToCanonical.set(normalizePkgName(p.name), p.name);

    // Cache packages for use in postProcessCandidates
    this.allPackagesCache.clear();
    for (const p of packages) {
      this.allPackagesCache.set(normalizePkgName(p.name), p);
    }

    this.logger.info(`Found ${packages.length} packages`);
    this.logger.info(`Extra versions tracking: ${this.extraVersionsDefinedIn.size} packages`);
    for (const [normalized, path] of this.extraVersionsDefinedIn.entries()) {
      const canonical = this.normalizedToCanonical.get(normalized) || normalized;
      this.logger.info(`  ${canonical} (${normalized}) defined in ${path}`);
    }

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
    let newVersion = normalizedUpdated.get(normName);
    if (!newVersion) throw new Error(`Didn't find updated version for ${pkg.name}`);

    // Check if this package has dependencies defined in extra-versions that are being updated
    // If so, we need to bump the package version as well
    const hasDependencyUpdates = Array.from(this.extraVersionsDefinedIn.entries()).some(([depNorm, defPath]) => {
      return defPath === addPath(existingCandidate.path, 'pyproject.toml') && 
             normalizedUpdated.has(depNorm) &&
             depNorm !== normName; // Don't count self-updates
    });

    if (hasDependencyUpdates && newVersion) {
      this.logger.info(`Package ${pkg.name} has dependency updates, bumping version`);
      newVersion = new PatchVersionUpdate().bump(newVersion);
      this.logger.info(`Bumped ${pkg.name} version to ${newVersion}`);
    }

    if (!newVersion) throw new Error(`Version resolution failed for ${pkg.name}`);

    existingCandidate.pullRequest.updates = existingCandidate.pullRequest.updates.map(update => {
      if (update.path === addPath(existingCandidate.path, 'setup.cfg')) {
        update.updater = new CompositeUpdater(wrapUpdater(update.updater) as any, wrapUpdater(new SetupCfg({version: newVersion!})) as any) as any;
      } else if (update.path === addPath(existingCandidate.path, 'setup.py')) {
        update.updater = new CompositeUpdater(wrapUpdater(update.updater) as any, wrapUpdater(new SetupPy({version: newVersion!})) as any) as any;
      } else if (update.path === addPath(existingCandidate.path, 'pyproject.toml')) {
        // Use combined updater to handle both version and extra-versions in one pass
        const extraVersions: Record<string, string> = {};
        for (const [depNorm, defPath] of this.extraVersionsDefinedIn.entries()) {
          if (defPath === update.path && normalizedUpdated.has(depNorm)) {
            const canonical = this.normalizedToCanonical.get(depNorm) || depNorm;
            const ver = normalizedUpdated.get(depNorm);
            if (ver) extraVersions[canonical] = ver.toString();
          }
        }
        update.updater = new PyProjectCombinedUpdater(newVersion!, Object.keys(extraVersions).length > 0 ? extraVersions : undefined) as any;
      }
      return update;
    });

    const versionFiles = existingCandidate.pullRequest.updates.filter(u => u.path.endsWith('version.py') || u.path.endsWith('__init__.py')).map(u => u.path);
    for (const f of versionFiles) {
      const update = existingCandidate.pullRequest.updates.find(u => u.path === f)!;
      update.updater = new CompositeUpdater(wrapUpdater(update.updater) as any, wrapUpdater(new PythonFileWithVersion({version: newVersion!})) as any) as any;
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
        existingCandidate.pullRequest.body.releaseData[0].notes = appendDependenciesSectionToChangelog(existingCandidate.pullRequest.body.releaseData[0].notes, dependencyNotes, this.logger);
        existingCandidate.pullRequest.body.releaseData[0].version = newVersion;
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
    if (pkg.setupCfg !== null) updates.push({path: addPath(pkg.path, 'setup.cfg'), createIfMissing: false, updater: new SetupCfg({version: newVersion})});
    if (pkg.setupPy !== null) updates.push({path: addPath(pkg.path, 'setup.py'), createIfMissing: false, updater: new SetupPy({version: newVersion})});
    if (pkg.pyproject !== null) updates.push({path: addPath(pkg.path, 'pyproject.toml'), createIfMissing: false, updater: new PyProjectToml({version: newVersion})});

    const versionPyFiles = await this.github.findFilesByFilenameAndRef('version.py', this.targetBranch, pkg.path);
    for (const vf of versionPyFiles) updates.push({path: addPath(pkg.path, vf), createIfMissing: false, updater: new PythonFileWithVersion({version: newVersion})});

    try {
      await this.github.getFileContentsOnBranch(addPath(pkg.path, 'CHANGELOG.md'), this.targetBranch);
      updates.push({path: addPath(pkg.path, 'CHANGELOG.md'), createIfMissing: false, updater: new Changelog({version: newVersion, changelogEntry: dependencyNotes})});
    } catch {
      /* no changelog; skip */
    }

    const canonical = this.normalizedToCanonical.get(normName) || pkg.name;
    const pullRequest: ReleasePullRequest = {
      title: PullRequestTitle.ofTargetBranch(this.targetBranch),
      body: new PullRequestBody([{component: canonical, version: newVersion, notes: appendDependenciesSectionToChangelog('', dependencyNotes, this.logger)}]),
      updates,
      labels: [],
      headRefName: BranchName.ofTargetBranch(this.targetBranch).toString(),
      version: newVersion,
      draft: false,
    };

    return {path: pkg.path, pullRequest, config: {releaseType: 'python'}};
  }

  protected postProcessCandidates(candidates: CandidateReleasePullRequest[], updatedVersions: VersionsMap): CandidateReleasePullRequest[] {
    if (candidates.length === 0) return candidates;

    this.logger.info(`postProcessCandidates: processing ${candidates.length} candidates`);
    this.logger.info(`updatedVersions has ${updatedVersions.size} entries`);

    const extraVersionUpdatesByFile = new Map<string, Record<string, string>>();

    for (const [pkgKey, version] of updatedVersions.entries()) {
      const pkgName = String(pkgKey);
      const normalized = normalizePkgName(pkgName);
      this.logger.info(`Checking package: ${pkgName} (normalized: ${normalized}), version: ${String(version)}`);
      const definedIn = this.extraVersionsDefinedIn.get(normalized);
      if (definedIn) {
        this.logger.info(`Package ${pkgName} extra-version should be updated in ${definedIn}`);
        if (!extraVersionUpdatesByFile.has(definedIn)) extraVersionUpdatesByFile.set(definedIn, {});
        const canonical = this.normalizedToCanonical.get(normalized) || pkgName;
        extraVersionUpdatesByFile.get(definedIn)![canonical] = String(version);
      } else {
        this.logger.info(`Package ${pkgName} is not defined in any extra-versions section`);
      }
    }

    this.logger.info(`Found ${extraVersionUpdatesByFile.size} files that need extra-version updates`);

    // Track which files have parents that need version bumping
    const parentsToVersionBump = new Map<string, Version>();
    
    for (const [pyprojectPath, extraVersions] of extraVersionUpdatesByFile.entries()) {
      this.logger.info(`Will update extra-versions in ${pyprojectPath}: ${JSON.stringify(extraVersions)}`);
      let targetCandidate: CandidateReleasePullRequest | undefined;
      for (const candidate of candidates) {
        const candidatePyprojectPath = addPath(candidate.path, 'pyproject.toml');
        if (pyprojectPath === candidatePyprojectPath) { targetCandidate = candidate; break; }
      }
      if (!targetCandidate) {
        const pyprojectDir = pyprojectPath.replace(/\/pyproject\.toml$/, '');
        for (const candidate of candidates) {
          if (candidate.path.startsWith(pyprojectDir + '/') || candidate.path === pyprojectDir) { targetCandidate = candidate; break; }
        }
      }
      
      // If we still don't have a candidate, this is a parent package not in candidates - need to bump its version
      if (!targetCandidate) {
        const parentDir = pyprojectPath.replace(/\/pyproject\.toml$/, '');
        this.logger.info(`Parent package at ${parentDir} has no candidate but needs version bump for dependencies`);
        
        // Try to get the parent package from cached packages
        try {
          const parentName = parentDir.split('/').pop() || 'root';
          const parentNormalized = normalizePkgName(parentName);
          
          // Look for the package in our cache by checking which one has the matching path
          let parentPkg: Package | undefined;
          for (const pkg of this.allPackagesCache.values()) {
            if (pkg.path === parentDir || addPath(pkg.path, 'pyproject.toml') === pyprojectPath) {
              parentPkg = pkg;
              break;
            }
          }
          
          if (parentPkg?.version) {
            const currentVersion = Version.parse(parentPkg.version);
            const newVersion = new PatchVersionUpdate().bump(currentVersion);
            parentsToVersionBump.set(pyprojectPath, newVersion);
            this.logger.info(`Will bump ${parentDir} from ${currentVersion} to ${newVersion}`);
          } else {
            this.logger.warn(`Could not find version for parent package at ${parentDir}`);
          }
        } catch (e) {
          this.logger.warn(`Failed to parse parent version: ${(e as Error).message}`);
        }
      }
      
      if (!targetCandidate) targetCandidate = candidates[0];

      const existing = targetCandidate.pullRequest.updates.find(u => u.path === pyprojectPath);
      // Skip if already using combined updater (which handles extra-versions)
      if (existing && existing.updater instanceof PyProjectCombinedUpdater) {
        this.logger.info(`Skipping extra-versions update for ${pyprojectPath} - already handled by combined updater`);
        continue;
      }
      
      // If parent needs version bump, use combined updater
      if (parentsToVersionBump.has(pyprojectPath)) {
        const newVersion = parentsToVersionBump.get(pyprojectPath)!;
        const combinedUpd = new PyProjectCombinedUpdater(newVersion, extraVersions);
        if (existing) existing.updater = combinedUpd as any;
        else targetCandidate.pullRequest.updates.push({path: pyprojectPath, createIfMissing: false, updater: combinedUpd as any});
        
        // Update the release data for the parent package
        const parentName = pyprojectPath.replace(/\/pyproject\.toml$/, '').split('/').pop() || 'root';
        const existingReleaseData = targetCandidate.pullRequest.body.releaseData.find(rd => rd.component === parentName);
        if (existingReleaseData) {
          existingReleaseData.version = newVersion;
        } else {
          targetCandidate.pullRequest.body.releaseData.push({
            component: parentName,
            version: newVersion,
            notes: '',
          });
        }
      } else {
        const extraUpd = new PyProjectExtraVersionsUpdater({extraVersions});
        if (existing) existing.updater = new CompositeUpdater(existing.updater, extraUpd as any);
        else targetCandidate.pullRequest.updates.push({path: pyprojectPath, createIfMissing: false, updater: extraUpd as any});
      }
    }

    if (candidates.length <= 1) return candidates;

    const primary = candidates[0];
    for (let i = 1; i < candidates.length; i++) {
      const c = candidates[i];
      for (const l of c.pullRequest.labels) if (!primary.pullRequest.labels.includes(l)) primary.pullRequest.labels.push(l);
      for (const u of c.pullRequest.updates) {
        const existing = primary.pullRequest.updates.find(x => x.path === u.path);
        if (!existing) primary.pullRequest.updates.push(u);
        else if (existing.updater instanceof Changelog && u.updater instanceof Changelog) {
          existing.updater.changelogEntry = appendDependenciesSectionToChangelog(existing.updater.changelogEntry, u.updater.changelogEntry, this.logger);
        }
      }
      if (c.pullRequest.draft && !primary.pullRequest.draft) primary.pullRequest = {...primary.pullRequest, draft: true};
      for (const rd of c.pullRequest.body.releaseData) {
        const exists = primary.pullRequest.body.releaseData.some(p => p.component === rd.component && String(p.version) === String(rd.version));
        if (!exists) primary.pullRequest.body.releaseData.push(rd);
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
    this.logger.info(`building graph order, packageNamesToUpdate: ${packageNamesToUpdate}`);
    const visited: Set<Package> = new Set();
    const normalizedNames = packageNamesToUpdate.map(n => normalizePkgName(n));
    for (const name of normalizedNames) this.visitForward(graph, name, visited, []);
    return Array.from(visited).sort((a, b) => this.packageNameFromPackage(a).localeCompare(this.packageNameFromPackage(b)));
  }

  private visitForward(graph: DependencyGraph<Package>, name: string, visited: Set<Package>, path: string[]) {
    this.logger.info(`visiting ${name}, path: ${path.join(' -> ')}`);
    if (path.indexOf(name) !== -1) throw new Error(`found cycle in dependency graph: ${[...path, name].join(' -> ')}`);
    const node = graph.get(name);
    if (!node) { this.logger.warn(`Didn't find node: ${name} in graph`); return; }
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
            } else if (inInstallRequires && (t === '' || /^\S/.test(t))) inInstallRequires = false;
            else if (inInstallRequires && t) {
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
      this.logger.info('getChangelogDepsNotes parse error', (e as Error).message);
    }
    if (depUpdates.length === 0) return '';
    return `* The following workspace dependencies were updated:\n${depUpdates.join('\n')}`;
  }

  private extractFileContentString(f: any): string | null {
    if (!f) return null;
    if (typeof f === 'string') return f;
    if (f.parsedContent && typeof f.parsedContent === 'string') return f.parsedContent;
    if (f.content && typeof f.content === 'string') return f.content;
    if (f.raw && typeof f.raw === 'string') return f.raw;
    if (f.contentBase64 && typeof f.contentBase64 === 'string') {
      try {
        return Buffer.from(f.contentBase64, 'base64').toString('utf8');
      } catch {
        return null;
      }
    }
    if (f.decodedContent && typeof f.decodedContent === 'string') return f.decodedContent;
    return null;
  }

  private extractExtraVersionsFromContent(content: string): Record<string, string> {
    const out: Record<string, string> = {};
    const headerRe = /^\s*\[tool\.release-please\.extra-versions\]\s*$/m;
    const start = content.search(headerRe);
    if (start === -1) return out;
    const after = content.slice(start);
    const nextTableRe = /^\s*\[.+\]/m;
    const m = nextTableRe.exec(after.slice(1));
    let endIndex: number;
    if (m && m.index >= 0) endIndex = start + 1 + m.index;
    else endIndex = content.length;
    const section = content.slice(start, endIndex);
    const lines = section.split(/\r?\n/);
    for (const line of lines) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith('#') || trimmed.startsWith('[')) continue;
      const eq = line.indexOf('=');
      if (eq === -1) continue;
      const key = line.slice(0, eq).trim();
      const valRaw = line.slice(eq + 1).trim();
      const val = valRaw.replace(/^['"]|['"]$/g, '').split('#')[0].trim();
      if (key) out[key] = val;
    }
    return out;
  }
}

function normalizePkgName(name: string): string {
  if (!name) return name;
  const beforeMarker = name.split(';')[0];
  const beforeExtras = beforeMarker.split('[')[0];
  return beforeExtras.trim().toLowerCase().replace(/_+/g, '-');
}
